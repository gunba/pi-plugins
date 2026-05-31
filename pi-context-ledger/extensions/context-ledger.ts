import { basename } from "node:path";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
// pi-tui is always present in a Pi runtime (it backs the TUI). Using its
// width helpers keeps the card aligned even when skill names, file paths, or the
// user's message contain wide (CJK/emoji) characters.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "pi-context-ledger";
const DISABLE_ENV = "PI_CONTEXT_LEDGER";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

// Pi estimates context with a chars/4 heuristic (see estimateTokens). We mirror
// it exactly so this ledger agrees with Pi's own accounting, and so image cost
// matches estimateTextAndImageContentChars.
const ESTIMATED_IMAGE_CHARS = 4800;
const MAX_CARD_WIDTH = 88;
const MIN_CARD_WIDTH = 46;

// --- token + width helpers ---------------------------------------------------

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}

// Truncate (if needed) and pad to exactly `width` columns, ANSI- and wide-char-aware.
function padTo(value: string, width: number): string {
  return truncateToWidth(value, width, "", true);
}

function padStart(value: string, width: number): string {
  const pad = width - visibleWidth(value);
  return pad > 0 ? " ".repeat(pad) + value : value;
}

function truncatePlain(value: string, width: number): string {
  return truncateToWidth(value, width, "…");
}

function formatTokens(count: number): string {
  const n = Math.round(count);
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- ledger model ------------------------------------------------------------

type LedgerSegment = {
  label: string;
  tokens: number;
  note: string;
};

type Ledger = {
  total: number;
  contextWindow: number;
  windowPercent: number | null;
  segments: LedgerSegment[];
};

function isBuiltinTool(tool: ToolInfo): boolean {
  const source = tool.sourceInfo?.source;
  return source === "builtin" || source === "sdk";
}

function isMcpTool(tool: ToolInfo): boolean {
  if (tool.name === "mcp" || tool.name.startsWith("mcp_")) return true;
  const haystack = `${tool.sourceInfo?.path ?? ""} ${tool.sourceInfo?.source ?? ""}`.toLowerCase();
  return /mcp/.test(haystack);
}

function toolSchemaTokens(tool: ToolInfo): number {
  return tokens(safeJson({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function joinNames(names: string[], max: number): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

/**
 * Build the pre-conversation context breakdown.
 *
 * The three top-level buckets — system prompt, tool schemas, first message —
 * are measured independently and sum to the grand total. The system prompt is
 * a single assembled string, so its sub-parts (skills, project context,
 * appended prompt) are estimated from their source text and reconciled against
 * the measured whole: "core prompt" absorbs the remainder, and if the estimates
 * exceed the measured prompt they are scaled to fit. This keeps every row
 * additive against a total that matches Pi's own context accounting.
 */
function computeLedger(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  systemPrompt: string,
  options: BuildSystemPromptOptions | undefined,
  prompt: string,
  imageCount: number,
): Ledger {
  const systemTotal = tokens(systemPrompt);

  const skills = options?.skills ?? [];
  const skillsEst = skills.reduce(
    (sum, skill) => sum + tokens(`${skill.name}: ${skill.description} (${skill.filePath})`) + 6,
    0,
  );

  const contextFiles = options?.contextFiles ?? [];
  const contextEst = contextFiles.reduce((sum, file) => sum + tokens(file.content) + tokens(file.path) + 8, 0);

  const appendEst = tokens(options?.appendSystemPrompt ?? "");

  const partsEst = skillsEst + contextEst + appendEst;
  let skillsTok = skillsEst;
  let contextTok = contextEst;
  let appendTok = appendEst;
  let coreTok: number;
  if (partsEst <= systemTotal) {
    coreTok = systemTotal - partsEst;
  } else {
    // Estimates overshot the measured prompt (rare; other extensions may have
    // reshaped sections). Scale the parts down so the rows still sum to the
    // measured system prompt instead of inventing tokens.
    const scale = partsEst > 0 ? systemTotal / partsEst : 0;
    skillsTok = Math.round(skillsEst * scale);
    contextTok = Math.round(contextEst * scale);
    appendTok = Math.round(appendEst * scale);
    coreTok = Math.max(0, systemTotal - skillsTok - contextTok - appendTok);
  }

  const active = new Set(pi.getActiveTools());
  let builtinTok = 0;
  let mcpTok = 0;
  let extTok = 0;
  let builtinN = 0;
  let mcpN = 0;
  let extN = 0;
  const mcpNames: string[] = [];
  const extNames: string[] = [];
  for (const tool of pi.getAllTools()) {
    if (!active.has(tool.name)) continue;
    const schemaTokens = toolSchemaTokens(tool);
    if (isBuiltinTool(tool)) {
      builtinTok += schemaTokens;
      builtinN++;
    } else if (isMcpTool(tool)) {
      mcpTok += schemaTokens;
      mcpN++;
      mcpNames.push(tool.name);
    } else {
      extTok += schemaTokens;
      extN++;
      extNames.push(tool.name);
    }
  }

  const messageTok = tokens(prompt) + imageCount * Math.ceil(ESTIMATED_IMAGE_CHARS / 4);

  const contextFileNote = joinNames(
    contextFiles.map((file) => basename(file.path)),
    2,
  );

  const candidates: LedgerSegment[] = [
    { label: "Core prompt", tokens: coreTok, note: "base + guidelines" },
    { label: "Skills", tokens: skillsTok, note: skills.length ? plural(skills.length, "skill") : "" },
    { label: "Project context", tokens: contextTok, note: contextFileNote || plural(contextFiles.length, "file") },
    { label: "Appended prompt", tokens: appendTok, note: "" },
    { label: "MCP tools", tokens: mcpTok, note: mcpN ? `${plural(mcpN, "tool")} · ${joinNames(mcpNames, 2)}` : "" },
    { label: "Built-in tools", tokens: builtinTok, note: builtinN ? plural(builtinN, "tool") : "" },
    { label: "Extension tools", tokens: extTok, note: extN ? `${plural(extN, "tool")} · ${joinNames(extNames, 2)}` : "" },
    {
      label: "Your message",
      tokens: messageTok,
      note: imageCount ? plural(imageCount, "image") : "",
    },
  ];

  const segments = candidates
    .filter((segment) => segment.tokens > 0 || segment.label === "Your message")
    .sort((a, b) => b.tokens - a.tokens);

  const total = systemTotal + builtinTok + mcpTok + extTok + messageTok;
  const usage = ctx.getContextUsage?.();
  const contextWindow = usage?.contextWindow || ctx.model?.contextWindow || 0;
  const windowPercent = contextWindow > 0 ? (total / contextWindow) * 100 : null;

  return { total, contextWindow, windowPercent, segments };
}

// --- rendering ---------------------------------------------------------------

function heatColor(share: number, isMax: boolean): ThemeColor {
  if (isMax && share >= 0.25) return "warning";
  return "accent";
}

function windowColor(percent: number | null): ThemeColor {
  if (percent === null) return "muted";
  if (percent >= 40) return "error";
  if (percent >= 20) return "warning";
  return "success";
}

function renderBar(filledCount: number, width: number, color: ThemeColor, theme: Theme): string {
  const filled = Math.max(0, Math.min(width, filledCount));
  const empty = width - filled;
  return theme.fg(color, "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(empty));
}

function renderLedgerCard(ledger: Ledger, theme: Theme, viewportWidth: number): string[] {
  const outerWidth = Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, viewportWidth - 2));
  const innerWidth = outerWidth - 4; // "│ " + content + " │"

  const maxTokens = ledger.segments.reduce((max, segment) => Math.max(max, segment.tokens), 0) || 1;
  const labelWidth = Math.min(
    16,
    ledger.segments.reduce((max, segment) => Math.max(max, visibleWidth(segment.label)), 0),
  );
  const tokensWidth = ledger.segments.reduce((max, segment) => Math.max(max, formatTokens(segment.tokens).length), 4);
  const pctWidth = 4;
  const gaps = 2 + 2 + 2 + 2; // label·bar·tokens·pct·note separators
  const barWidth = Math.max(8, Math.min(26, Math.round(innerWidth * 0.3)));
  const noteWidth = innerWidth - labelWidth - barWidth - tokensWidth - pctWidth - gaps;

  const top = theme.fg("borderAccent", `╭${"─".repeat(outerWidth - 2)}╮`);
  const bottom = theme.fg("borderAccent", `╰${"─".repeat(outerWidth - 2)}╯`);
  const frame = (content: string): string =>
    `${theme.fg("borderAccent", "│")} ${padTo(content, innerWidth)} ${theme.fg("borderAccent", "│")}`;

  const totalText = `~${formatTokens(ledger.total)} tokens`;
  const windowText =
    ledger.windowPercent === null
      ? "context window unknown"
      : `${ledger.windowPercent.toFixed(0)}% of ${formatTokens(ledger.contextWindow)} window`;
  const title = `${theme.fg("accent", "▌")} ${theme.bold(theme.fg("accent", "Initial context"))}`;
  const summary = `${theme.fg("muted", totalText)} ${theme.fg("dim", "·")} ${theme.fg(windowColor(ledger.windowPercent), windowText)}`;
  const summaryGap = innerWidth - visibleWidth(title) - visibleWidth(summary);
  const header = summaryGap >= 1 ? `${title}${" ".repeat(summaryGap)}${summary}` : title;

  const lines: string[] = [top, frame(header), frame(theme.fg("borderMuted", "─".repeat(innerWidth)))];

  for (const segment of ledger.segments) {
    const share = ledger.total > 0 ? segment.tokens / ledger.total : 0;
    const isMax = segment.tokens === maxTokens;
    const color = heatColor(share, isMax);
    const filled = Math.round(barWidth * (segment.tokens / maxTokens));
    const bar = renderBar(filled, barWidth, color, theme);

    const label = theme.fg("text", padTo(truncatePlain(segment.label, labelWidth), labelWidth));
    const tokensCell = theme.fg(
      isMax && share >= 0.25 ? "warning" : "muted",
      padStart(formatTokens(segment.tokens), tokensWidth),
    );
    const pct = `${Math.round(share * 100)}%`;
    const pctCell = theme.fg("dim", padStart(pct, pctWidth));
    const note = noteWidth >= 4 && segment.note ? `  ${theme.fg("dim", truncatePlain(segment.note, noteWidth))}` : "";

    lines.push(frame(`${label}  ${bar}  ${tokensCell}  ${pctCell}${note}`));
  }

  lines.push(frame(theme.fg("dim", truncatePlain("pre-conversation context · /context-ledger to recompute", innerWidth))));
  lines.push(bottom);
  return lines;
}

function renderLedgerPlain(ledger: Ledger): string {
  const windowText =
    ledger.windowPercent === null
      ? "context window unknown"
      : `${ledger.windowPercent.toFixed(0)}% of ${formatTokens(ledger.contextWindow)} window`;
  const lines = [`Initial context: ~${formatTokens(ledger.total)} tokens (${windowText})`];
  for (const segment of ledger.segments) {
    const share = ledger.total > 0 ? Math.round((segment.tokens / ledger.total) * 100) : 0;
    const note = segment.note ? ` — ${segment.note}` : "";
    lines.push(`  ${segment.label}: ${formatTokens(segment.tokens)} (${share}%)${note}`);
  }
  return lines.join("\n");
}

// --- runtime wiring ----------------------------------------------------------

function isDisabled(value: string | undefined): boolean {
  return /^(0|false|off|no|disabled)$/i.test((value ?? "").trim());
}

function isSubagentChild(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

type LedgerComponent = Component & { dispose?: () => void };

function createLedgerComponent(ledger: Ledger, theme: Theme): LedgerComponent {
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  return {
    render(width: number): string[] {
      if (width !== cachedWidth) {
        cachedWidth = width;
        cachedLines = renderLedgerCard(ledger, theme, width);
      }
      return cachedLines;
    },
    invalidate() {
      cachedWidth = -1;
      cachedLines = [];
    },
  };
}

export default function contextLedger(pi: ExtensionAPI): void {
  if (isSubagentChild()) return;

  let autoEnabled = !isDisabled(process.env[DISABLE_ENV]);
  const armedSessions = new Set<string>();
  const shownSessions = new Set<string>();
  const optionsBySession = new Map<string, BuildSystemPromptOptions>();

  pi.registerMessageRenderer<Ledger>(CUSTOM_TYPE, (message, _options, theme) => {
    const ledger = message.details;
    if (!ledger || !Array.isArray(ledger.segments)) return undefined;
    return createLedgerComponent(ledger, theme as Theme);
  });

  // Keep the breakdown out of the model's context entirely: it is a TUI-only
  // artifact. The custom message still renders and persists in the session log,
  // but every LLM call sees a copy with it removed.
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (message) => !(message.role === "custom" && (message as { customType?: string }).customType === CUSTOM_TYPE),
    );
    if (filtered.length !== event.messages.length) return { messages: filtered as never };
  });

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    if (!sessionId) return;
    // Only fresh conversations have a meaningful "first user message" to follow.
    if (event.reason === "startup" || event.reason === "new") armedSessions.add(sessionId);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    if (sessionId) optionsBySession.set(sessionId, event.systemPromptOptions);

    if (!autoEnabled || !ctx.hasUI) return;
    if (!sessionId || !armedSessions.has(sessionId) || shownSessions.has(sessionId)) return;
    armedSessions.delete(sessionId);
    shownSessions.add(sessionId);

    const ledger = computeLedger(
      ctx,
      pi,
      event.systemPrompt,
      event.systemPromptOptions,
      event.prompt,
      event.images?.length ?? 0,
    );
    return {
      message: {
        customType: CUSTOM_TYPE,
        content: renderLedgerPlain(ledger),
        display: true,
        details: ledger,
      },
    };
  });

  pi.registerCommand("context-ledger", {
    description: "Show the pre-conversation context breakdown (skills, MCPs, tools, system prompt)",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "off") {
        autoEnabled = false;
        ctx.ui.notify("pi-context-ledger: automatic breakdown disabled for this session", "info");
        return;
      }
      if (command === "on") {
        autoEnabled = true;
        ctx.ui.notify("pi-context-ledger: automatic breakdown enabled", "info");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId?.();
      const options = sessionId ? optionsBySession.get(sessionId) : undefined;
      const ledger = computeLedger(ctx, pi, ctx.getSystemPrompt(), options, "", 0);
      pi.sendMessage(
        { customType: CUSTOM_TYPE, content: renderLedgerPlain(ledger), display: true, details: ledger },
        { triggerTurn: false },
      );
    },
  });
}

import { basename } from "node:path";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
// pi-tui is always present in a Pi runtime (it backs the TUI). Using its width
// helpers keeps the card aligned even when skill names, file paths, or the
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
const MAX_CARD_WIDTH = 90;
const MIN_CARD_WIDTH = 46;
// Expanded and plain views intentionally show every item; if the user asks for
// detail, hiding the tail behind a "+N more" row is worse than a long card.

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

/** Truncate (if needed) and pad to exactly `width` columns, ANSI/wide-char aware. */
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

type LedgerLeaf = {
  label: string;
  tokens: number;
};

type LedgerGroup = {
  label: string;
  tokens: number;
  note: string;
  /** Individual contributors, sorted largest-first. Empty for atomic groups. */
  items: LedgerLeaf[];
};

type Ledger = {
  total: number;
  contextWindow: number;
  windowPercent: number | null;
  groups: LedgerGroup[];
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

function sumTokens(items: LedgerLeaf[]): number {
  return items.reduce((total, item) => total + item.tokens, 0);
}

function byTokensDesc(a: LedgerLeaf, b: LedgerLeaf): number {
  return b.tokens - a.tokens;
}

function groupNote(count: number, unit: string, items: LedgerLeaf[]): string {
  if (count <= 0) return "";
  const head = plural(count, unit);
  return items.length > 0 ? `${head} · ${items[0].label}` : head;
}

/**
 * Build the pre-conversation context breakdown, attributed down to individual
 * skills, tools, and context files.
 *
 * The three top-level buckets — system prompt, tool schemas, first message —
 * are measured independently and sum to the grand total. The system prompt is a
 * single assembled string, so its sub-parts (skills, context files, appended
 * prompt) are estimated from their source text and reconciled against the
 * measured whole: "core prompt" absorbs the remainder, and if the estimates
 * exceed the measured prompt they are scaled to fit. Every row — group or item
 * — therefore stays additive against a total that matches Pi's own accounting.
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

  const skills = systemPrompt.includes("<available_skills>") ? (options?.skills ?? []) : [];
  const skillItems = skills.map((skill) => ({
    label: skill.name,
    tokens: tokens(`${skill.name}: ${skill.description} (${skill.filePath})`) + 6,
  }));

  const contextFiles = options?.contextFiles ?? [];
  const contextItems = contextFiles.map((file) => ({
    label: basename(file.path),
    tokens: tokens(file.content) + tokens(file.path) + 8,
  }));

  let appendTok = tokens(options?.appendSystemPrompt ?? "");
  let skillsTok = sumTokens(skillItems);
  let contextTok = sumTokens(contextItems);

  const partsEst = skillsTok + contextTok + appendTok;
  let coreTok: number;
  if (partsEst <= systemTotal) {
    coreTok = systemTotal - partsEst;
  } else {
    // Estimates overshot the measured prompt (rare; other extensions may have
    // reshaped sections). Scale the parts — and their items — down so the rows
    // still sum to the measured system prompt instead of inventing tokens.
    const scale = partsEst > 0 ? systemTotal / partsEst : 0;
    for (const item of skillItems) item.tokens = Math.round(item.tokens * scale);
    for (const item of contextItems) item.tokens = Math.round(item.tokens * scale);
    appendTok = Math.round(appendTok * scale);
    skillsTok = sumTokens(skillItems);
    contextTok = sumTokens(contextItems);
    coreTok = Math.max(0, systemTotal - skillsTok - contextTok - appendTok);
  }

  const active = new Set(pi.getActiveTools());
  const mcpItems: LedgerLeaf[] = [];
  const builtinItems: LedgerLeaf[] = [];
  const extItems: LedgerLeaf[] = [];
  for (const tool of pi.getAllTools()) {
    if (!active.has(tool.name)) continue;
    const leaf: LedgerLeaf = { label: tool.name, tokens: toolSchemaTokens(tool) };
    if (isBuiltinTool(tool)) builtinItems.push(leaf);
    else if (isMcpTool(tool)) mcpItems.push(leaf);
    else extItems.push(leaf);
  }

  skillItems.sort(byTokensDesc);
  contextItems.sort(byTokensDesc);
  mcpItems.sort(byTokensDesc);
  builtinItems.sort(byTokensDesc);
  extItems.sort(byTokensDesc);

  const messageTok = tokens(prompt) + imageCount * Math.ceil(ESTIMATED_IMAGE_CHARS / 4);

  const groups: LedgerGroup[] = [
    { label: "Core prompt", tokens: coreTok, items: [], note: "base + guidelines" },
    { label: "Skills", tokens: skillsTok, items: skillItems, note: groupNote(skills.length, "skill", skillItems) },
    {
      label: "Project context",
      tokens: contextTok,
      items: contextItems,
      note: groupNote(contextFiles.length, "file", contextItems),
    },
    { label: "Appended prompt", tokens: appendTok, items: [], note: "" },
    { label: "MCP tools", tokens: sumTokens(mcpItems), items: mcpItems, note: groupNote(mcpItems.length, "tool", mcpItems) },
    {
      label: "Built-in tools",
      tokens: sumTokens(builtinItems),
      items: builtinItems,
      note: builtinItems.length ? plural(builtinItems.length, "tool") : "",
    },
    {
      label: "Extension tools",
      tokens: sumTokens(extItems),
      items: extItems,
      note: groupNote(extItems.length, "tool", extItems),
    },
    { label: "Your message", tokens: messageTok, items: [], note: imageCount ? plural(imageCount, "image") : "" },
  ]
    .filter((group) => group.tokens > 0 || group.label === "Your message")
    .sort((a, b) => b.tokens - a.tokens);

  const total = systemTotal + sumTokens(mcpItems) + sumTokens(builtinItems) + sumTokens(extItems) + messageTok;
  const usage = ctx.getContextUsage?.();
  const contextWindow = usage?.contextWindow || ctx.model?.contextWindow || 0;
  const windowPercent = contextWindow > 0 ? (total / contextWindow) * 100 : null;

  return { total, contextWindow, windowPercent, groups };
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

function renderBar(rawTokens: number, maxTokens: number, width: number, color: ThemeColor, theme: Theme): string {
  const filled = Math.max(0, Math.min(width, Math.round(width * (rawTokens / (maxTokens || 1)))));
  return theme.fg(color, "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(width - filled));
}


type CardChrome = {
  outerWidth: number;
  innerWidth: number;
  top: string;
  bottom: string;
  frame: (content: string) => string;
};

function cardChrome(theme: Theme, viewportWidth: number): CardChrome {
  const outerWidth = Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, viewportWidth - 2));
  const innerWidth = outerWidth - 4;
  return {
    outerWidth,
    innerWidth,
    top: theme.fg("borderAccent", `╭${"─".repeat(outerWidth - 2)}╮`),
    bottom: theme.fg("borderAccent", `╰${"─".repeat(outerWidth - 2)}╯`),
    frame: (content: string) =>
      `${theme.fg("borderAccent", "│")} ${padTo(content, innerWidth)} ${theme.fg("borderAccent", "│")}`,
  };
}

function headerLine(ledger: Ledger, theme: Theme, innerWidth: number, expanded: boolean): string {
  const totalText = `~${formatTokens(ledger.total)} tokens`;
  const windowText =
    ledger.windowPercent === null
      ? "window unknown"
      : `${ledger.windowPercent.toFixed(0)}% of ${formatTokens(ledger.contextWindow)} window`;
  const caret = theme.fg("dim", expanded ? "▾" : "▸");
  const title = `${theme.fg("accent", "▌")} ${theme.bold(theme.fg("accent", "Initial context"))} ${caret}`;
  const summary = `${theme.fg("muted", totalText)} ${theme.fg("dim", "·")} ${theme.fg(windowColor(ledger.windowPercent), windowText)}`;
  const gap = innerWidth - visibleWidth(title) - visibleWidth(summary);
  return gap >= 1 ? `${title}${" ".repeat(gap)}${summary}` : title;
}

function footerLine(theme: Theme, expanded: boolean): string {
  if (expanded) {
    return `${theme.fg("dim", "▾ per-item breakdown · ")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("dim", " · /context-ledger")}`;
  }
  return `${theme.fg("dim", "▸ ")}${keyHint("app.tools.expand", "to expand")}${theme.fg("dim", " per-skill / per-tool detail")}`;
}

function renderCollapsed(ledger: Ledger, theme: Theme, chrome: CardChrome): string[] {
  const { innerWidth } = chrome;
  const maxTokens = ledger.groups.reduce((max, group) => Math.max(max, group.tokens), 0) || 1;
  const labelWidth = Math.min(16, ledger.groups.reduce((max, group) => Math.max(max, visibleWidth(group.label)), 0));
  const tokensWidth = Math.max(4, ledger.groups.reduce((max, group) => Math.max(max, formatTokens(group.tokens).length), 0));
  const pctWidth = 4;
  const barWidth = Math.max(8, Math.min(26, Math.round(innerWidth * 0.3)));
  const noteWidth = innerWidth - labelWidth - barWidth - tokensWidth - pctWidth - 8;

  const lines: string[] = [];
  for (const group of ledger.groups) {
    const share = ledger.total > 0 ? group.tokens / ledger.total : 0;
    const isMax = group.tokens === maxTokens;
    const bar = renderBar(group.tokens, maxTokens, barWidth, heatColor(share, isMax), theme);
    const label = theme.fg("text", padTo(group.label, labelWidth));
    const tokensCell = theme.fg(isMax && share >= 0.25 ? "warning" : "muted", padStart(formatTokens(group.tokens), tokensWidth));
    const pctCell = theme.fg("dim", padStart(`${Math.round(share * 100)}%`, pctWidth));
    const note = noteWidth >= 4 && group.note ? `  ${theme.fg("dim", truncatePlain(group.note, noteWidth))}` : "";
    lines.push(`${label}  ${bar}  ${tokensCell}  ${pctCell}${note}`);
  }
  return lines;
}

function renderExpanded(ledger: Ledger, theme: Theme, chrome: CardChrome): string[] {
  const { innerWidth } = chrome;
  const maxTokens = ledger.groups.reduce((max, group) => Math.max(max, group.tokens), 0) || 1;

  const groupLabelMax = ledger.groups.reduce((max, group) => Math.max(max, visibleWidth(group.label)), 0);
  const itemLabelMax = ledger.groups.reduce(
    (max, group) => group.items.reduce((m, item) => Math.max(m, visibleWidth(item.label) + 2), max),
    0,
  );
  const nameWidth = Math.max(12, Math.min(22, Math.max(groupLabelMax, itemLabelMax)));
  const tokenStrings = ledger.groups.flatMap((group) => [formatTokens(group.tokens), ...group.items.map((item) => formatTokens(item.tokens))]);
  const tokensWidth = Math.max(4, tokenStrings.reduce((max, str) => Math.max(max, str.length), 0));
  const pctWidth = 4;
  const barWidth = Math.max(8, Math.min(26, innerWidth - nameWidth - tokensWidth - pctWidth - 6));

  const lines: string[] = [];
  for (const group of ledger.groups) {
    const share = ledger.total > 0 ? group.tokens / ledger.total : 0;
    const isMax = group.tokens === maxTokens;
    const groupBar = renderBar(group.tokens, maxTokens, barWidth, heatColor(share, isMax), theme);
    const groupLabel = theme.bold(theme.fg("text", padTo(group.label, nameWidth)));
    const groupTokens = theme.fg(isMax && share >= 0.25 ? "warning" : "text", padStart(formatTokens(group.tokens), tokensWidth));
    const groupPct = theme.fg("dim", padStart(`${Math.round(share * 100)}%`, pctWidth));
    lines.push(`${groupLabel}  ${groupBar}  ${groupTokens}  ${groupPct}`);

    // Item bars scale to the group's own largest contributor so the per-group
    // leader stands out; the group bar above already encodes share-of-total.
    const itemScale = group.items.length > 0 ? group.items[0].tokens : group.tokens;
    for (const item of group.items) {
      const itemBar = renderBar(item.tokens, itemScale, barWidth, "borderAccent", theme);
      const name = theme.fg("muted", padTo(`  ${truncatePlain(item.label, nameWidth - 2)}`, nameWidth));
      const itemTokens = theme.fg("dim", padStart(formatTokens(item.tokens), tokensWidth));
      lines.push(`${name}  ${itemBar}  ${itemTokens}  ${" ".repeat(pctWidth)}`);
    }
  }
  return lines;
}

function renderLedgerCard(ledger: Ledger, theme: Theme, viewportWidth: number, expanded: boolean): string[] {
  const chrome = cardChrome(theme, viewportWidth);
  const body = expanded ? renderExpanded(ledger, theme, chrome) : renderCollapsed(ledger, theme, chrome);
  return [
    chrome.top,
    chrome.frame(headerLine(ledger, theme, chrome.innerWidth, expanded)),
    chrome.frame(theme.fg("borderMuted", "─".repeat(chrome.innerWidth))),
    ...body.map((line) => chrome.frame(line)),
    chrome.frame(footerLine(theme, expanded)),
    chrome.bottom,
  ];
}

function renderLedgerPlain(ledger: Ledger): string {
  const windowText =
    ledger.windowPercent === null
      ? "window unknown"
      : `${ledger.windowPercent.toFixed(0)}% of ${formatTokens(ledger.contextWindow)} window`;
  const lines = [`Initial context: ~${formatTokens(ledger.total)} tokens (${windowText})`];
  for (const group of ledger.groups) {
    const share = ledger.total > 0 ? Math.round((group.tokens / ledger.total) * 100) : 0;
    lines.push(`  ${group.label}: ${formatTokens(group.tokens)} (${share}%)${group.note ? ` — ${group.note}` : ""}`);
    for (const item of group.items) {
      lines.push(`      ${item.label}: ${formatTokens(item.tokens)}`);
    }
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

function createLedgerComponent(ledger: Ledger, theme: Theme, expanded: boolean): Component {
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  return {
    render(width: number): string[] {
      if (width !== cachedWidth) {
        cachedWidth = width;
        cachedLines = renderLedgerCard(ledger, theme, width, expanded);
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

  pi.registerMessageRenderer<Ledger>(CUSTOM_TYPE, (message, options, theme) => {
    const ledger = message.details;
    if (!ledger || !Array.isArray(ledger.groups)) return undefined;
    return createLedgerComponent(ledger, theme, options.expanded === true);
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

    const ledger = computeLedger(ctx, pi, event.systemPrompt, event.systemPromptOptions, event.prompt, event.images?.length ?? 0);
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
      if (command === "off" || command === "on") {
        autoEnabled = command === "on";
        ctx.ui.notify(`pi-context-ledger: automatic breakdown ${autoEnabled ? "enabled" : "disabled"}`, "info");
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

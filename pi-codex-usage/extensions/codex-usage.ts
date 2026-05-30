import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function visibleWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const plain = stripAnsi(value);
  const plainEllipsis = stripAnsi(ellipsis);
  const ellipsisWidth = visibleWidth(plainEllipsis);
  const take = Math.max(0, width - ellipsisWidth);
  return `${[...plain].slice(0, take).join("")}${plainEllipsis}`;
}

type HeaderMap = Record<string, unknown>;
type FooterData = {
  getGitBranch?: () => string | null;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  getAvailableProviderCount?: () => number;
  onBranchChange?: (callback: () => void) => () => void;
};
type FooterComponent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?: () => void;
};
type UsageWindow = {
  label: string;
  windowMinutes?: number;
  usedPercent?: number;
  resetAtMs?: number;
  resetAfterSeconds?: number;
};
type CodexUsageSnapshot = {
  updatedAtMs: number;
  planType?: string;
  activeLimit?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

type AssistantUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

const EXTENSION_NAME = "pi-codex-usage";
const DEFAULT_STATE_DIR = join(os.homedir(), ".pi", "agent", "codex-usage");
const STATE_DIR = process.env.PI_CODEX_USAGE_DIR || DEFAULT_STATE_DIR;
const SNAPSHOT_FILE = join(STATE_DIR, "latest.json");
const DISABLE_FOOTER_ENV = "PI_CODEX_USAGE_FOOTER";

let latestSnapshot: CodexUsageSnapshot | undefined = readPersistedSnapshot();
let requestFooterRender: (() => void) | undefined;
let footerEnabled = !/^(0|false|off|no|disabled)$/i.test(process.env[DISABLE_FOOTER_ENV] || "");
let tickTimer: ReturnType<typeof setInterval> | undefined;

function toHeaderRecord(headers: HeaderMap | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function numberHeader(headers: Record<string, string>, key: string): number | undefined {
  const raw = headers[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringHeader(headers: Record<string, string>, key: string): string | undefined {
  const raw = headers[key];
  return raw && raw.trim() ? raw.trim() : undefined;
}

function labelForWindow(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "7d";
  if (minutes && minutes % 60 === 0 && minutes < 24 * 60) return `${minutes / 60}h`;
  if (minutes && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  return fallback;
}

function parseWindow(headers: Record<string, string>, prefix: "primary" | "secondary", fallback: string, nowMs: number): UsageWindow | undefined {
  const windowMinutes = numberHeader(headers, `x-codex-${prefix}-window-minutes`);
  const usedPercent = numberHeader(headers, `x-codex-${prefix}-used-percent`);
  const resetAtSeconds = numberHeader(headers, `x-codex-${prefix}-reset-at`);
  const resetAfterSeconds = numberHeader(headers, `x-codex-${prefix}-reset-after-seconds`);

  if (usedPercent === undefined && resetAtSeconds === undefined && resetAfterSeconds === undefined) return undefined;

  return {
    label: labelForWindow(windowMinutes, fallback),
    windowMinutes,
    usedPercent: clampPercent(usedPercent),
    resetAtMs: resetAtSeconds !== undefined ? resetAtSeconds * 1000 : resetAfterSeconds !== undefined ? nowMs + resetAfterSeconds * 1000 : undefined,
    resetAfterSeconds,
  };
}

function parseCodexUsageHeaders(headers: HeaderMap | undefined): CodexUsageSnapshot | undefined {
  const h = toHeaderRecord(headers);
  const nowMs = Date.now();
  const primary = parseWindow(h, "primary", "5h", nowMs);
  const secondary = parseWindow(h, "secondary", "7d", nowMs);
  if (!primary && !secondary) return undefined;

  return {
    updatedAtMs: nowMs,
    planType: stringHeader(h, "x-codex-plan-type"),
    activeLimit: stringHeader(h, "x-codex-active-limit"),
    primary,
    secondary,
  };
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readPersistedSnapshot(): CodexUsageSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as CodexUsageSnapshot;
    if (!parsed || typeof parsed.updatedAtMs !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function persistSnapshot(snapshot: CodexUsageSnapshot): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch {
    // The footer should keep working even when the state directory is unwritable.
  }
}

function formatDurationUntil(targetMs: number | undefined, nowMs = Date.now()): string | undefined {
  if (targetMs === undefined) return undefined;
  const totalMinutes = Math.max(0, Math.ceil((targetMs - nowMs) / 60_000));
  if (totalMinutes === 0) return "now";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatWindowStatus(window: UsageWindow | undefined, nowMs = Date.now()): string | undefined {
  if (!window) return undefined;
  const leftPercent = window.usedPercent === undefined ? undefined : 100 - window.usedPercent;
  const left = leftPercent === undefined ? "?% left" : `${leftPercent}% left`;
  const reset = formatDurationUntil(window.resetAtMs, nowMs);
  return reset ? `${window.label}:${left} reset ${reset}` : `${window.label}:${left}`;
}

function formatCodexUsageStatus(nowMs = Date.now()): string | undefined {
  const snapshot = latestSnapshot;
  if (!snapshot) return undefined;
  const windows = [formatWindowStatus(snapshot.primary, nowMs), formatWindowStatus(snapshot.secondary, nowMs)].filter(
    (part): part is string => Boolean(part),
  );
  if (windows.length === 0) return undefined;
  return `Codex ${windows.join(" ")}`;
}

function formatCodexUsageDetails(nowMs = Date.now()): string {
  const snapshot = latestSnapshot;
  if (!snapshot) {
    return [
      "No Codex usage snapshot yet.",
      "This extension updates passively from x-codex-* response headers after Codex requests; it does not poll OpenAI/ChatGPT usage endpoints.",
    ].join("\n");
  }

  const lines = [
    "Codex usage (passive response-header snapshot)",
    `Updated: ${new Date(snapshot.updatedAtMs).toLocaleString()}`,
  ];
  if (snapshot.planType) lines.push(`Plan: ${snapshot.planType}`);
  if (snapshot.activeLimit) lines.push(`Active limit: ${snapshot.activeLimit}`);
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue;
    const leftPercent = window.usedPercent === undefined ? "?" : String(100 - window.usedPercent);
    const reset = formatDurationUntil(window.resetAtMs, nowMs) || "unknown";
    const resetAt = window.resetAtMs ? new Date(window.resetAtMs).toLocaleString() : "unknown";
    lines.push(`${window.label}: ${leftPercent}% left; resets in ${reset} (${resetAt})`);
  }
  lines.push(`State: ${SNAPSHOT_FILE}`);
  lines.push("Network policy: passive only; no usage polling or extra OpenAI/ChatGPT requests.");
  return lines.join("\n");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/");
  return normalized.toLowerCase().startsWith(home.toLowerCase()) ? `~${normalized.slice(home.length)}` : normalized;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function usageFromEntry(entry: unknown): AssistantUsage | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as { type?: unknown; message?: { role?: unknown; usage?: AssistantUsage } };
  if (candidate.type !== "message" || candidate.message?.role !== "assistant") return undefined;
  return candidate.message.usage;
}

function buildStatsLine(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  getThinkingLevel: () => string,
): string {
  const sessionManager = ctx.sessionManager as unknown as { getEntries?: () => unknown[] };
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of sessionManager.getEntries?.() || []) {
    const usage = usageFromEntry(entry);
    if (!usage) continue;
    totalInput += usage.input || 0;
    totalOutput += usage.output || 0;
    totalCacheRead += usage.cacheRead || 0;
    totalCacheWrite += usage.cacheWrite || 0;
    totalCost += usage.cost?.total || 0;
  }

  const contextUsage = ctx.getContextUsage?.();
  const contextUsageDetails = contextUsage as (typeof contextUsage & { autoCompact?: boolean }) | undefined;
  const contextWindow = contextUsage?.contextWindow || ctx.model?.contextWindow || 0;
  const contextPercentValue = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? "?" : contextPercentValue.toFixed(1);
  const autoIndicator = contextUsageDetails?.autoCompact === false ? "" : " (auto)";
  const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

  const statsParts: string[] = [];
  if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
  if (totalCost || ctx.model?.api === "openai-codex-responses") {
    statsParts.push(`$${totalCost.toFixed(3)}${ctx.model?.api === "openai-codex-responses" ? " (sub)" : ""}`);
  }
  const contextPart =
    contextPercentValue > 90
      ? theme.fg("error", contextPercentDisplay)
      : contextPercentValue > 70
        ? theme.fg("warning", contextPercentDisplay)
        : contextPercentDisplay;
  statsParts.push(contextPart);

  let statsLeft = statsParts.join(" ");
  if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

  const modelName = ctx.model?.id || "no-model";
  const thinkingLevel = getThinkingLevel();
  const rightSide = ctx.model?.reasoning
    ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
    : modelName;
  const rightWidth = visibleWidth(rightSide);
  const leftWidth = visibleWidth(statsLeft);
  const minPadding = 2;

  let line: string;
  if (leftWidth + minPadding + rightWidth <= width) {
    line = `${statsLeft}${" ".repeat(width - leftWidth - rightWidth)}${rightSide}`;
  } else {
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      line = `${statsLeft}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
    } else {
      line = statsLeft;
    }
  }

  return theme.fg("dim", statsLeft) + theme.fg("dim", line.slice(statsLeft.length));
}

function buildTopLine(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"], footerData: FooterData, width: number): string {
  const sessionManager = ctx.sessionManager as unknown as {
    getCwd?: () => string;
    getSessionName?: () => string | undefined;
  };
  const parts: string[] = [];
  parts.push(compactPath(sessionManager.getCwd?.() || ctx.cwd || process.cwd()));

  const branch = footerData.getGitBranch?.();
  if (branch) parts[0] = `${parts[0]} (${branch})`;

  const sessionName = sessionManager.getSessionName?.();
  if (sessionName) parts.push(sessionName);

  const codexStatus = formatCodexUsageStatus();
  const extensionStatuses = Array.from(footerData.getExtensionStatuses?.().entries() || [])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .filter(Boolean);
  const status = [codexStatus, ...extensionStatuses].filter((part): part is string => Boolean(part)).join("  ");
  const left = theme.fg("dim", parts.join(" • "));

  if (!status) return truncateToWidth(left, width, theme.fg("dim", "..."));

  const leftWidth = visibleWidth(left);
  const statusWidth = visibleWidth(status);
  if (leftWidth + 2 + statusWidth <= width) {
    return `${left}${" ".repeat(width - leftWidth - statusWidth)}${status}`;
  }

  const maxStatusWidth = Math.max(20, Math.floor(width * 0.72));
  const compactStatus = statusWidth > maxStatusWidth ? truncateToWidth(status, maxStatusWidth, theme.fg("dim", "...")) : status;
  const compactStatusWidth = visibleWidth(compactStatus);
  const leftBudget = Math.max(0, width - compactStatusWidth - 1);
  if (leftBudget <= 0) return truncateToWidth(compactStatus, width, theme.fg("dim", "..."));
  return `${truncateToWidth(left, leftBudget, theme.fg("dim", "..."))} ${compactStatus}`;
}

function createFooter(
  ctx: ExtensionContext,
  getThinkingLevel: () => string,
): (tui: { requestRender: () => void }, theme: ExtensionContext["ui"]["theme"], footerData: FooterData) => FooterComponent {
  return (tui, theme, footerData) => {
    requestFooterRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());

    return {
      invalidate() {},
      render(width: number): string[] {
        return [buildTopLine(ctx, theme, footerData, width), buildStatsLine(ctx, theme, width, getThinkingLevel)];
      },
      dispose() {
        unsubscribe?.();
        if (requestFooterRender) requestFooterRender = undefined;
      },
    };
  };
}

function installFooter(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!ctx.hasUI || !footerEnabled) return;
  ctx.ui.setFooter(createFooter(ctx, () => pi.getThinkingLevel()));
  ensureTickTimer();
}

function ensureTickTimer(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => requestFooterRender?.(), 30_000);
  tickTimer.unref?.();
}

function disposeTickTimer(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = undefined;
}

function recordSnapshot(snapshot: CodexUsageSnapshot): void {
  latestSnapshot = snapshot;
  persistSnapshot(snapshot);
  requestFooterRender?.();
}

export default function codexUsage(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    installFooter(ctx, pi);
  });

  pi.on("model_select", async () => {
    requestFooterRender?.();
  });

  pi.on("thinking_level_select", async () => {
    requestFooterRender?.();
  });

  pi.on("after_provider_response", async (event) => {
    const snapshot = parseCodexUsageHeaders(event.headers as HeaderMap | undefined);
    if (snapshot) recordSnapshot(snapshot);
  });

  pi.on("session_shutdown", async () => {
    disposeTickTimer();
  });

  pi.registerCommand("codex-usage", {
    description: "Show passive Codex 5h/7d usage and control the compact footer",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "footer off" || command === "off") {
        footerEnabled = false;
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Codex usage compact footer disabled for this session", "info");
        return;
      }
      if (command === "footer on" || command === "on") {
        footerEnabled = true;
        installFooter(ctx, pi);
        ctx.ui.notify("Codex usage compact footer enabled", "info");
        return;
      }

      ctx.ui.notify(
        [
          formatCodexUsageDetails(),
          "",
          "Commands: /codex-usage status | footer on | footer off",
          `Disable on startup: ${DISABLE_FOOTER_ENV}=off`,
        ].join("\n"),
        "info",
      );
    },
  });
}

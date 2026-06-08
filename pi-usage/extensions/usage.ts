import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function isCombiningMark(value: string): boolean {
  return /\p{Mark}/u.test(value);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  );
}

function charCellWidth(value: string): number {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || isCombiningMark(value)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) width += charCellWidth(char);
  return width;
}

function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const plain = stripAnsi(value);
  const plainEllipsis = stripAnsi(ellipsis);
  const ellipsisWidth = visibleWidth(plainEllipsis);
  const take = Math.max(0, width - ellipsisWidth);
  let used = 0;
  let truncated = "";
  for (const char of plain) {
    const charWidth = charCellWidth(char);
    if (used + charWidth > take) break;
    truncated += char;
    used += charWidth;
  }
  return `${truncated}${plainEllipsis}`;
}

type HeaderMap = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
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
type UsageSource = "codex" | "claude";
type UsageSnapshot = {
  source: UsageSource;
  updatedAtMs: number;
  planType?: string;
  activeLimit?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
};
type UsageSnapshots = Partial<Record<UsageSource, UsageSnapshot>>;

type UsageCost = {
  total?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type AssistantUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: UsageCost;
};

// Token buckets are normalised identically for Codex and Claude:
//   input      = fresh, uncached input tokens billed at the full input rate
//   cacheRead  = input tokens served cheaply from the prompt cache
//   cacheWrite = input tokens written to the cache this turn (Anthropic premium; 0 on Codex)
//   output     = output tokens
// They never overlap: totalTokens == input + output + cacheRead + cacheWrite.
// Per-bucket dollar costs are summed alongside so /pi-usage can attribute spend.
type SessionStats = {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
};

type SessionStatsCache = {
  manager: unknown;
  entryCount: number;
  stats: SessionStats;
};

const WEBSOCKET_PATCH_ID = "pi-usage@1";
const WEBSOCKET_PATCH_STACK_KEY = Symbol.for("pi.websocketPatchStack");
const WEBSOCKET_PATCH_ORIGINAL_KEY = Symbol.for("pi.websocketPatchOriginal");
const GLOBAL_STATE_KEY = Symbol.for("pi.usage.state");
const DEFAULT_STATE_DIR = join(os.homedir(), ".pi", "agent", "pi-usage");
const STATE_DIR = process.env.PI_USAGE_DIR || DEFAULT_STATE_DIR;
const SNAPSHOT_FILE = join(STATE_DIR, "latest.json");
const DISABLE_FOOTER_ENV = "PI_USAGE_FOOTER";
const SOURCE_LABELS: Record<UsageSource, string> = { codex: "Codex", claude: "Claude" };
const USAGE_SOURCES: readonly UsageSource[] = ["codex", "claude"];

let snapshots: UsageSnapshots = readPersistedSnapshots();
let requestFooterRender: (() => void) | undefined;
let footerContext: ExtensionContext | undefined;
let footerEnabled = !/^(0|false|off|no|disabled)$/i.test(process.env[DISABLE_FOOTER_ENV] || "");
let tickTimer: ReturnType<typeof setInterval> | undefined;
let sessionStatsCache: SessionStatsCache | undefined;

type UsageGlobalState = {
  onWebSocketMessage?: (data: unknown) => void;
};

function getGlobalState(): UsageGlobalState {
  const global = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: UsageGlobalState };
  global[GLOBAL_STATE_KEY] ??= {};
  return global[GLOBAL_STATE_KEY]!;
}

function websocketPatchStack(value: unknown): string[] {
  if (typeof value !== "function") return [];
  const stack = Reflect.get(value, WEBSOCKET_PATCH_STACK_KEY);
  return Array.isArray(stack) ? stack.filter((item): item is string => typeof item === "string") : [];
}

function isCodexUrl(url: unknown): boolean {
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as { url?: string })?.url;
    if (!raw) return false;
    const parsed = new URL(raw);
    return parsed.pathname.endsWith("/codex/responses") || parsed.pathname.includes("/codex/responses");
  } catch {
    return false;
  }
}

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

function parseResetAtValue(value: unknown): number | undefined {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return undefined;
    // Provider reset timestamps have appeared as epoch seconds and milliseconds.
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resetAtHeader(headers: Record<string, string>, key: string): number | undefined {
  return parseResetAtValue(headers[key]);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function labelForWindow(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "7d";
  if (minutes && minutes % 60 === 0 && minutes < 24 * 60) return `${minutes / 60}h`;
  if (minutes && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  return fallback;
}

// --- Codex: x-codex-* response headers and codex.rate_limits WebSocket events ---

function parseCodexWindow(headers: Record<string, string>, prefix: "primary" | "secondary", fallback: string, nowMs: number): UsageWindow | undefined {
  const windowMinutes = numberHeader(headers, `x-codex-${prefix}-window-minutes`);
  const usedPercent = numberHeader(headers, `x-codex-${prefix}-used-percent`);
  const resetAtMs = resetAtHeader(headers, `x-codex-${prefix}-reset-at`);
  const resetAfterSeconds = numberHeader(headers, `x-codex-${prefix}-reset-after-seconds`);

  if (usedPercent === undefined && resetAtMs === undefined && resetAfterSeconds === undefined) return undefined;

  return {
    label: labelForWindow(windowMinutes, fallback),
    windowMinutes,
    usedPercent: clampPercent(usedPercent),
    resetAtMs: resetAtMs ?? (resetAfterSeconds !== undefined ? nowMs + resetAfterSeconds * 1000 : undefined),
    resetAfterSeconds,
  };
}

function parseCodexUsageHeaders(headers: HeaderMap | undefined): UsageSnapshot | undefined {
  const h = toHeaderRecord(headers);
  const nowMs = Date.now();
  const primary = parseCodexWindow(h, "primary", "5h", nowMs);
  const secondary = parseCodexWindow(h, "secondary", "7d", nowMs);
  if (!primary && !secondary) return undefined;

  return {
    source: "codex",
    updatedAtMs: nowMs,
    planType: stringHeader(h, "x-codex-plan-type"),
    activeLimit: stringHeader(h, "x-codex-active-limit"),
    primary,
    secondary,
  };
}

function parseRateLimitEventWindow(value: unknown, fallback: string, nowMs: number): UsageWindow | undefined {
  const window = recordValue(value);
  if (!window) return undefined;

  const windowMinutes = numberValue(window.window_minutes);
  const usedPercent = numberValue(window.used_percent);
  const resetAtMs = parseResetAtValue(window.reset_at);
  const resetAfterSeconds = numberValue(window.reset_after_seconds);
  if (usedPercent === undefined && resetAtMs === undefined && resetAfterSeconds === undefined) return undefined;

  return {
    label: labelForWindow(windowMinutes, fallback),
    windowMinutes,
    usedPercent: clampPercent(usedPercent),
    resetAtMs: resetAtMs ?? (resetAfterSeconds !== undefined ? nowMs + resetAfterSeconds * 1000 : undefined),
    resetAfterSeconds,
  };
}

function parseCodexRateLimitEvent(event: JsonRecord): UsageSnapshot | undefined {
  if (event.type !== "codex.rate_limits") return undefined;

  const nowMs = Date.now();
  const rateLimits = recordValue(event.rate_limits);
  const primary = parseRateLimitEventWindow(rateLimits?.primary, "5h", nowMs);
  const secondary = parseRateLimitEventWindow(rateLimits?.secondary, "7d", nowMs);
  if (!primary && !secondary) return undefined;

  return {
    source: "codex",
    updatedAtMs: nowMs,
    planType: stringValue(event.plan_type),
    activeLimit:
      stringValue(event.active_limit) ??
      stringValue(event.activeLimit) ??
      stringValue(event.metered_limit_name) ??
      stringValue(event.limit_name),
    primary,
    secondary,
  };
}

function parseCodexUsageLimitErrorEvent(event: JsonRecord): UsageSnapshot | undefined {
  if (event.type !== "error") return undefined;
  const headers = recordValue(event.headers);
  const snapshot = parseCodexUsageHeaders(headers);
  if (!snapshot) return undefined;

  const error = recordValue(event.error);
  return {
    ...snapshot,
    planType: stringValue(error?.plan_type) ?? snapshot.planType,
  };
}

function parseCodexWebSocketMessage(data: unknown): UsageSnapshot | undefined {
  if (typeof data !== "string") return undefined;
  let event: JsonRecord | undefined;
  try {
    event = recordValue(JSON.parse(data));
  } catch {
    return undefined;
  }
  if (!event) return undefined;
  return parseCodexRateLimitEvent(event) ?? parseCodexUsageLimitErrorEvent(event);
}

// --- Claude: anthropic-ratelimit-unified-* response headers (OAuth/Claude Code) ---

function parseClaudeWindow(headers: Record<string, string>, prefix: "5h" | "7d"): UsageWindow | undefined {
  const utilization = numberHeader(headers, `anthropic-ratelimit-unified-${prefix}-utilization`);
  const resetAtMs = resetAtHeader(headers, `anthropic-ratelimit-unified-${prefix}-reset`);
  if (utilization === undefined && resetAtMs === undefined) return undefined;

  // Anthropic reports utilization as a fraction (0.0–1.0+); convert to a percentage.
  return {
    label: prefix,
    usedPercent: clampPercent(utilization === undefined ? undefined : utilization * 100),
    resetAtMs,
  };
}

function parseClaudeUsageHeaders(headers: HeaderMap | undefined): UsageSnapshot | undefined {
  const h = toHeaderRecord(headers);
  const nowMs = Date.now();
  const primary = parseClaudeWindow(h, "5h");
  const secondary = parseClaudeWindow(h, "7d");
  if (!primary && !secondary) return undefined;

  return {
    source: "claude",
    updatedAtMs: nowMs,
    activeLimit: stringHeader(h, "anthropic-ratelimit-unified-representative-claim"),
    primary,
    secondary,
  };
}

function parseUsageHeaders(headers: HeaderMap | undefined): UsageSnapshot | undefined {
  return parseCodexUsageHeaders(headers) ?? parseClaudeUsageHeaders(headers);
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isUsageSource(value: unknown): value is UsageSource {
  return value === "codex" || value === "claude";
}

function freshWindow(window: UsageWindow | undefined, nowMs: number): UsageWindow | undefined {
  if (!window) return undefined;
  return typeof window.resetAtMs === "number" && Number.isFinite(window.resetAtMs) && window.resetAtMs <= nowMs ? undefined : window;
}

function freshSnapshot(snapshot: UsageSnapshot, nowMs: number): UsageSnapshot | undefined {
  const primary = freshWindow(snapshot.primary, nowMs);
  const secondary = freshWindow(snapshot.secondary, nowMs);
  if (!primary && !secondary) return undefined;
  return primary === snapshot.primary && secondary === snapshot.secondary ? snapshot : { ...snapshot, primary, secondary };
}

function pruneExpiredSnapshots(nowMs = Date.now(), persist = false): void {
  let changed = false;
  for (const source of USAGE_SOURCES) {
    const snapshot = snapshots[source];
    if (!snapshot) continue;
    const fresh = freshSnapshot(snapshot, nowMs);
    if (fresh) {
      if (fresh !== snapshot) {
        snapshots[source] = fresh;
        changed = true;
      }
    } else {
      delete snapshots[source];
      changed = true;
    }
  }
  if (changed && persist) persistSnapshots();
}

function readPersistedSnapshots(): UsageSnapshots {
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as JsonRecord;
    if (!parsed || typeof parsed !== "object") return {};
    const result: UsageSnapshots = {};
    for (const source of USAGE_SOURCES) {
      const candidate = parsed[source] as UsageSnapshot | undefined;
      if (candidate && isUsageSource(candidate.source) && typeof candidate.updatedAtMs === "number") {
        const fresh = freshSnapshot(candidate, Date.now());
        if (fresh) result[source] = fresh;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistSnapshots(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
  } catch {
    // The footer should keep working even when the state directory is unwritable.
  }
}

function snapshotForSource(source: UsageSource | undefined, nowMs = Date.now()): UsageSnapshot | undefined {
  pruneExpiredSnapshots(nowMs, true);
  return source ? snapshots[source] : undefined;
}

// Map the active model to the usage family it can actually report. Codex usage
// comes only from the Codex subscription transport; Claude usage only from
// Anthropic OAuth rate-limit headers. Any other model has no applicable usage,
// so the footer shows nothing rather than stale data from the previous family.
function currentUsageSource(model: ExtensionContext["model"] | undefined): UsageSource | undefined {
  if (!model) return undefined;
  if (model.api === "openai-codex-responses") return "codex";
  const haystack = `${model.provider ?? ""} ${model.api ?? ""} ${model.id ?? ""}`.toLowerCase();
  if (haystack.includes("anthropic") || haystack.includes("claude")) return "claude";
  return undefined;
}

function installWebSocketCapture(): void {
  if (typeof globalThis.WebSocket !== "function") return;
  if (websocketPatchStack(globalThis.WebSocket).includes(WEBSOCKET_PATCH_ID)) return;

  const OriginalWebSocket = globalThis.WebSocket;
  const downstreamStack = websocketPatchStack(OriginalWebSocket);

  class UsageCodexWebSocket extends OriginalWebSocket {
    private __usageCodexTarget = false;

    constructor(url: string | URL, protocols?: string | string[], options?: unknown) {
      // @ts-expect-error WebSocket constructor signatures vary across runtimes.
      super(url, protocols as never, options as never);
      this.__usageCodexTarget = isCodexUrl(url);
      if (!this.__usageCodexTarget) return;

      this.addEventListener("message", (event) => {
        getGlobalState().onWebSocketMessage?.((event as MessageEvent).data);
      });
    }
  }

  try {
    Object.defineProperty(UsageCodexWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
    Object.defineProperty(UsageCodexWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
    Object.defineProperty(UsageCodexWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
    Object.defineProperty(UsageCodexWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });
  } catch {
    // Non-fatal: some runtimes do not allow redefining WebSocket constants.
  }

  Object.defineProperty(UsageCodexWebSocket, WEBSOCKET_PATCH_STACK_KEY, {
    value: [...downstreamStack, WEBSOCKET_PATCH_ID],
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(UsageCodexWebSocket, WEBSOCKET_PATCH_ORIGINAL_KEY, {
    value: OriginalWebSocket,
    enumerable: false,
    configurable: false,
  });

  globalThis.WebSocket = UsageCodexWebSocket as typeof WebSocket;
}

function uninstallWebSocketCapture(): void {
  if (typeof globalThis.WebSocket !== "function") return;
  const current = globalThis.WebSocket;
  const stack = websocketPatchStack(current);
  // The WebSocket constructor is process-global. Restore it only when our wrapper is still top-of-stack;
  // if another extension wrapped after us, its lifecycle owns the next restoration step.
  if (stack[stack.length - 1] !== WEBSOCKET_PATCH_ID) return;
  const original = Reflect.get(current, WEBSOCKET_PATCH_ORIGINAL_KEY);
  if (typeof original === "function") globalThis.WebSocket = original as typeof WebSocket;
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

function styleUsageWindow(window: UsageWindow | undefined, theme: ExtensionContext["ui"]["theme"], nowMs: number): string | undefined {
  if (!window) return undefined;
  const remaining = window.usedPercent === undefined ? undefined : Math.max(0, 100 - window.usedPercent);
  // Dim by default; escalate only when the remaining budget is genuinely low.
  const pctColor = remaining === undefined ? "dim" : remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "dim";
  const head = theme.fg("dim", `${window.label}:`) + theme.fg(pctColor, `${remaining ?? "?"}%`);
  const reset = formatDurationUntil(window.resetAtMs, nowMs);
  return reset ? `${head} ${theme.fg("dim", reset)}` : head;
}

function formatUsageStatus(theme: ExtensionContext["ui"]["theme"], source: UsageSource | undefined, nowMs = Date.now()): string | undefined {
  const snapshot = snapshotForSource(source, nowMs);
  if (!snapshot) return undefined;
  const windows = [styleUsageWindow(snapshot.primary, theme, nowMs), styleUsageWindow(snapshot.secondary, theme, nowMs)].filter(
    (part): part is string => Boolean(part),
  );
  if (windows.length === 0) return undefined;
  return `${theme.fg("dim", SOURCE_LABELS[snapshot.source])} ${windows.join(" ")}`;
}

function formatUsageDetails(nowMs = Date.now()): string {
  pruneExpiredSnapshots(nowMs, true);
  const entries = USAGE_SOURCES.map((source) => snapshots[source])
    .filter((snapshot): snapshot is UsageSnapshot => Boolean(snapshot))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  if (entries.length === 0) {
    return [
      "No usage snapshot yet.",
      "This extension updates passively from provider response headers and events after requests: Codex x-codex-* headers / codex.rate_limits WebSocket events, and Claude anthropic-ratelimit-unified-* headers. It does not poll usage endpoints.",
    ].join("\n");
  }

  const lines: string[] = [];
  for (const snapshot of entries) {
    lines.push(`${SOURCE_LABELS[snapshot.source]} usage (passive response-header/event snapshot)`);
    lines.push(`Updated: ${new Date(snapshot.updatedAtMs).toISOString()}`);
    if (snapshot.planType) lines.push(`Plan: ${snapshot.planType}`);
    if (snapshot.activeLimit) lines.push(`Active limit: ${snapshot.activeLimit}`);
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window) continue;
      const leftPercent = window.usedPercent === undefined ? "?" : String(100 - window.usedPercent);
      const reset = formatDurationUntil(window.resetAtMs, nowMs) || "unknown";
      const resetAt = window.resetAtMs ? new Date(window.resetAtMs).toISOString() : "unknown";
      lines.push(`${window.label}: ${leftPercent}% left; resets in ${reset} (${resetAt})`);
    }
    lines.push("");
  }
  lines.push(`State: ${SNAPSHOT_FILE}`);
  lines.push("Network policy: passive only; no usage polling or extra provider requests.");
  return lines.join("\n").trimEnd();
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
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

function emptySessionStats(): SessionStats {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
  };
}

function computeSessionStats(entries: readonly unknown[]): SessionStats {
  const stats = emptySessionStats();
  for (const entry of entries) {
    const usage = usageFromEntry(entry);
    if (!usage) continue;
    stats.totalInput += usage.input || 0;
    stats.totalOutput += usage.output || 0;
    stats.totalCacheRead += usage.cacheRead || 0;
    stats.totalCacheWrite += usage.cacheWrite || 0;
    stats.totalCost += usage.cost?.total || 0;
    stats.costInput += usage.cost?.input || 0;
    stats.costOutput += usage.cost?.output || 0;
    stats.costCacheRead += usage.cost?.cacheRead || 0;
    stats.costCacheWrite += usage.cost?.cacheWrite || 0;
  }
  return stats;
}

function sessionEntries(ctx: ExtensionContext): { manager: unknown; entries: unknown[] } | undefined {
  const manager = ctx.sessionManager as unknown as { getEntries?: () => unknown[] };
  const entries = manager.getEntries?.();
  return entries ? { manager, entries } : undefined;
}

function cachedSessionStats(ctx: ExtensionContext): SessionStats {
  const current = sessionEntries(ctx);
  if (!current) return emptySessionStats();
  if (sessionStatsCache?.manager === current.manager && sessionStatsCache.entryCount === current.entries.length) return sessionStatsCache.stats;
  const stats = computeSessionStats(current.entries);
  sessionStatsCache = { manager: current.manager, entryCount: current.entries.length, stats };
  return stats;
}

function refreshSessionStats(ctx: ExtensionContext): void {
  const current = sessionEntries(ctx);
  if (!current) {
    sessionStatsCache = undefined;
    return;
  }
  sessionStatsCache = { manager: current.manager, entryCount: current.entries.length, stats: computeSessionStats(current.entries) };
}

function formatSessionCostDetails(ctx: ExtensionContext): string {
  const stats = cachedSessionStats(ctx);
  const cachedInput = stats.totalCacheRead;
  const freshInput = stats.totalInput + stats.totalCacheWrite;
  const allInput = cachedInput + freshInput;
  if (allInput === 0 && stats.totalOutput === 0) return "No token usage recorded for this session yet.";

  const hitPercent = allInput > 0 ? Math.round((cachedInput / allInput) * 100) : 0;
  const model = ctx.model;
  const isSubscription = model?.api === "openai-codex-responses";
  const modelLabel = model
    ? `Model: ${model.id}${model.provider ? ` (${model.provider})` : ""}${isSubscription ? " — subscription, $ is notional" : ""}`
    : "Model: unknown";

  const row = (label: string, tokens: number, cost: number, extra = ""): string =>
    `${`${label}:`.padEnd(16)}${formatTokens(tokens).padStart(8)}  ${formatMoney(cost).padStart(9)}${extra}`;

  return [
    "Session tokens & cost (cumulative)",
    modelLabel,
    row("Input uncached", freshInput, stats.costInput + stats.costCacheWrite),
    row("Input cached", cachedInput, stats.costCacheRead, `  (${hitPercent}% of input)`),
    row("Output", stats.totalOutput, stats.costOutput),
    row("Total", allInput + stats.totalOutput, stats.totalCost),
  ].join("\n");
}

function buildStatsLine(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  getThinkingLevel: () => string,
): string {
  const { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost } = cachedSessionStats(ctx);

  const contextUsage = ctx.getContextUsage?.();
  const contextUsageDetails = contextUsage as (typeof contextUsage & { autoCompact?: boolean }) | undefined;
  const contextWindow = contextUsage?.contextWindow || ctx.model?.contextWindow || 0;
  const contextPercentValue = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? "?" : contextPercentValue.toFixed(1);
  const autoIndicator = contextUsageDetails?.autoCompact === false ? "" : " (auto)";
  const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

  // Only input is ever cached, so the cost story is three buckets: fresh input
  // (full/premium rate), cached input re-reads (cheap), and output. "in" folds
  // cache writes into fresh input because those tokens are processed this turn;
  // "cache" is the cached read with its hit rate over all input.
  const cachedInput = totalCacheRead;
  const freshInput = totalInput + totalCacheWrite;
  const allInput = cachedInput + freshInput;

  const statsParts: string[] = [];
  if (freshInput) statsParts.push(`in ${formatTokens(freshInput)}`);
  if (cachedInput) {
    const hitPercent = allInput > 0 ? Math.round((cachedInput / allInput) * 100) : 0;
    statsParts.push(`cache ${formatTokens(cachedInput)}·${hitPercent}%`);
  }
  if (totalOutput) statsParts.push(`out ${formatTokens(totalOutput)}`);
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

  const usageStatus = formatUsageStatus(theme, currentUsageSource(ctx.model));
  const extensionStatuses = Array.from(footerData.getExtensionStatuses?.().entries() || [])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .filter((text): text is string => Boolean(text))
    .map((text) => theme.fg("dim", text));
  const status = [usageStatus, ...extensionStatuses].filter((part): part is string => Boolean(part)).join("  ");
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
        const renderContext = footerContext ?? ctx;
        return [buildTopLine(renderContext, theme, footerData, width), buildStatsLine(renderContext, theme, width, getThinkingLevel)];
      },
      dispose() {
        unsubscribe?.();
        if (requestFooterRender) requestFooterRender = undefined;
      },
    };
  };
}

function rememberFooterContext(ctx: ExtensionContext): void {
  footerContext = ctx;
}

function installFooter(ctx: ExtensionContext, pi: ExtensionAPI): void {
  rememberFooterContext(ctx);
  refreshSessionStats(ctx);
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

function refreshFooter(): void {
  requestFooterRender?.();
}

function recordSnapshot(snapshot: UsageSnapshot): void {
  const previous = snapshots[snapshot.source];
  const merged: UsageSnapshot = {
    ...snapshot,
    planType: snapshot.planType ?? previous?.planType,
    activeLimit: snapshot.activeLimit ?? previous?.activeLimit,
  };
  snapshots[snapshot.source] = merged;
  pruneExpiredSnapshots(Date.now());
  persistSnapshots();
  refreshFooter();
}

export default function usage(pi: ExtensionAPI): void {
  const handleWebSocketMessage = (data: unknown) => {
    const snapshot = parseCodexWebSocketMessage(data);
    if (snapshot) recordSnapshot(snapshot);
  };
  installWebSocketCapture();
  getGlobalState().onWebSocketMessage = handleWebSocketMessage;

  pi.on("session_start", async (_event, ctx) => {
    installWebSocketCapture();
    installFooter(ctx, pi);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    rememberFooterContext(ctx);
    installWebSocketCapture();
  });

  pi.on("model_select", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshFooter();
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshFooter();
  });

  pi.on("message_end", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("turn_end", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("agent_end", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("session_compact", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("session_tree", async (_event, ctx) => {
    rememberFooterContext(ctx);
    refreshSessionStats(ctx);
    refreshFooter();
  });

  pi.on("after_provider_response", async (event, ctx) => {
    rememberFooterContext(ctx);
    const snapshot = parseUsageHeaders(event.headers as HeaderMap | undefined);
    if (snapshot) recordSnapshot(snapshot);
  });

  pi.on("session_shutdown", async () => {
    const state = getGlobalState();
    if (state.onWebSocketMessage === handleWebSocketMessage) state.onWebSocketMessage = undefined;
    footerContext = undefined;
    sessionStatsCache = undefined;
    disposeTickTimer();
    uninstallWebSocketCapture();
  });

  pi.registerCommand("pi-usage", {
    description: "Show passive Codex/Claude 5h/7d usage from response headers and events, and control the compact footer",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "footer off" || command === "off") {
        footerEnabled = false;
        ctx.ui.setFooter(undefined);
        requestFooterRender = undefined;
        disposeTickTimer();
        ctx.ui.notify("Usage compact footer disabled for this session", "info");
        return;
      }
      if (command === "footer on" || command === "on") {
        footerEnabled = true;
        installFooter(ctx, pi);
        ctx.ui.notify("Usage compact footer enabled", "info");
        return;
      }

      ctx.ui.notify(
        [
          formatSessionCostDetails(ctx),
          "",
          formatUsageDetails(),
          "",
          "Commands: /pi-usage status | footer on | footer off",
          `Disable on startup: ${DISABLE_FOOTER_ENV}=off`,
        ].join("\n"),
        "info",
      );
    },
  });
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCodexLikeModel } from "./model-tools.ts";

type HeaderMap = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
type UsageWindow = {
  label: string;
  windowMinutes?: number;
  usedPercent?: number;
  resetAtMs?: number;
  resetAfterSeconds?: number;
};
type UsageSource = "codex";
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

// Pi records disjoint Codex token buckets: fresh input, cached input, cache
// writes (normally zero for Codex), and output. Per-bucket dollar costs are
// summed alongside so /pi-usage can attribute notional API spend.
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

const WEBSOCKET_PATCH_ID = "pi-codex-compat-usage@1";
const WEBSOCKET_PATCH_STACK_KEY = Symbol.for("pi.websocketPatchStack");
const WEBSOCKET_PATCH_ORIGINAL_KEY = Symbol.for("pi.websocketPatchOriginal");
const GLOBAL_STATE_KEY = Symbol.for("pi.codexCompat.usage.state");
const DEFAULT_STATE_DIR = join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-codex-compat",
);
const STATE_DIR = process.env.PI_CODEX_USAGE_DIR || DEFAULT_STATE_DIR;
const SNAPSHOT_FILE = join(STATE_DIR, "usage.json");
const STATUS_KEY = "codex-usage";
const DISABLE_STATUS_ENV = "PI_CODEX_USAGE_STATUS";
const SOURCE_LABELS: Record<UsageSource, string> = { codex: "Codex" };
const USAGE_SOURCES: readonly UsageSource[] = ["codex"];

let snapshots: UsageSnapshots = readPersistedSnapshots();
let statusContext: ExtensionContext | undefined;
let statusEnabled = !/^(0|false|off|no|disabled)$/i.test(process.env[DISABLE_STATUS_ENV] || "");
let tickTimer: ReturnType<typeof setInterval> | undefined;
let sessionStatsCache: SessionStatsCache | undefined;

type UsageGlobalState = {
  onWebSocketMessage?: (data: unknown) => void;
};

function getGlobalState(): UsageGlobalState {
  const global = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: UsageGlobalState };
  const state = global[GLOBAL_STATE_KEY] ?? {};
  global[GLOBAL_STATE_KEY] = state;
  return state;
}

function websocketPatchStack(value: unknown): string[] {
  if (typeof value !== "function") return [];
  const stack = Reflect.get(value, WEBSOCKET_PATCH_STACK_KEY);
  return Array.isArray(stack) ? stack.filter((item): item is string => typeof item === "string") : [];
}

function isCodexUrl(url: unknown): boolean {
  try {
    let raw: string | undefined;
    if (typeof url === "string") raw = url;
    else if (url instanceof URL) raw = url.toString();
    else raw = (url as { url?: string })?.url;
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
  let raw = "";
  if (typeof value === "number") raw = String(value);
  else if (typeof value === "string") raw = value.trim();
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

export function parseUsageHeaders(headers: HeaderMap | undefined): UsageSnapshot | undefined {
  return parseCodexUsageHeaders(headers);
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isUsageSource(value: unknown): value is UsageSource {
  return value === "codex";
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

// Codex usage is available only from the subscription transport. API-key
// models have token/cost statistics but do not expose the 5h/7d plan windows.
export function currentUsageSource(model: ExtensionContext["model"] | undefined): UsageSource | undefined {
  return model?.api === "openai-codex-responses" ? "codex" : undefined;
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
  if (stack.at(-1) !== WEBSOCKET_PATCH_ID) return;
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
  let pctColor: "dim" | "error" | "warning" = "dim";
  if (remaining !== undefined && remaining <= 10) pctColor = "error";
  else if (remaining !== undefined && remaining <= 25) pctColor = "warning";
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
      "No Codex usage snapshot yet.",
      "The plugin updates passively from x-codex-* response headers and codex.rate_limits WebSocket events. It does not poll usage endpoints.",
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

function usageFromEntry(entry: unknown): AssistantUsage | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: { usage?: AssistantUsage }; usage?: AssistantUsage; message?: { role?: unknown; usage?: AssistantUsage } };
  if (candidate.type === "custom" && candidate.customType === "pi-subagents/usage-v1") return candidate.data?.usage;
  if (candidate.type === "compaction" || candidate.type === "branch_summary") return candidate.usage;
  if (candidate.type !== "message" || !["assistant", "toolResult"].includes(String(candidate.message?.role))) return undefined;
  return candidate.message?.usage;
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

export function computeSessionStats(entries: readonly unknown[]): SessionStats {
  const stats = emptySessionStats();
  const backgroundCharges = new Set<string>();
  for (const entry of entries) {
    if (entry && typeof entry === "object" && "customType" in entry && entry.customType === "pi-subagents/usage-v1") {
      const data = "data" in entry ? entry.data as { childId?: unknown; messageId?: unknown } : undefined;
      if (typeof data?.childId !== "string" || typeof data.messageId !== "string") continue;
      const id = `${data.childId}:${data.messageId}`;
      if (backgroundCharges.has(id)) continue;
      backgroundCharges.add(id);
    }
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
  const cache = sessionStatsCache;
  if (cache && cache.manager === current.manager && cache.entryCount === current.entries.length) return cache.stats;
  const stats = computeSessionStats(current.entries);
  sessionStatsCache = { manager: current.manager, entryCount: current.entries.length, stats };
  return stats;
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
  let modelLabel = "Model: unknown";
  if (model) {
    const provider = model.provider ? ` (${model.provider})` : "";
    const subscription = isSubscription ? " — subscription, $ is notional" : "";
    modelLabel = `Model: ${model.id}${provider}${subscription}`;
  }

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

function updateUsageStatus(ctx: ExtensionContext): void {
  statusContext = ctx;
  const status = statusEnabled && isCodexLikeModel(ctx.model)
    ? formatUsageStatus(ctx.ui.theme, currentUsageSource(ctx.model))
    : undefined;
  ctx.ui.setStatus(STATUS_KEY, status);
  if (status) ensureTickTimer();
  else disposeTickTimer();
}

function ensureTickTimer(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (statusContext) updateUsageStatus(statusContext);
  }, 30_000);
  tickTimer.unref?.();
}

function disposeTickTimer(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = undefined;
}

function recordSnapshot(snapshot: UsageSnapshot): void {
  const previous = snapshots[snapshot.source];
  snapshots[snapshot.source] = {
    ...snapshot,
    planType: snapshot.planType ?? previous?.planType,
    activeLimit: snapshot.activeLimit ?? previous?.activeLimit,
  };
  pruneExpiredSnapshots(Date.now());
  persistSnapshots();
  if (statusContext) updateUsageStatus(statusContext);
}

export default function codexUsage(pi: ExtensionAPI): void {
  const handleWebSocketMessage = (data: unknown) => {
    const snapshot = parseCodexWebSocketMessage(data);
    if (snapshot) recordSnapshot(snapshot);
  };
  installWebSocketCapture();
  getGlobalState().onWebSocketMessage = handleWebSocketMessage;

  pi.on("session_start", async (_event, ctx) => {
    installWebSocketCapture();
    updateUsageStatus(ctx);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    installWebSocketCapture();
    updateUsageStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateUsageStatus(ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    statusContext = ctx;
    const snapshot = parseUsageHeaders(event.headers as HeaderMap | undefined);
    if (snapshot) recordSnapshot(snapshot);
    else updateUsageStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = getGlobalState();
    if (state.onWebSocketMessage === handleWebSocketMessage) state.onWebSocketMessage = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
    sessionStatsCache = undefined;
    disposeTickTimer();
    uninstallWebSocketCapture();
  });

  pi.registerCommand("pi-usage", {
    description: "Show passive Codex usage and control its footer status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "off") {
        statusEnabled = false;
        updateUsageStatus(ctx);
        ctx.ui.notify("Codex usage status disabled for this session", "info");
        return;
      }
      if (command === "on") {
        statusEnabled = true;
        updateUsageStatus(ctx);
        ctx.ui.notify("Codex usage status enabled", "info");
        return;
      }

      ctx.ui.notify(
        [
          formatSessionCostDetails(ctx),
          "",
          formatUsageDetails(),
          "",
          "Commands: /pi-usage | /pi-usage on | /pi-usage off",
          `Disable on startup: ${DISABLE_STATUS_ENV}=off`,
        ].join("\n"),
        "info",
      );
    },
  });
}

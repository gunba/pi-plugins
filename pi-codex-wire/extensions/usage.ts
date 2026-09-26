import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeSessionStats, type SessionStats } from "../../pi-session-usage/index.ts";
import { ALLOWANCE_EVENT } from "./allowance.ts";

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

type SessionStatsCache = {
  manager: unknown;
  entryCount: number;
  stats: SessionStats;
};

const STATUS_KEY = "codex-usage";
const DISABLE_STATUS_ENV = "PI_CODEX_USAGE_STATUS";
const SOURCE_LABELS: Record<UsageSource, string> = { codex: "Codex" };
const USAGE_SOURCES: readonly UsageSource[] = ["codex"];

// Factories can share this module across reloads. Never share captured contexts,
// timers or per-session preferences between extension instances.
type UsageState = {
  directory: string;
  snapshotFile: string;
  snapshots: UsageSnapshots;
  events: ExtensionAPI["events"];
  context?: ExtensionContext;
  enabled: boolean;
  timer?: ReturnType<typeof setInterval>;
  statsCache?: SessionStatsCache;
  disposed: boolean;
  dispose(): void;
};
const statusOwners = new WeakMap<ExtensionAPI["events"], UsageState>();

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

function labelForWindow(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "7d";
  if (minutes && minutes % 60 === 0 && minutes < 24 * 60) return `${minutes / 60}h`;
  if (minutes && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  return fallback;
}

// Wire converts transport observations to allowlisted x-codex-* counters.

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

function pruneExpiredSnapshots(state: UsageState, nowMs = Date.now(), persist = false): void {
  let changed = false;
  for (const source of USAGE_SOURCES) {
    const snapshot = state.snapshots[source];
    if (!snapshot) continue;
    const fresh = freshSnapshot(snapshot, nowMs);
    if (fresh) {
      if (fresh !== snapshot) {
        state.snapshots[source] = fresh;
        changed = true;
      }
    } else {
      delete state.snapshots[source];
      changed = true;
    }
  }
  if (changed && persist) persistSnapshots(state);
}

function readPersistedSnapshots(snapshotFile: string): UsageSnapshots {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, "utf8")) as JsonRecord;
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

function persistSnapshots(state: UsageState): void {
  try {
    mkdirSync(state.directory, { recursive: true });
    writeFileSync(state.snapshotFile, `${JSON.stringify(state.snapshots, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The footer should keep working even when the state directory is unwritable.
  }
}

function snapshotForSource(state: UsageState, source: UsageSource | undefined, nowMs = Date.now()): UsageSnapshot | undefined {
  pruneExpiredSnapshots(state, nowMs, true);
  return source ? state.snapshots[source] : undefined;
}

// Codex usage is available only from the subscription transport. API-key
// models have token/cost statistics but do not expose the 5h/7d plan windows.
export function currentUsageSource(model: ExtensionContext["model"] | undefined): UsageSource | undefined {
  return model?.api === "openai-codex-responses" ? "codex" : undefined;
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

function formatUsageStatus(state: UsageState, theme: ExtensionContext["ui"]["theme"], source: UsageSource | undefined, nowMs = Date.now()): string | undefined {
  const snapshot = snapshotForSource(state, source, nowMs);
  if (!snapshot) return undefined;
  const windows = [styleUsageWindow(snapshot.primary, theme, nowMs), styleUsageWindow(snapshot.secondary, theme, nowMs)].filter(
    (part): part is string => Boolean(part),
  );
  if (windows.length === 0) return undefined;
  return `${theme.fg("dim", SOURCE_LABELS[snapshot.source])} ${windows.join(" ")}`;
}

function formatUsageDetails(state: UsageState, nowMs = Date.now()): string {
  pruneExpiredSnapshots(state, nowMs, true);
  const entries = USAGE_SOURCES.map((source) => state.snapshots[source])
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
  lines.push(`State: ${state.snapshotFile}`);
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

function sessionEntries(ctx: ExtensionContext): { manager: unknown; entries: unknown[] } | undefined {
  const manager = ctx.sessionManager as unknown as { getEntries?: () => unknown[] };
  const entries = manager.getEntries?.();
  return entries ? { manager, entries } : undefined;
}

function cachedSessionStats(ctx: ExtensionContext, state: UsageState): SessionStats {
  const current = sessionEntries(ctx);
  if (!current) return computeSessionStats([]);
  const cache = state.statsCache;
  if (cache && cache.manager === current.manager && cache.entryCount === current.entries.length) return cache.stats;
  const stats = computeSessionStats(current.entries);
  state.statsCache = { manager: current.manager, entryCount: current.entries.length, stats };
  return stats;
}

function formatSessionCostDetails(ctx: ExtensionContext, state: UsageState): string {
  const stats = cachedSessionStats(ctx, state);
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

function updateUsageStatus(ctx: ExtensionContext, state: UsageState): void {
  if (state.disposed) return;
  const model = ctx.model, ui = ctx.ui;
  const status = state.enabled
    ? formatUsageStatus(state, ui.theme, currentUsageSource(model))
    : undefined;
  ui.setStatus(STATUS_KEY, status);
  statusOwners.set(state.events, state);
  // Do not retain a stale ctx if any of its guarded getters or UI calls failed.
  if (state.disposed) return;
  state.context = ctx;
  if (status) ensureTickTimer(state);
  else disposeTickTimer(state);
}

function refreshUsageStatus(state: UsageState): void {
  if (state.disposed || !state.context) return;
  try {
    updateUsageStatus(state.context, state);
  } catch (error) {
    // SDK invalidation/disposal need not emit shutdown. An optional footer
    // must stop, rather than throw an uncaught exception from a timer/socket.
    state.dispose();
    if (!(error instanceof Error && error.message.includes("extension ctx is stale"))) {
      console.warn("Codex usage footer disabled after a status update failed:", error);
    }
  }
}

function ensureTickTimer(state: UsageState): void {
  if (state.timer || state.disposed) return;
  state.timer = setInterval(() => refreshUsageStatus(state), 30_000);
  state.timer.unref?.();
}

function disposeTickTimer(state: UsageState): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = undefined;
}

function recordSnapshot(snapshot: UsageSnapshot, state: UsageState): void {
  if (state.disposed) return;
  const previous = state.snapshots[snapshot.source];
  state.snapshots[snapshot.source] = {
    ...snapshot,
    planType: snapshot.planType ?? previous?.planType,
    activeLimit: snapshot.activeLimit ?? previous?.activeLimit,
  };
  pruneExpiredSnapshots(state, Date.now());
  persistSnapshots(state);
  refreshUsageStatus(state);
}

export default function codexUsage(pi: ExtensionAPI): void {
  const directory = process.env.PI_CODEX_USAGE_DIR || join(getAgentDir(), "codex-wire");
  const snapshotFile = join(directory, "usage.json");
  const state: UsageState = {
    directory,
    snapshotFile,
    snapshots: readPersistedSnapshots(snapshotFile),
    events: pi.events,
    enabled: !/^(0|false|off|no|disabled)$/i.test(process.env[DISABLE_STATUS_ENV] || ""),
    disposed: false,
    dispose,
  };
  const unsubscribeWire = pi.events.on(ALLOWANCE_EVENT, data => {
    if (state.disposed) return;
    const snapshot = parseUsageHeaders(recordValue(data));
    if (snapshot) recordSnapshot(snapshot, state);
  });

  function dispose(): void {
    if (state.disposed) return;
    state.disposed = true;
    disposeTickTimer(state);
    state.context = undefined;
    state.statsCache = undefined;
    if (statusOwners.get(pi.events) === state) statusOwners.delete(pi.events);
    unsubscribeWire();
  }

  pi.on("session_start", (_event, ctx) => {
    if (state.disposed) return;
    updateUsageStatus(ctx, state);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (state.disposed) return;
    updateUsageStatus(ctx, state);
  });

  pi.on("model_select", (_event, ctx) => {
    updateUsageStatus(ctx, state);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (state.disposed) return;
    const ownsStatus = statusOwners.get(pi.events) === state;
    // Release resources before touching UI: a stale/failed UI cannot skip cleanup.
    dispose();
    if (ownsStatus) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("pi-usage", {
    description: "Show passive Codex usage and control its footer status",
    handler: async (args, ctx) => {
      if (state.disposed) return;
      const command = args.trim().toLowerCase();
      if (command === "off") {
        state.enabled = false;
        updateUsageStatus(ctx, state);
        ctx.ui.notify("Codex usage status disabled for this session", "info");
        return;
      }
      if (command === "on") {
        state.enabled = true;
        updateUsageStatus(ctx, state);
        ctx.ui.notify("Codex usage status enabled", "info");
        return;
      }

      ctx.ui.notify(
        [
          formatSessionCostDetails(ctx, state),
          "",
          formatUsageDetails(state),
          "",
          "Commands: /pi-usage | /pi-usage on | /pi-usage off",
          `Disable on startup: ${DISABLE_STATUS_ENV}=off`,
        ].join("\n"),
        "info",
      );
    },
  });
}

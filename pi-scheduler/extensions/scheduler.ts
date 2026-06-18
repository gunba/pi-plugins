import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-scheduler";
const BASE_DIR = process.env.PI_SCHEDULER_DIR || join(homedir(), ".pi", "agent", "scheduler");
const STORE_FILE = join(BASE_DIR, "scheduled-messages.json");
const TICK_MS = 5_000;
const MAX_WIDGET_ROWS = 4;
const MAX_MESSAGE_PREVIEW = 90;
const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
const WIDGET_PLACEMENT = process.env.PI_SCHEDULER_WIDGET_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor";

type ScheduledMessage = {
  id: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  createdAt: number;
  dueAt: number;
  message: string;
};

type StoreFile = {
  version: 1;
  messages: ScheduledMessage[];
};

let activeCtx: ExtensionContext | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let sendingDue = false;

function ensureDir(): void {
  mkdirSync(BASE_DIR, { recursive: true });
}

function readStore(): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Partial<StoreFile>;
    if (parsed.version === 1 && Array.isArray(parsed.messages)) {
      return { version: 1, messages: parsed.messages.filter(isScheduledMessage) };
    }
  } catch {
    // Missing or corrupt stores should not break Pi startup.
  }
  return { version: 1, messages: [] };
}

function writeStore(store: StoreFile): void {
  ensureDir();
  writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

function isScheduledMessage(value: unknown): value is ScheduledMessage {
  const v = value as ScheduledMessage;
  return !!v
    && typeof v.id === "string"
    && typeof v.sessionId === "string"
    && (v.sessionFile === undefined || typeof v.sessionFile === "string")
    && typeof v.cwd === "string"
    && Number.isFinite(v.createdAt)
    && Number.isFinite(v.dueAt)
    && typeof v.message === "string";
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function sessionMessages(ctx: ExtensionContext): ScheduledMessage[] {
  const id = sessionId(ctx);
  return readStore().messages
    .filter((message) => message.sessionId === id)
    .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

function parseDelay(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = Math.round(value * multiplier);
  if (ms <= 0 || ms > MAX_DELAY_MS) return undefined;
  return ms;
}

function scheduleMessage(ctx: ExtensionContext, delayMs: number, message: string): ScheduledMessage {
  const store = readStore();
  const now = Date.now();
  const entry: ScheduledMessage = {
    id: uniqueId(store.messages),
    sessionId: sessionId(ctx),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    createdAt: now,
    dueAt: now + delayMs,
    message,
  };
  store.messages.push(entry);
  writeStore(store);
  return entry;
}

function uniqueId(existing: ScheduledMessage[]): string {
  const used = new Set(existing.map((message) => message.id));
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!used.has(id)) return id;
  }
}

function cancelMessages(ctx: ExtensionContext, selector: string): { cancelled: ScheduledMessage[]; ambiguous: boolean } {
  const normalized = selector.trim().replace(/^#/, "");
  const store = readStore();
  const currentSessionId = sessionId(ctx);
  const sessionEntries = store.messages.filter((message) => message.sessionId === currentSessionId);

  let cancelled: ScheduledMessage[] = [];
  let ambiguous = false;
  if (/^(all|clear)$/i.test(normalized)) {
    cancelled = sessionEntries;
  } else {
    const matches = sessionEntries.filter((message) => message.id.startsWith(normalized));
    if (matches.length > 1) ambiguous = true;
    else cancelled = matches;
  }

  if (cancelled.length > 0 && !ambiguous) {
    const cancelledIds = new Set(cancelled.map((message) => message.id));
    writeStore({ version: 1, messages: store.messages.filter((message) => !cancelledIds.has(message.id)) });
  }
  return { cancelled, ambiguous };
}

function dueMessages(ctx: ExtensionContext): ScheduledMessage[] {
  const now = Date.now();
  return sessionMessages(ctx).filter((message) => message.dueAt <= now);
}

function removeMessages(messages: ScheduledMessage[]): void {
  if (!messages.length) return;
  const ids = new Set(messages.map((message) => message.id));
  const store = readStore();
  writeStore({ version: 1, messages: store.messages.filter((message) => !ids.has(message.id)) });
}

function deliverDue(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (sendingDue) return;
  const due = dueMessages(ctx);
  if (!due.length) return;

  sendingDue = true;
  try {
    removeMessages(due);
    due.forEach((entry, index) => {
      ctx.ui.notify(`Sending scheduled message #${entry.id}`, "info");
      if (index === 0 && ctx.isIdle()) pi.sendUserMessage(entry.message);
      else pi.sendUserMessage(entry.message, { deliverAs: "followUp" });
    });
  } catch (error) {
    ctx.ui.notify(`Scheduled message delivery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    sendingDue = false;
    refreshWidget(ctx);
  }
}

function refreshWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const messages = sessionMessages(ctx);
  if (!messages.length) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme): Component => ({
    render: (width: number) => schedulerWidgetLines(theme, width, messages),
    invalidate() {},
  }), { placement: WIDGET_PLACEMENT });
}

function schedulerWidgetLines(theme: Theme, width: number, messages: ScheduledMessage[]): string[] {
  const W = Math.max(46, Math.min(width, 140));
  const rowWidth = WIDGET_PLACEMENT === "belowEditor" ? W : W - 4;
  const rows = messages.slice(0, MAX_WIDGET_ROWS).map((message) => scheduledRow(theme, rowWidth, message));
  if (messages.length > MAX_WIDGET_ROWS) {
    rows.push(theme.fg("dim", `… ${messages.length - MAX_WIDGET_ROWS} more scheduled (/schedule list)`));
  }
  rows.push(theme.fg("dim", "Ctrl+Alt+S list · /schedule cancel <id> · /schedule clear"));
  if (WIDGET_PLACEMENT === "belowEditor") return compactLines(theme, W, "Scheduled messages", rows);
  return boxLines(theme, W, "Scheduled messages", rows);
}

function compactLines(theme: Theme, width: number, label: string, rows: string[]): string[] {
  const prefix = `${theme.bold(theme.fg("accent", label))} ${theme.fg("dim", "·")}`;
  const first = rows[0] ? `${prefix} ${rows[0]}` : prefix;
  return [truncateToWidth(first, width), ...rows.slice(1).map((row) => truncateToWidth(`  ${row}`, width))];
}

function scheduledRow(theme: Theme, width: number, message: ScheduledMessage): string {
  const left = `${theme.fg("accent", `#${message.id}`)} ${theme.fg("success", formatRemaining(message.dueAt))}`;
  const at = theme.fg("dim", formatDueAt(message.dueAt));
  const previewWidth = Math.max(12, width - visibleWidth(left) - visibleWidth(at) - 6);
  const preview = truncateToWidth(message.message.replace(/\s+/g, " ").trim(), Math.min(MAX_MESSAGE_PREVIEW, previewWidth));
  return `${left} ${theme.fg("text", preview)} ${at}`;
}

function boxLines(theme: Theme, width: number, label: string, rows: string[]): string[] {
  const inner = width - 4;
  const B = (value: string) => theme.fg("borderAccent", value);
  const lead = "╭─ ";
  const dashes = Math.max(0, width - 1 - visibleWidth(lead) - visibleWidth(label) - 1);
  const top = B(lead) + theme.bold(theme.fg("accent", label)) + " " + B("─".repeat(dashes) + "╮");
  const body = rows.map((row) => `${B("│")} ${padTo(row, inner)} ${B("│")}`);
  return [top, ...body, B(`╰${"─".repeat(width - 2)}╯`)];
}

function padTo(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(pad)}`;
}

function formatRemaining(dueAt: number): string {
  const remaining = Math.max(0, dueAt - Date.now());
  if (remaining === 0) return "due now";
  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m ${seconds}s`;
  return `in ${seconds}s`;
}

function formatDueAt(dueAt: number): string {
  return new Date(dueAt).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function notifyScheduleList(ctx: ExtensionContext): void {
  const messages = sessionMessages(ctx);
  if (!messages.length) {
    ctx.ui.notify("No scheduled messages for this session.", "info");
    return;
  }
  const lines = messages.map((message) => `#${message.id} ${formatRemaining(message.dueAt)} (${formatDueAt(message.dueAt)}): ${message.message}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function usage(ctx: ExtensionContext, type: "info" | "error" = "error"): void {
  ctx.ui.notify("Usage: /schedule <15m|5h|5.5h|30d> <message> · /schedule list · /schedule cancel <id> · /schedule clear", type);
}

function startTicker(pi: ExtensionAPI, ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (tickTimer) clearInterval(tickTimer);
  deliverDue(pi, ctx);
  refreshWidget(ctx);
  tickTimer = setInterval(() => {
    if (!activeCtx) return;
    deliverDue(pi, activeCtx);
    refreshWidget(activeCtx);
  }, TICK_MS);
}

function stopTicker(ctx?: ExtensionContext): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = undefined;
  const current = ctx ?? activeCtx;
  activeCtx = undefined;
  current?.ui.setWidget(WIDGET_KEY, undefined);
}

export default function (pi: ExtensionAPI): void {
  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Show scheduled messages",
    handler: async (ctx) => {
      notifyScheduleList(ctx);
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("schedule", {
    description: "Schedule a user message for later, e.g. /schedule 5.5h check usage reset",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || /^list$/i.test(trimmed)) {
        notifyScheduleList(ctx);
        refreshWidget(ctx);
        return;
      }
      if (/^help$/i.test(trimmed)) {
        usage(ctx, "info");
        return;
      }
      if (/^(clear|cancel\s+all)$/i.test(trimmed)) {
        const { cancelled } = cancelMessages(ctx, "all");
        ctx.ui.notify(cancelled.length ? `Cancelled ${cancelled.length} scheduled message${cancelled.length === 1 ? "" : "s"}.` : "No scheduled messages to cancel.", "info");
        refreshWidget(ctx);
        return;
      }
      const cancelMatch = trimmed.match(/^cancel\s+(\S+)$/i);
      if (cancelMatch) {
        const { cancelled, ambiguous } = cancelMessages(ctx, cancelMatch[1]!);
        if (ambiguous) ctx.ui.notify(`Schedule id ${cancelMatch[1]} is ambiguous; use more characters.`, "error");
        else if (cancelled.length) ctx.ui.notify(`Cancelled scheduled message #${cancelled[0]!.id}.`, "info");
        else ctx.ui.notify(`No scheduled message matched ${cancelMatch[1]}.`, "error");
        refreshWidget(ctx);
        return;
      }

      const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        usage(ctx);
        return;
      }
      const delayMs = parseDelay(match[1]!);
      const message = match[2]!.trim();
      if (!delayMs || !message) {
        usage(ctx);
        return;
      }

      const entry = scheduleMessage(ctx, delayMs, message);
      ctx.ui.notify(`Scheduled #${entry.id} ${formatRemaining(entry.dueAt)} (${formatDueAt(entry.dueAt)}).`, "info");
      refreshWidget(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") startTicker(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker(ctx);
  });
}

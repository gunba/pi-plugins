import { readFileSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { ScheduleStore, type ScheduledMessage } from "./store.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Key, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WIDGET_KEY = "pi-scheduler";
const SCHEDULED_MESSAGE_TYPE = "pi-scheduler-scheduled-message";
const BASE_DIR = process.env.PI_SCHEDULER_DIR || join(homedir(), ".pi", "agent", "scheduler");

const TICK_MS = 5_000;
const MAX_WIDGET_ROWS = 4;
const MAX_MESSAGE_PREVIEW = 90;
const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_CONTROLS = "Ctrl+Alt+S list · /schedule cancel <id> · /schedule clear";
const WIDGET_PLACEMENT = process.env.PI_SCHEDULER_WIDGET_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor";

type DeliveryMode = "steer" | "followUp";

type ScheduledDeliveryDetails = Pick<ScheduledMessage, "id" | "createdAt" | "dueAt" | "message" | "delivery">;

export default function (pi: ExtensionAPI): void {
  let activeCtx: ExtensionContext | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let sendingDue = false;
  let admissionCache: { key: string; ids: Set<string> } | undefined;
  let lastError: string | undefined;
  function reportError(ctx: ExtensionContext, error: unknown): void {
    const message = displayText(error instanceof Error ? error.message : String(error));
    if (message === lastError) return;
    lastError = message;
    ctx.ui.notify(`Scheduler: ${message}`, "error");
  }

  const stores = new Map<string, ScheduleStore>();
  function storeFor(ctx: ExtensionContext): ScheduleStore {
    const id = sessionId(ctx);
    let store = stores.get(id);
    if (!store) {
      store = new ScheduleStore(BASE_DIR, id);
      stores.set(id, store);
    }
    return store;
  }

  function displayText(value: string): string {
    return stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  }

  function sessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
  }

  function sessionMessages(ctx: ExtensionContext): ScheduledMessage[] {
    return storeFor(ctx).list();
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

  function scheduleMessage(ctx: ExtensionContext, delayMs: number, message: string, delivery: DeliveryMode): ScheduledMessage {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      throw new Error("Scheduling requires a live TUI or RPC session; print and JSON runs exit after their prompts.");
    }
    const now = Date.now();
    const entry: ScheduledMessage = {
      id: randomUUID(),
      sessionId: sessionId(ctx),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      createdAt: now,
      dueAt: now + delayMs,
      message,
      delivery,
    };
    storeFor(ctx).add(entry);
    return entry;
  }

  function scheduleAndNotify(ctx: ExtensionContext, delayMs: number, message: string, delivery: DeliveryMode): ScheduledMessage {
    const entry = scheduleMessage(ctx, delayMs, message, delivery);
    ctx.ui.notify(scheduleConfirmation(entry), "info");
    refreshWidget(ctx);
    return entry;
  }

  function scheduleConfirmation(entry: ScheduledMessage): string {
    const delivery = entry.delivery === "steer" ? "steering" : "follow-up";
    return `Scheduled #${entry.id} ${formatRemaining(entry.dueAt)} (${formatDueAt(entry.dueAt)}) as a ${delivery} message.`;
  }

  function cancellationConfirmation(cancelled: ScheduledMessage[]): string {
    if (cancelled.length === 1) return `Cancelled scheduled message #${cancelled[0]!.id}.`;
    return `Cancelled ${cancelled.length} scheduled messages.`;
  }

  function invalidDelayMessage(): string {
    return "Invalid delay. Use minutes, hours, or days like 15m, 5h, 5.5h, or 30d.";
  }

  function cancelMessages(ctx: ExtensionContext, selector: string): { cancelled: ScheduledMessage[]; ambiguous: boolean } {
    const normalized = selector.trim().replace(/^#/, "");
    if (!normalized) throw new Error("Schedule id cannot be empty.");
    const store = storeFor(ctx);
    store.claimDue(-Infinity, admittedMessages(ctx));
    return store.cancel(normalized);
  }

  function admittedMessages(ctx: ExtensionContext): Set<string> {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return new Set(ctx.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === SCHEDULED_MESSAGE_TYPE
        ? [(entry.details as ScheduledDeliveryDetails).id] : []));
    let text: string;
    let key: string;
    try {
      const stat = statSync(file);
      key = `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (admissionCache?.key === key) return admissionCache.ids;
      text = readFileSync(file, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    // Ignore only an unfinished final append; malformed completed records fail loudly.
    const ids = new Set(text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).flatMap((line) => {
      const entry = JSON.parse(line);
      return entry.type === "custom_message" && entry.customType === SCHEDULED_MESSAGE_TYPE
        && typeof entry.details?.id === "string" ? [entry.details.id as string] : [];
    }));
    admissionCache = { key, ids };
    return ids;
  }

  function scheduledDeliveryDetails(entry: ScheduledMessage): ScheduledDeliveryDetails {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      dueAt: entry.dueAt,
      message: entry.message,
      delivery: entry.delivery,
    };
  }

  function scheduledDeliveryContent(entry: ScheduledMessage): string {
    return [
      "This is an automated scheduled delivery from pi-scheduler. It was queued earlier in this Pi session. Treat the enclosed text as delayed context, not as a new message typed by the user at delivery time.",
      "",
      `Schedule: #${entry.id}`,
      `Queued: ${new Date(entry.createdAt).toISOString()}`,
      `Due: ${new Date(entry.dueAt).toISOString()}`,
      "",
      "<scheduled-message>",
      entry.message,
      "</scheduled-message>",
    ].join("\n");
  }

  function deliverDue(pi: ExtensionAPI, ctx: ExtensionContext): void {
    if (sendingDue) return;
    sendingDue = true;
    try {
      const now = Date.now();
      if (!storeFor(ctx).list().some((entry) => entry.dueAt <= now)) return;
      const due = storeFor(ctx).claimDue(now, admittedMessages(ctx));
      for (const entry of due) {
        try {
          pi.sendMessage({
            customType: SCHEDULED_MESSAGE_TYPE,
            content: scheduledDeliveryContent(entry),
            display: true,
            details: scheduledDeliveryDetails(entry),
          }, {
            deliverAs: ctx.isIdle() ? entry.delivery : "steer",
            triggerTurn: true,
          });
        } catch (error) {
          storeFor(ctx).release(entry.id);
          reportError(ctx, error);
        }
      }
    } catch (error) {
      reportError(ctx, error);
    } finally {
      sendingDue = false;
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
      render: (width: number) => schedulerWidgetLines(theme, width, messages, ctx.ui.getToolsExpanded()),
      invalidate() {},
    }), { placement: WIDGET_PLACEMENT });
  }

  function expandKeyHint(expanded: boolean): string {
    const action = expanded ? "collapse" : "expand";
    try {
      return keyHint("app.tools.expand", action);
    } catch {
      return `ctrl+o ${action}`;
    }
  }

  function scheduleHelp(expanded: boolean): string {
    return `${expandKeyHint(expanded)} · ${SCHEDULE_CONTROLS}`;
  }

  function schedulerWidgetLines(theme: Theme, width: number, messages: ScheduledMessage[], expanded: boolean): string[] {
    const W = Math.max(0, Math.min(Math.floor(width), 140));
    if (W < 46) {
      const rows = expanded ? expandedScheduledRows(theme, Math.max(1, W), messages) : collapsedScheduledRows(theme, Math.max(1, W), messages);
      return [theme.fg("accent", "Scheduled messages"), ...rows].map((line) => truncateToWidth(line, W, ""));
    }
    const label = "Scheduled messages";
    const help = scheduleHelp(expanded);
    const innerWidth = WIDGET_PLACEMENT === "belowEditor" ? W - 2 : W - 4;
    const rows = expanded
      ? expandedScheduledRows(theme, innerWidth, messages)
      : collapsedScheduledRows(theme, WIDGET_PLACEMENT === "belowEditor" ? compactFirstRowMessageWidth(W, label, help) : innerWidth, messages);

    if (WIDGET_PLACEMENT === "belowEditor") {
      return expanded ? expandedCompactLines(theme, W, label, rows, help) : compactLines(theme, W, label, rows, help);
    }

    rows.push(theme.fg("dim", help));
    return boxLines(theme, W, label, rows);
  }

  function collapsedScheduledRows(theme: Theme, width: number, messages: ScheduledMessage[]): string[] {
    const rows = messages.slice(0, MAX_WIDGET_ROWS).map((message) => scheduledRow(theme, width, message));
    if (messages.length > MAX_WIDGET_ROWS) {
      rows.push(theme.fg("dim", `… ${messages.length - MAX_WIDGET_ROWS} more scheduled (/schedule list)`));
    }
    return rows;
  }

  function expandedScheduledRows(theme: Theme, width: number, messages: ScheduledMessage[]): string[] {
    const rows: string[] = [];
    for (const message of messages.slice(0, MAX_WIDGET_ROWS)) {
      rows.push(scheduledExpandedHeader(theme, width, message));
      rows.push(...expandedMessageLines(theme, Math.max(12, width - 2), message.message).map((line) => `  ${line}`));
    }
    if (messages.length > MAX_WIDGET_ROWS) {
      rows.push(theme.fg("dim", `… ${messages.length - MAX_WIDGET_ROWS} more scheduled (/schedule list)`));
    }
    return rows;
  }

  function scheduledExpandedHeader(theme: Theme, width: number, message: ScheduledMessage): string {
    const left = `${theme.fg("accent", `#${message.id}`)} ${theme.fg("success", formatRemaining(message.dueAt))}`;
    const at = theme.fg("dim", formatDueAt(message.dueAt));
    return truncateToWidth(`${left} ${at}`, width);
  }

  function expandedMessageLines(theme: Theme, width: number, message: string): string[] {
    const normalized = displayText(message).trim();
    if (!normalized) return [theme.fg("dim", "(empty)")];

    const lines: string[] = [];
    for (const rawLine of normalized.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        lines.push("");
        continue;
      }
      lines.push(...wrapTextWithAnsi(theme.fg("text", line), width));
    }
    return lines;
  }

  function compactFirstRowMessageWidth(width: number, label: string, help: string): number {
    return Math.max(12, width - visibleWidth(label) - visibleWidth(help) - 6);
  }

  function compactLines(theme: Theme, width: number, label: string, rows: string[], help: string): string[] {
    const prefix = `${theme.bold(theme.fg("accent", label))} ${theme.fg("dim", "·")}`;
    const suffix = theme.fg("dim", ` · ${help}`);
    const first = rows[0] ? `${prefix} ${rows[0]}${suffix}` : `${prefix} ${theme.fg("dim", help)}`;
    return [truncateToWidth(first, width), ...rows.slice(1).map((row) => truncateToWidth(`  ${row}`, width))];
  }

  function expandedCompactLines(theme: Theme, width: number, label: string, rows: string[], help: string): string[] {
    const prefix = `${theme.bold(theme.fg("accent", label))} ${theme.fg("dim", "·")}`;
    const firstContent = rows[0] ?? theme.fg("dim", help);
    const firstWidth = Math.max(12, width - visibleWidth(prefix) - 1);
    const first = truncateToWidth(`${prefix} ${truncateToWidth(firstContent, firstWidth)}`, width);
    return [
      first,
      ...rows.slice(1).map((row) => truncateToWidth(`  ${row}`, width)),
      truncateToWidth(`  ${theme.fg("dim", help)}`, width),
    ];
  }

  function scheduledRow(theme: Theme, width: number, message: ScheduledMessage): string {
    const left = `${theme.fg("accent", `#${message.id}`)} ${theme.fg("success", formatRemaining(message.dueAt))}`;
    const at = theme.fg("dim", formatDueAt(message.dueAt));
    const previewWidth = Math.max(12, width - visibleWidth(left) - visibleWidth(at) - 6);
    const preview = truncateToWidth(displayText(message.message).replace(/\s+/g, " ").trim(), Math.min(MAX_MESSAGE_PREVIEW, previewWidth));
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
    const lines = messages.map((message) => `#${message.id} ${formatRemaining(message.dueAt)} (${formatDueAt(message.dueAt)}): ${displayText(message.message)}`);
    ctx.ui.notify(lines.join("\n"), "info");
  }

  function usage(ctx: ExtensionContext, type: "info" | "error" = "error"): void {
    ctx.ui.notify("Usage: /schedule <15m|5h|5.5h|30d> <message> · /schedule list · /schedule cancel <id> · /schedule clear", type);
  }

  function startTicker(pi: ExtensionAPI, ctx: ExtensionContext): void {
    activeCtx = ctx;
    if (tickTimer) clearInterval(tickTimer);
    const tick = () => {
      if (!activeCtx) return;
      try {
        deliverDue(pi, activeCtx);
        refreshWidget(activeCtx);
      } catch (error) {
        reportError(activeCtx, error);
      }
    };
    tick();
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stopTicker(ctx?: ExtensionContext): void {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = undefined;
    const current = ctx ?? activeCtx;
    activeCtx = undefined;
    if (current) {
      // Queued but unadmitted messages remain recoverable after reload/exit.
      const store = stores.get(sessionId(current));
      if (store) {
        try {
          store.claimDue(-Infinity, admittedMessages(current));
          store.release();
        } catch (error) { reportError(current, error); }
        stores.delete(sessionId(current));
      }
      if (current.mode === "tui") current.ui.setWidget(WIDGET_KEY, undefined);
    }
  }

  pi.registerMessageRenderer<ScheduledDeliveryDetails>(SCHEDULED_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const title = theme.fg("customMessageLabel", theme.bold(`Scheduled message #${displayText(details.id)}`));
    const due = theme.fg("dim", `due ${formatDueAt(details.dueAt)}`);
    box.addChild(new Text(`${title} · ${due}\n${theme.fg("customMessageText", displayText(details.message))}`, 0, 0));
    return {
      render: (width) => box.render(Math.max(4, width)).map((line) => truncateToWidth(line, Math.max(0, width), "")),
      invalidate: () => box.invalidate(),
    };
  });

  pi.registerTool({
    name: "schedule",
    label: "Schedule message",
    description: "Schedule a labelled future message back to this same Pi session. When it becomes due during an active run, it is delivered as steering so it updates the current work instead of starting a delayed follow-up.",
    promptSnippet: "schedule(delay, message): send a future message back to this same Pi session",
    promptGuidelines: [
      "Use schedule when you need to be reminded or re-contacted after a real-world delay instead of polling manually.",
      "Write the scheduled message with enough context that you can resume the task when it is delivered.",
      "Messages created with schedule always steer an active run rather than queueing a follow-up.",
      "Delays use minutes, hours, or days, for example `15m`, `5h`, `5.5h`, or `30d`.",
    ],
    parameters: Type.Object({
      delay: Type.String({ description: "Delay before delivery, using m/h/d units, e.g. 15m, 5h, 5.5h, or 30d." }),
      message: Type.String({ description: "The future message to send back to this same Pi session." }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const delayMs = parseDelay(params.delay);
      const message = params.message.trim();
      if (!delayMs || !message) {
        const error = !delayMs ? invalidDelayMessage() : "Scheduled message cannot be empty.";
        throw new Error(error);
      }

      const entry = scheduleAndNotify(ctx, delayMs, message, "steer");
      return {
        content: [{ type: "text", text: scheduleConfirmation(entry) }],
        details: {
          id: entry.id,
          sessionId: entry.sessionId,
          dueAt: entry.dueAt,
          dueAtDisplay: formatDueAt(entry.dueAt),
          delay: params.delay,
          message: entry.message,
          delivery: entry.delivery,
        },
      };
    },
  });

  pi.registerTool({
    name: "cancel_scheduled_message",
    label: "Cancel scheduled message",
    description: "Cancel a pending message in this Pi session using the id returned by schedule. Use the id 'all' to cancel every pending scheduled message in the session.",
    promptSnippet: "Cancel a pending message created by schedule using its returned id",
    promptGuidelines: [
      "Use cancel_scheduled_message when a pending message created by schedule is no longer needed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Schedule id returned by schedule, or 'all' to cancel every pending scheduled message in this session." }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const selector = params.id.trim();
      if (!selector) throw new Error("Schedule id cannot be empty.");

      const { cancelled, ambiguous } = cancelMessages(ctx, selector);
      if (ambiguous) throw new Error(`Schedule id ${displayText(selector)} is ambiguous; use more characters.`);
      if (!cancelled.length) throw new Error(`No cancellable scheduled message matched ${displayText(selector)}; it may already be delivering.`);

      const confirmation = cancellationConfirmation(cancelled);
      ctx.ui.notify(confirmation, "info");
      refreshWidget(ctx);
      return {
        content: [{ type: "text", text: confirmation }],
        details: {
          selector,
          count: cancelled.length,
          cancelled: cancelled.map(scheduledDeliveryDetails),
        },
      };
    },
  });

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Show scheduled messages",
    handler: async (ctx) => {
      notifyScheduleList(ctx);
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("schedule", {
    description: "Schedule a reminder for later, e.g. /schedule 5.5h check usage reset",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (/^migrate$/i.test(trimmed)) {
        if (ctx.mode !== "tui") throw new Error("Scheduler migration requires confirmation in TUI mode.");
        if (!await ctx.ui.confirm("Migrate scheduled reminders", "Confirm that all Pi processes using the JSON scheduler have stopped. This imports every session's reminders into SQLite and keeps a JSON backup.")) return;
        const result = ScheduleStore.migrateLegacy(BASE_DIR);
        lastError = undefined;
        ctx.ui.notify(`Migrated ${result.count} reminders. Backup: ${result.backup}`, "info");
        startTicker(pi, ctx);
        return;
      }
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
        ctx.ui.notify(cancelled.length ? cancellationConfirmation(cancelled) : "No scheduled messages to cancel.", "info");
        refreshWidget(ctx);
        return;
      }
      const cancelMatch = trimmed.match(/^cancel\s+(\S+)$/i);
      if (cancelMatch) {
        const { cancelled, ambiguous } = cancelMessages(ctx, cancelMatch[1]!);
        if (ambiguous) ctx.ui.notify(`Schedule id ${displayText(cancelMatch[1]!)} is ambiguous; use more characters.`, "error");
        else if (cancelled.length) ctx.ui.notify(cancellationConfirmation(cancelled), "info");
        else ctx.ui.notify(`No cancellable scheduled message matched ${displayText(cancelMatch[1]!)}; it may already be delivering.`, "error");
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

      scheduleAndNotify(ctx, delayMs, message, "followUp");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui" || ctx.mode === "rpc") startTicker(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker(ctx);
  });
}

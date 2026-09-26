import { stripVTControlCharacters } from "node:util";
import { ScheduleStore, type ScheduledMessage } from "./store.ts";
import { DeliveryReceipts, SCHEDULED_MESSAGE_TYPE } from "./receipts.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Key, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ensureWorkCoordination, registerWorkResource, completeWorkResource, getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { ensureWorkUi, type WorkUiSource } from "../../pi-work-ui/index.ts";
import { scheduledWorkSection } from "./presentation.ts";

const BASE_DIR = process.env.PI_SCHEDULER_DIR || join(homedir(), ".pi", "agent", "scheduler");

const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;

type DeliveryMode = "steer" | "followUp";

type ScheduledDeliveryDetails = Pick<ScheduledMessage, "id" | "createdAt" | "dueAt" | "message" | "delivery">;

export default function (pi: ExtensionAPI): void {
  ensureWorkCoordination(pi);
  const workUi = ensureWorkUi(pi);
  let source: WorkUiSource | undefined;
  let activeCtx: ExtensionContext | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  const attempted = new Set<string>();
  let timerEpoch = 0;
  let sendingDue = false;
  const receipts = new DeliveryReceipts();
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
    registerWorkResource(sessionId(ctx), { kind: "timer", id: entry.id });
    armTimer(ctx);
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

  function cancelMessages(ctx: ExtensionContext, selector: string): { cancelled: ScheduledMessage[]; ambiguous: boolean; alreadyDelivered: boolean } {
    const normalized = selector.trim().replace(/^#/, "");
    if (!normalized) throw new Error("Schedule id cannot be empty.");
    const store = storeFor(ctx);
    const admitted = admittedMessages(ctx);
    store.claimDue(-Infinity, admitted);
    for (const id of admitted) attempted.delete(id);
    const result = store.cancel(normalized);
    for (const entry of result.cancelled)
      completeWorkResource(sessionId(ctx), { kind: "timer", id: entry.id }, `Scheduled timer #${entry.id} was cancelled.`);
    armTimer(ctx);
    refreshWidget(ctx);
    return { ...result, alreadyDelivered: admitted.has(normalized) };
  }

  function admittedMessages(ctx: ExtensionContext): ReadonlySet<string> {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return new Set(ctx.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== SCHEDULED_MESSAGE_TYPE) return [];
      const details = entry.details as Partial<ScheduledDeliveryDetails> | undefined;
      return typeof details?.id === "string" ? [details.id] : [];
    }));
    return receipts.read(file);
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

  function reconcileAdmissions(ctx: ExtensionContext): void {
    if (!attempted.size || !activeCtx || sessionId(activeCtx) !== sessionId(ctx)) return;
    const admitted = admittedMessages(ctx);
    const confirmed = new Set([...attempted].filter(id => admitted.has(id)));
    if (!confirmed.size) return;
    storeFor(ctx).claimDue(-Infinity, confirmed);
    for (const id of confirmed) attempted.delete(id);
    refreshWidget(ctx);
    armTimer(ctx);
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
      const store = storeFor(ctx);
      const overdue = store.list().filter(entry => entry.dueAt <= now);
      if (!overdue.length) return;
      // A failed receipt read must not create an immediate retry loop.
      for (const entry of overdue) attempted.add(entry.id);
      const admitted = admittedMessages(ctx);
      const due = store.claimDue(now, admitted);
      for (const entry of overdue) {
        if (admitted.has(entry.id)) attempted.delete(entry.id);
      }
      for (const entry of due) {
        attempted.add(entry.id);
        try {
          const matched = completeWorkResource(sessionId(ctx), { kind: "timer", id: entry.id }, scheduledDeliveryContent(entry), { notify: false });
          pi.sendMessage({
            customType: SCHEDULED_MESSAGE_TYPE,
            content: scheduledDeliveryContent(entry),
            display: true,
            details: scheduledDeliveryDetails(entry),
          }, {
            deliverAs: ctx.isIdle() ? entry.delivery : "steer",
            triggerTurn: matched || !getWorkCoordinator(sessionId(ctx))?.blocked,
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
    const section = scheduledWorkSection(sessionMessages(ctx), attempted);
    source?.set(section ? { ...section, manage: { label: "Cancel", run: cancelDialog } } : undefined);
  }

  async function cancelDialog(ctx: ExtensionContext): Promise<void> {
    const epoch = timerEpoch;
    const selector = await ctx.ui.input("Cancel scheduled message", "ID, prefix, or all");
    if (epoch !== timerEpoch || !selector?.trim()) return;
    const { cancelled, ambiguous, alreadyDelivered } = cancelMessages(ctx, selector);
    if (ambiguous) ctx.ui.notify("Ambiguous schedule id; use more characters.", "warning");
    else if (cancelled.length) ctx.ui.notify(cancellationConfirmation(cancelled), "info");
    else ctx.ui.notify(alreadyDelivered ? "This message was already delivered." : "No cancellable message matched.", "info");
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

  function deliveryStatus(message: ScheduledMessage): string {
    return attempted.has(message.id) ? "delivery pending" : formatRemaining(message.dueAt);
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
    reconcileAdmissions(ctx);
    const messages = sessionMessages(ctx);
    if (!messages.length) {
      ctx.ui.notify("No scheduled messages for this session.", "info");
      return;
    }
    const lines = messages.map((message) => `#${message.id} ${deliveryStatus(message)} (${formatDueAt(message.dueAt)}): ${displayText(message.message)}`);
    ctx.ui.notify(lines.join("\n"), "info");
  }

  function usage(ctx: ExtensionContext, type: "info" | "error" = "error"): void {
    ctx.ui.notify("Usage: /schedule <15m|5h|5.5h|30d> <message> · /schedule list · /schedule cancel <id> · /schedule clear", type);
  }

  function armTimer(ctx: ExtensionContext): void {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = undefined;
    if (!activeCtx || sessionId(activeCtx) !== sessionId(ctx)) return;
    const epoch = timerEpoch;
    const next = sessionMessages(ctx).find((entry) => !attempted.has(entry.id));
    if (!next) return;
    tickTimer = setTimeout(() => {
      tickTimer = undefined;
      if (!activeCtx || epoch !== timerEpoch || sessionId(activeCtx) !== sessionId(ctx)) return;
      try { deliverDue(pi, ctx); refreshWidget(ctx); armTimer(ctx); }
      catch (error) { reportError(ctx, error); }
    }, Math.min(2_147_483_647, Math.max(0, next.dueAt - Date.now())));
  }

  function startTicker(pi: ExtensionAPI, ctx: ExtensionContext): void {
    timerEpoch++;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = undefined;
    activeCtx = ctx;
    source?.dispose();
    source = workUi.source("scheduled");
    attempted.clear();
    receipts.reset();
    for (const [id, store] of stores) {
      if (id === sessionId(ctx)) continue;
      try { store.close(); } catch (error) { reportError(ctx, error); }
      stores.delete(id);
    }
    try {
      for (const entry of sessionMessages(ctx)) registerWorkResource(sessionId(ctx), { kind: "timer", id: entry.id });
      deliverDue(pi, ctx);
      refreshWidget(ctx);
      armTimer(ctx);
    } catch (error) { reportError(ctx, error); }
  }

  function stopTicker(ctx?: ExtensionContext): void {
    timerEpoch++;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = undefined;
    const current = ctx ?? activeCtx;
    activeCtx = undefined;
    const errors: unknown[] = [];
    try {
      // Queued but unadmitted messages remain recoverable after reload/exit.
      if (current && attempted.size) stores.get(sessionId(current))?.claimDue(-Infinity, admittedMessages(current));
    } catch (error) { errors.push(error); }
    for (const store of stores.values()) {
      try { store.close(); } catch (error) { errors.push(error); }
    }
    stores.clear();
    receipts.reset();
    attempted.clear();
    source?.dispose();
    source = undefined;
    if (current) {
      for (const error of errors) reportError(current, error);
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
    description: "Schedule a message after a genuine time-based delay. Use work-completion notifications or wait_for_work for tracked processes and agents, not a short reminder to check whether they finished. Due messages steer an active run.",
    promptSnippet: "schedule(delay, message): send a future message back to this same Pi session",
    promptGuidelines: [
      "Tracked processes and agents already emit completion notifications; wait_for_work can yield until they finish. Scheduled messages are for time-based follow-ups.",
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
    parameters: Type.Object({
      id: Type.String({ description: "Schedule id returned by schedule, or 'all' to cancel every pending scheduled message in this session." }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const selector = params.id.trim();
      if (!selector) throw new Error("Schedule id cannot be empty.");

      const { cancelled, ambiguous, alreadyDelivered } = cancelMessages(ctx, selector);
      if (ambiguous) throw new Error(`Schedule id ${displayText(selector)} is ambiguous; use more characters.`);
      if (!cancelled.length && alreadyDelivered) {
        return {
          content: [{ type: "text", text: `Scheduled message #${displayText(selector)} was already delivered.` }],
          details: { selector, count: 0, alreadyDelivered: true, cancelled: [] },
        };
      }
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
      if (ctx.mode === "tui") await workUi.open(ctx, "scheduled");
      else notifyScheduleList(ctx);
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
        if (ctx.mode === "tui") await workUi.open(ctx, "scheduled");
        else notifyScheduleList(ctx);
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
        const { cancelled, ambiguous, alreadyDelivered } = cancelMessages(ctx, cancelMatch[1]!);
        if (ambiguous) ctx.ui.notify(`Schedule id ${displayText(cancelMatch[1]!)} is ambiguous; use more characters.`, "error");
        else if (cancelled.length) ctx.ui.notify(cancellationConfirmation(cancelled), "info");
        else if (alreadyDelivered) ctx.ui.notify(`Scheduled message #${displayText(cancelMatch[1]!)} was already delivered.`, "info");
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
  pi.on("session_tree", (_event, ctx) => {
    if (ctx.mode === "tui" || ctx.mode === "rpc") startTicker(pi, ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    try { reconcileAdmissions(ctx); }
    catch (error) { reportError(ctx, error); }
  });
  pi.on("session_compact", () => receipts.reset());
  pi.on("context", (_event, ctx) => {
    // A steering message can be persisted while the agent remains active for
    // many turns. Check its durable receipt without waiting for idle settlement.
    try { reconcileAdmissions(ctx); }
    catch (error) { reportError(ctx, error); }
  });
}

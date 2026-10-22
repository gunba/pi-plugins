import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_WAIT_MS, WorkCoordinator, registry } from "./core.ts";
export { WorkCoordinator, getWorkCoordinator } from "./core.ts";
export const WAIT_ENTRY = "pi-work/wait-v1";
export const WAKE_MESSAGE = "pi-work/wake-v1";
const DISCOVER_COORDINATION = "pi-work/discover-coordination-v1";

/** Runtime role comes from the child-owned event bus, never model-supplied text. */
/** Milliseconds until a time an agent names: "HH:MM" at its next occurrence here, or an ISO date and time. */
export function untilMs(until: string, now = new Date()): number {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(until.trim());
  let at: number;
  if (clock) {
    if (Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new Error(`${until} is not a time of day.`);
    const next = new Date(now); next.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    at = next.getTime();
  } else at = Date.parse(until);
  if (!Number.isFinite(at)) throw new Error(`${until} is not a time: give HH:MM or an ISO date and time.`);
  const ms = at - now.getTime();
  if (ms <= 0) throw new Error(`${until} has passed.`);
  if (ms > MAX_WAIT_MS) throw new Error(`${until} is more than 24 hours away; wait in steps of at most 24 hours.`);
  return ms;
}

export function isManagedChild(pi: ExtensionAPI): boolean {
  const probe = { installed: false, child: false };
  pi.events.emit(DISCOVER_COORDINATION, probe);
  return probe.installed && probe.child;
}

/** Install once per event bus; SDK children own their continuation. */
export function ensureWorkCoordination(pi: ExtensionAPI, options: { child?: boolean } = {}): void {
  // Each ExtensionAPI has a different events facade. Probe through the actual
  // shared bus instead of comparing facade identities. Pi's emit invokes the
  // synchronous portion of listeners before returning, so probe+claim has no
  // await gap. The host also removes this listener if its factory fails.
  const probe = { installed: false };
  pi.events.emit(DISCOVER_COORDINATION, probe);
  if (probe.installed) return;
  const releaseClaim = pi.events.on(DISCOVER_COORDINATION, (value) => {
    if (value && typeof value === "object" && "installed" in value) {
      (value as { installed: boolean }).installed = true;
      (value as { child?: boolean }).child = options.child === true;
    }
  });
  let coordinator: WorkCoordinator | undefined;
  const start = (ctx: ExtensionContext) => {
    if (coordinator) {
      coordinator.close();
      if (registry.sessions.get(coordinator.sessionId) === coordinator) registry.sessions.delete(coordinator.sessionId);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    coordinator = new WorkCoordinator(sessionId);
    registry.sessions.set(sessionId, coordinator);
    // Preserve unadmitted historical completion content without restoring the old wait.
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === WAIT_ENTRY);
    const data = entry?.type === "custom" ? entry.data as { status?: string; id?: string; content?: string; wakeOwned?: boolean; reason?: string } : undefined;
    if (data?.wakeOwned && data.content && data.id && data.reason !== "event-consumed") {
      const dispatched = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === WAKE_MESSAGE && (entry.details as { waitId?: string })?.waitId === data.id);
      if (!dispatched) pi.sendMessage({ customType: WAKE_MESSAGE, content: data.content, display: true, details: { waitId: data.id, recovered: true } }, { deliverAs: "steer", triggerTurn: false });
    }
    if (data && (data.status === "waiting" || data.status === "ready")) {
      pi.appendEntry(WAIT_ENTRY, { ...data, status: "cancelled", reason: "runtime-replaced" });
      ctx.ui.notify("The previous wait was cancelled on reload or branch change.", "info");
    }
  };
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("input", (event) => { if (event.source !== "extension") coordinator?.cancel("user-input"); });
  pi.on("context", (event) => {
    if (!coordinator?.hasUnread) return;
    for (const message of event.messages) {
      if (message.role !== "custom" || !["pi-subagents/notice", "pi-subagents/followup", "pi-codex-compat/process-exit"].includes(message.customType)) continue;
      const ids = (message.details as { messageIds?: unknown })?.messageIds;
      if (Array.isArray(ids)) coordinator.consume(ids.filter((id): id is string => typeof id === "string"));
    }
  });
  pi.on("session_shutdown", () => {
    try {
      if (coordinator) {
        coordinator.close();
        if (registry.sessions.get(coordinator.sessionId) === coordinator) registry.sessions.delete(coordinator.sessionId);
      }
    } finally { releaseClaim(); }
  });
  pi.registerTool({
    name: "wait_agent", label: "Wait for agents",
    // Loaded with tool_search alongside the other subagent tools; see pi-subagents.
    exposure: "deferred", namespace: { name: "subagents", description: "Start subagents and message, follow up, wait for, list or interrupt them." },
    description: "Wait for a subagent's message or completion, a background command finishing, or Jordan's next input, which each end it early. timeout_ms: 10000 to 86400000 (24 h), default 30000; or until a time.",
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ maximum: MAX_WAIT_MS })),
      until: Type.Optional(Type.String({ description: "Instead of timeout_ms: HH:MM (its next occurrence, this computer's time) or an ISO date and time, within 24 h." })) }, { additionalProperties: false }),
    outputSchema: Type.Object({ message: Type.String(), timed_out: Type.Boolean() }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (!coordinator || coordinator.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("agent mailbox is not initialized for this session");
      const timeout = Math.max(10_000, params.until ? untilMs(params.until) : params.timeout_ms ?? 30_000);
      const result = await coordinator.wait(timeout, signal);
      if (params.timeout_ms !== undefined && params.timeout_ms < timeout)
        result.message += `\n\nRequested timeout of ${params.timeout_ms}ms was clamped to the minimum of ${timeout}ms.`;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, structuredContent: result };
    },
  });
}

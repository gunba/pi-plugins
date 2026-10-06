import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkCoordinator, registry } from "./core.ts";
export { WorkCoordinator, getWorkCoordinator } from "./core.ts";
export const WAIT_ENTRY = "pi-work/wait-v1";
export const WAKE_MESSAGE = "pi-work/wake-v1";
const DISCOVER_COORDINATION = "pi-work/discover-coordination-v1";

/** Runtime role comes from the child-owned event bus, never model-supplied text. */
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
      ctx.ui.notify("The previous explicit wait was cancelled on reload or branch change. Register a new wait if needed.", "info");
    }
  };
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("input", (event) => { if (event.source !== "extension") coordinator?.cancel("user-input"); });
  pi.on("context", (event) => {
    if (!coordinator?.hasUnread) return;
    for (const message of event.messages) {
      if (message.role !== "custom" || !["pi-subagents/notice", "pi-subagents/followup"].includes(message.customType)) continue;
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
    description: "Wait for an agent message or final-status notification, including already queued messages. New user input also ends the wait. The tool stays pending; it does not end this turn or cancel child work. timeout_ms defaults to 30000, with a minimum of 10000 and maximum of 3600000. Use write_stdin for a running process.",
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ maximum: 3_600_000 })) }, { additionalProperties: false }),
    outputSchema: Type.Object({ message: Type.String(), timed_out: Type.Boolean() }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (!coordinator || coordinator.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("agent mailbox is not initialized for this session");
      const timeout = Math.max(10_000, params.timeout_ms ?? 30_000);
      const result = await coordinator.wait(timeout, signal);
      if (params.timeout_ms !== undefined && params.timeout_ms < timeout)
        result.message += `\n\nRequested timeout of ${params.timeout_ms}ms was clamped to the minimum of ${timeout}ms.`;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, structuredContent: result };
    },
  });
}

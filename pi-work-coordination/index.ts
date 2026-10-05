import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkCoordinator, registry } from "./core.ts";
export { WorkCoordinator, getWorkCoordinator, registerWorkResource, completeWorkResource } from "./core.ts";
export type { WorkTarget } from "./core.ts";
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
    // A tree event already selected the destination branch. Never append the
    // abandoned branch's wait or completion into that destination.
    coordinator?.close(false);
    const sessionId = ctx.sessionManager.getSessionId();
    coordinator = new WorkCoordinator(sessionId, (data) => pi.appendEntry(WAIT_ENTRY, data));
    registry.sessions.set(sessionId, coordinator);
    // Resource ownership cannot survive replacement. Do not restore phantom
    // processes or block a reloaded goal. Resource owners re-register live work.
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
    description: "Wait for one of the selected child agents to finish its current task. Returns on completion, user input or timeout_ms (default 30000, maximum 3600000). The agent stays active while waiting; timeout does not cancel child work. Use write_stdin for a running process.",
    parameters: Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (!options.child && ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Explicit waiting requires a live TUI/RPC session or a managed SDK child");
      if (!coordinator || coordinator.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("work coordinator is not initialized for this session");
      const result = await coordinator.wait(params.ids.map(id => ({ kind: "child" as const, id })), "any", params.timeout_ms ?? 30_000, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

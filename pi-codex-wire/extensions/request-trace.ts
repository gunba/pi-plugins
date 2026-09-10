import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";

export type RequestOrigin = "interactive-input" | "rpc-input" | "extension-input" | "child-notice" | "timer" | "goal" | "work-completion" | "tool-continuation" | "unknown";
export type RequestKind = "assistant" | "compaction" | "branch-summary";
export type RequestTrace = {
  rootSessionId: string;
  sessionId: string;
  callKind: RequestKind;
  origin: RequestOrigin;
  triggerOrigin: RequestOrigin;
};
type State = { callKind: RequestKind; origin: RequestOrigin };
const key = Symbol.for("pi.codex-wire.request-trace.v1");
const global = globalThis as typeof globalThis & { [key]?: Map<string, State> };
const states = global[key] ??= new Map<string, State>();

export function requestTrace(rootSessionId: string, sessionId: string, context: Context): RequestTrace {
  const state = states.get(sessionId) ?? { callKind: "assistant" as const, origin: "unknown" as const };
  return {
    rootSessionId, sessionId, callKind: state.callKind, triggerOrigin: state.origin,
    origin: state.callKind === "assistant" && context.messages.at(-1)?.role === "toolResult" ? "tool-continuation" : state.origin,
  };
}

/** Lifecycle-only attribution. Never infer request purpose from private prompt text. */
export default function requestTracing(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    states.set(ctx.sessionManager.getSessionId(), { callKind: "assistant", origin: "unknown" });
  });
  pi.on("session_shutdown", (_event, ctx) => { states.delete(ctx.sessionManager.getSessionId()); });
  pi.on("input", (event, ctx) => {
    const origin: RequestOrigin = event.source === "interactive" ? "interactive-input"
      : event.source === "rpc" ? "rpc-input" : "extension-input";
    states.set(ctx.sessionManager.getSessionId(), { callKind: "assistant", origin });
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role !== "custom") return;
    const type = message.customType;
    const origin: RequestOrigin = type.startsWith("pi-subagents/") ? "child-notice"
      : type === "pi-scheduler-scheduled-message" ? "timer"
      : type.startsWith("pi-goal") ? "goal"
      : type.startsWith("pi-work") ? "work-completion" : "extension-input";
    states.set(ctx.sessionManager.getSessionId(), { callKind: "assistant", origin });
  });
  pi.on("session_before_compact", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { callKind: "compaction", origin: states.get(id)?.origin ?? "unknown" });
  });
  const reset = (_event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { callKind: "assistant", origin: states.get(id)?.origin ?? "unknown" });
  };
  pi.on("session_compact", reset);
  pi.on("session_compact_failed", reset);
  pi.on("session_before_tree", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { callKind: "branch-summary", origin: states.get(id)?.origin ?? "unknown" });
  });
  pi.on("session_tree", reset);
}

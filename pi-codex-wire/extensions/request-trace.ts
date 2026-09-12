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
type State = {
  origin: RequestOrigin;
  summary?: { signal: AbortSignal; callKind: "compaction" | "branch-summary"; origin: RequestOrigin };
};
const key = Symbol.for("pi.codex-wire.request-trace.v2");
const global = globalThis as typeof globalThis & { [key]?: Map<string, State> };
const states = global[key] ??= new Map<string, State>();

export function requestTrace(rootSessionId: string, sessionId: string, context: Context, signal?: AbortSignal): RequestTrace {
  const state = states.get(sessionId);
  // Pi uses fresh routing IDs for summaries, but preserves the lifecycle signal.
  // Do not label unrelated child/assistant traffic from the parent's UI state.
  const summary = [state?.summary, states.get(rootSessionId)?.summary]
    .find(value => value && value.signal === signal && !value.signal.aborted);
  const callKind = summary?.callKind ?? "assistant";
  const origin = summary?.origin ?? state?.origin ?? "unknown";
  return {
    rootSessionId, sessionId, callKind, triggerOrigin: origin,
    origin: callKind === "assistant" && context.messages.at(-1)?.role === "toolResult" ? "tool-continuation" : origin,
  };
}

/** Lifecycle-only attribution. Never infer request purpose from private prompt text. */
export default function requestTracing(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    states.set(ctx.sessionManager.getSessionId(), { origin: "unknown" });
  });
  pi.on("session_shutdown", (_event, ctx) => { states.delete(ctx.sessionManager.getSessionId()); });
  pi.on("input", (event, ctx) => {
    const origin: RequestOrigin = event.source === "interactive" ? "interactive-input"
      : event.source === "rpc" ? "rpc-input" : "extension-input";
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { ...states.get(id), origin });
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role !== "custom") return;
    const type = message.customType;
    const origin: RequestOrigin = type.startsWith("pi-subagents/") ? "child-notice"
      : type === "pi-scheduler-scheduled-message" ? "timer"
      : type.startsWith("pi-goal") ? "goal"
      : type.startsWith("pi-work") ? "work-completion" : "extension-input";
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { ...states.get(id), origin });
  });
  pi.on("session_before_compact", (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const origin = states.get(id)?.origin ?? "unknown";
    states.set(id, { origin, summary: { signal: event.signal, callKind: "compaction", origin } });
  });
  const reset = (_event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
    const id = ctx.sessionManager.getSessionId();
    states.set(id, { origin: states.get(id)?.origin ?? "unknown" });
  };
  pi.on("session_compact", reset);
  pi.on("session_compact_failed", reset);
  pi.on("session_before_tree", (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const origin = states.get(id)?.origin ?? "unknown";
    states.set(id, { origin, ...(event.preparation.userWantsSummary
      ? { summary: { signal: event.signal, callKind: "branch-summary" as const, origin } } : {}) });
  });
  pi.on("session_tree", reset);
}

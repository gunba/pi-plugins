import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inPlaceBlocker, summarizeInPlace, type SentRequest } from "./in-place.ts";
import { BRIEF_ENTRY, BRIEF_EVENT, writeBrief, type BriefProbe } from "./brief.ts";
import { getPresentation } from "../../pi-ui/index.ts";

/** The note after a compaction saying where the detail its summary left out can still be found. */
export const HISTORY_NOTE = "pi-history-note";
export const historyNote = (session: string) => `[Earlier history] The full conversation before this summary is kept. For a detail the summary lacks, such as an exact command, value, path or error, use conversation_search with session "${session}" (a memory tool; load it with tool_search if needed), then conversation_read to see the passage in context.`;

/** Tool calls that make a turn worth a brief written without being asked, when it changed no files. */
const AUTO_BRIEF_CALLS = 8;

/** A turn that ended with an answer after real work: it edited or wrote files, or made several tool calls. */
export function substantialTurn(messages: readonly unknown[]): boolean {
  let calls = 0, edits = false;
  let last: { stopReason?: string; content?: unknown } | undefined;
  for (const message of messages as { role?: string; stopReason?: string; content?: unknown }[]) {
    if (message?.role !== "assistant") continue;
    last = message;
    for (const block of Array.isArray(message.content) ? message.content as { type?: string; name?: string }[] : []) {
      if (block?.type !== "toolCall") continue;
      calls++;
      if (block.name === "edit" || block.name === "write") edits = true;
    }
  }
  const answered = last?.stopReason === "stop" && Array.isArray(last.content)
    && (last.content as { type?: string; text?: string }[]).some(block => block?.type === "text" && !!block.text?.trim());
  return answered && (edits || calls >= AUTO_BRIEF_CALLS);
}

export default function compactionContext(pi: ExtensionAPI): void {
  // The payload each conversation last sent for a turn, as sent: this extension loads last, after every payload handler.
  const sent = new Map<string, SentRequest>();
  // The latest context each conversation's handlers saw, for briefs asked for between events.
  const contexts = new Map<string, ExtensionContext>();
  const remember = (ctx: ExtensionContext) => { const id = ctx.sessionManager?.getSessionId?.(); if (id) contexts.set(id, ctx); };
  pi.on("session_start", (_event, ctx) => remember(ctx));
  pi.on("agent_end", (event, ctx) => {
    remember(ctx);
    // Ready when the user is back from being away: written only from the turn's cached request, once per reply.
    if (getPresentation(pi)?.operatorAvailable !== false || !substantialTurn(event.messages)) return;
    const id = ctx.sessionManager.getSessionId();
    void writeBrief(ctx, sent.get(id), brief => pi.appendEntry(BRIEF_ENTRY, brief), { cacheOnly: true, auto: true }).catch(() => {});
  });
  const releaseBrief = pi.events?.on(BRIEF_EVENT, raw => {
    const probe = raw as BriefProbe;
    const ctx = probe && typeof probe === "object" ? contexts.get(probe.session) : undefined;
    if (!ctx) return;
    probe.result = writeBrief(ctx, sent.get(probe.session), brief => pi.appendEntry(BRIEF_ENTRY, brief), { reply: probe.reply, refresh: probe.refresh, signal: probe.signal });
  });
  let turnRequest = false, lastInPlace = "not tried yet";
  pi.on("context_with_system", () => { turnRequest = true; });
  pi.on("session_before_compact", async (event, ctx) => {
    const request = ctx.model && ctx.model.provider !== "openai-codex" ? sent.get(ctx.sessionManager.getSessionId()) : undefined;
    const blocker = inPlaceBlocker(event, ctx, request);
    if (!blocker && request) {
      try {
        const compaction = await summarizeInPlace(event, ctx, request);
        if (compaction) { lastInPlace = "used"; return { compaction }; }
        lastInPlace = "fell back: the model did not return a summary";
      } catch (error) {
        if (event.signal.aborted) return;
        lastInPlace = `fell back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      }
    } else lastInPlace = `not used: ${blocker}`;
    // Otherwise Pi writes the summary itself, unchanged.
  });
  // A summary keeps less than the conversation it replaces; the conversation stays searchable (the "memory tax", arXiv
  // 2610.34073). Sent once, right after the summary (at the end of a running turn), so later requests read it from the
  // prompt cache unchanged; it never starts a turn.
  pi.on("session_compact", (_event, ctx) => {
    if (!pi.getAllTools().some(tool => tool.name === "conversation_search")) return;
    pi.sendMessage({ customType: HISTORY_NOTE, content: historyNote(ctx.sessionManager.getSessionId()), display: false }, { triggerTurn: false });
  });
  pi.on("session_shutdown", (_event, ctx) => { sent.delete(ctx.sessionManager.getSessionId()); contexts.delete(ctx.sessionManager.getSessionId()); releaseBrief?.(); });
  pi.on("before_provider_request", (event, ctx) => {
    remember(ctx);
    if (turnRequest) {
      turnRequest = false;
      const model = ctx.model;
      if (model) try {
        sent.set(ctx.sessionManager.getSessionId(), { payload: JSON.stringify(event.payload), model: `${model.provider}/${model.id}`, api: model.api, leaf: ctx.sessionManager.getLeafId() });
      } catch { /* A payload that cannot be copied is not replayed. */ }
    }
  });
  pi.registerCommand("compaction-context", {
    description: "Show whether the last compaction summary was written from the prompt cache",
    handler: async () => {
      pi.sendMessage({ customType: "pi-compaction-context-status", content: `# Compaction context\n\nSummary from the conversation's own cache: ${lastInPlace}`, display: true }, { triggerTurn: false });
    },
  });
}

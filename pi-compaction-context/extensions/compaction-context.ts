import { buildSessionProjection, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { cacheBlocker, keptEntry, summarizeConversation, summarizeFromCache, summaryRequest, type SentRequest } from "./summary.ts";
import { fileCalls, restore } from "./restore.ts";
import { BRIEF_ENTRY, BRIEF_EVENT, writeBrief, type BriefProbe } from "./brief.ts";
import { getPresentation } from "../../pi-ui/index.ts";
import { compactionKey, recordCompactionFailure } from "../../pi-context-window/compaction.ts";

/** The note after a compaction saying where the detail its summary left out can still be found. */
export const HISTORY_NOTE = "pi-history-note";
export const historyNote = (session: string) => `[Earlier history] The full conversation before this summary is kept. For a detail the summary lacks, such as an exact command, value, path or error, use conversation_search with session "${session}" (a memory tool; load it with tool_search if needed), then conversation_read to see the passage in context.`;

/** Ends the summary, as Claude Code's continuation message does. */
export const CONTINUE = "Carry on from where the conversation left off without asking the user any further questions. Resume directly: don't acknowledge this summary or recap what was happening, and don't open with \"I'll continue\" or similar. Pick up the last task as if there had been no break.";

type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/**
 * The compaction for a non-Codex conversation, written the way Claude Code writes it (see summary.ts): from the
 * conversation's cached last request when it can be reused, otherwise from the conversation sent again in full.
 * The summary is followed by where to find the full history, the instruction to carry on, and what restore.ts puts back.
 */
export async function compactConversation(pi: ExtensionAPI, ctx: ExtensionContext, model: Model<Api>, event: SessionBeforeCompactEvent,
  sent: SentRequest | undefined, thinking: Thinking) {
  const projection = buildSessionProjection(event.branchEntries);
  const kept = keptEntry(projection);
  const firstKeptEntryId = kept >= 0 ? projection.entries[kept]!.sourceEntry.id : event.preparation.firstKeptEntryId;
  const instruction = summaryRequest(event.customInstructions);
  const blocker = cacheBlocker(event, model, sent);
  let result: Awaited<ReturnType<typeof summarizeConversation>>;
  if (blocker) result = await summarizeConversation(pi, ctx, model, event, projection, instruction, thinking);
  else {
    const order = new Map(event.branchEntries.map((entry, index) => [entry.id, index]));
    const leaf = order.get(sent!.leaf!)!;
    const after = projection.entries.filter(entry => (order.get(entry.sourceEntry.id) ?? -1) > leaf).flatMap(entry => entry.messages);
    result = { ...await summarizeFromCache(pi, ctx, model, sent!, after, instruction, thinking, event.signal), omittedResults: 0, omittedMessages: 0 };
  }
  const keptEntries = kept >= 0 ? projection.entries.slice(kept) : [];
  const restored = restore(pi, ctx.cwd, event.branchEntries, keptEntries.flatMap(entry => entry.messages));
  const history = pi.getAllTools().some(tool => tool.name === "conversation_search") ? historyNote(ctx.sessionManager.getSessionId()) : undefined;
  // Pi's file lists, with the files used up to the kept messages, which start later than Pi's cut.
  const read = new Set(event.preparation.fileOps.read), modified = new Set([...event.preparation.fileOps.edited, ...event.preparation.fileOps.written]);
  for (const entry of kept >= 0 ? projection.entries.slice(0, kept) : []) for (const message of entry.messages)
    for (const call of fileCalls(message)) (call.name === "read" ? read : modified).add(call.path);
  return {
    summary: [result.summary, history, CONTINUE, restored.text].filter(Boolean).join("\n\n"),
    firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, usage: result.usage,
    details: {
      readFiles: [...read].filter(path => !modified.has(path)).sort(), modifiedFiles: [...modified].sort(),
      request: blocker ? "full" : "cache", ...(blocker ? { reason: blocker } : {}),
      ...(result.omittedResults || result.omittedMessages ? { omitted: { toolResults: result.omittedResults, messages: result.omittedMessages } } : {}),
      restored: { files: restored.files, skills: restored.skills, plan: restored.plan, watches: restored.watches },
    },
  };
}

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
  let turnRequest = false, lastCompaction = "none since this conversation started";
  pi.on("context_with_system", () => { turnRequest = true; });
  // Codex conversations compact natively in Codex Wire. Failures cancel: Pi's own summary never stands in.
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider === "openai-codex") return;
    const sessionId = ctx.sessionManager.getSessionId(), thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
    try {
      const compaction = await compactConversation(pi, ctx, model, event, sent.get(sessionId), thinking);
      lastCompaction = compaction.details.request === "cache" ? "written from the conversation's cached last request"
        : `written from the whole conversation, sent again because ${compaction.details.reason}`;
      return { compaction };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      const message = `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
      // The same hold as pi-context-window's: not repeated automatically until something it depends on changes.
      recordCompactionFailure(sessionId, compactionKey(model, event.preparation.settings, thinking), message);
      ctx.ui.notify(message, "error");
      lastCompaction = message;
      return { cancel: true };
    }
  });
  // A summary keeps less than the conversation it replaces; the conversation stays searchable (the "memory tax", arXiv
  // 2610.34073). Summaries written here say so themselves; after a Codex checkpoint the note is sent once, right after
  // it (at the end of a running turn), so later requests read it from the prompt cache unchanged. It never starts a turn.
  pi.on("session_compact", (event, ctx) => {
    if ((event.compactionEntry?.details as { request?: unknown } | undefined)?.request) return;
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
    description: "Show how the last compaction summary was written",
    handler: async () => {
      pi.sendMessage({ customType: "pi-compaction-context-status", content: `# Compaction context\n\nLast summary: ${lastCompaction}`, display: true }, { triggerTurn: false });
    },
  });
}

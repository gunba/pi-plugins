import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { cacheExpired } from "../../pi-context-window/prompt-cache.ts";

/**
 * Compaction as the next turn of the same conversation. The provider payload the conversation last sent is replayed
 * byte for byte, with one user message asking for the summary, so the request reads the conversation's prompt cache
 * instead of paying for the whole context again. Pi's own summary is used whenever this cannot apply.
 */
export type SentRequest = { payload: string; model: string; api: string; leaf: string | null };

// Pi's summary format (core/compaction/compaction.js), so in-place and default summaries read alike.
const FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_RULES = `Update the earlier summary with what happened after it. RULES:
- PRESERVE all existing information from the earlier summary
- ADD new progress, decisions, and context from the later messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it`;

type Entry = SessionBeforeCompactEvent["branchEntries"][number];
/** The opening words of the first message that stays, so the model knows where its summary must stop. */
export function openingWords(entry: Entry | undefined): string | undefined {
	if (!entry || entry.type !== "message") return;
	const message = entry.message as { role: string; content: unknown; toolName?: string };
	const parts = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
		? message.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text]
			: part?.type === "toolCall" && typeof part.name === "string" ? [`(${part.name} tool call)`] : []) : [];
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	return text ? `${message.role === "user" ? "user" : message.role === "assistant" ? "your" : "the"} message beginning «${text.slice(0, 160)}${text.length > 160 ? "…" : ""}»` : undefined;
}

export function summaryRequest(kept: string, update: boolean, focus?: string): string {
	return `[Context compaction] Pause the task: instead of continuing, write a context checkpoint summary that another model will use to continue the work. Do not call any tools.

The conversation from the ${kept} onwards stays in context word for word. Summarize everything before it${update ? ", starting from the earlier summary at the beginning of this conversation" : ""}.

${update ? `${UPDATE_RULES}\n\n` : ""}Use this EXACT format:

${FORMAT}${focus ? `\n\nAdditional focus: ${focus}` : ""}`;
}

/** The same request with one more user message, in the provider's own payload shape; undefined when unknown. */
export function withUserMessage(payload: unknown, api: string, text: string): unknown {
	if (!payload || typeof payload !== "object") return;
	const body = payload as Record<string, unknown>;
	if (api === "anthropic-messages" && Array.isArray(body.messages))
		return { ...body, messages: [...body.messages, { role: "user", content: [{ type: "text", text }] }] };
	if (api === "openai-completions" && Array.isArray(body.messages))
		return { ...body, messages: [...body.messages, { role: "user", content: text }] };
	if ((api === "openai-responses" || api === "azure-openai-responses") && Array.isArray(body.input))
		return { ...body, input: [...body.input, { role: "user", content: [{ type: "input_text", text }] }] };
	if ((api === "google-generative-ai" || api === "google-vertex") && Array.isArray(body.contents))
		return { ...body, contents: [...body.contents, { role: "user", parts: [{ text }] }] };
}

/** Pi's file lists, appended to the summary and kept in details as its default compaction does. */
export function fileLists(ops: SessionBeforeCompactEvent["preparation"]["fileOps"]): { text: string; readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...ops.edited, ...ops.written]), modifiedFiles = [...modified].sort();
	const readFiles = [...ops.read].filter(path => !modified.has(path)).sort();
	const text = (readFiles.length ? `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>` : "")
		+ (modifiedFiles.length ? `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "");
	return { text, readFiles, modifiedFiles };
}

/** Why the in-place summary cannot be used for this compaction; undefined when it can. */
export function inPlaceBlocker(event: SessionBeforeCompactEvent, ctx: Pick<ExtensionContext, "model" | "sessionManager">, sent: SentRequest | undefined): string | undefined {
	const model = ctx.model;
	if (!model || model.provider === "openai-codex") return "Codex compacts natively";
	// The last request was too large for the model; its own summary must be smaller.
	if (event.reason === "overflow") return "context overflow";
	if (!sent || sent.model !== `${model.provider}/${model.id}`) return "no request from this model to reuse";
	// A known-expired cache saves nothing, and Pi's summary truncates tool results, so it costs less.
	if (cacheExpired(model, ctx.sessionManager.getBranch())) return "cache expired";
	const ids = event.branchEntries.map(entry => entry.id), kept = ids.indexOf(event.preparation.firstKeptEntryId), leaf = sent.leaf ? ids.indexOf(sent.leaf) : -1;
	// Everything to be summarized must be in the replayed request.
	if (kept < 0 || leaf < 0 || kept > leaf + 1) return "the last request does not cover what is summarized";
}

export async function summarizeInPlace(event: SessionBeforeCompactEvent, ctx: ExtensionContext, sent: SentRequest) {
	const { preparation } = event;
	const kept = openingWords(event.branchEntries.find(entry => entry.id === preparation.firstKeptEntryId));
	if (!kept || !ctx.model) return;
	const payload = withUserMessage(JSON.parse(sent.payload), sent.api, summaryRequest(kept, !!preparation.previousSummary, event.customInstructions));
	if (!payload) return;
	// The request built from this placeholder is replaced by the replayed payload, which carries the conversation's
	// own system prompt, tools, messages, thinking and tool choice; the session ID keeps the provider's cache routing.
	const result = await ctx.modelRegistry.complete(ctx.model, { systemPrompt: "", messages: [{ role: "user", content: "Summarize.", timestamp: Date.now() }] },
		{ signal: event.signal, sessionId: ctx.sessionManager.getSessionId(), onPayload: () => payload });
	if (result.stopReason !== "stop" || result.content.some(part => part.type === "toolCall")) return;
	const summary = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
	if (!summary) return;
	const files = fileLists(preparation.fileOps);
	return { summary: summary + files.text, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
		usage: result.usage, details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles, inPlace: true } };
}

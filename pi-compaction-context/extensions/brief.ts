import { buildSessionContext, convertToLlm, serializeConversation, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { cacheExpired } from "../../pi-context-window/prompt-cache.ts";
import type { SentRequest } from "./in-place.ts";

/** Marks a request made beside the conversation, not part of it (read and removed by pi-codex-wire). */
export const SIDE_REQUEST_HEADER = "x-pi-side-request";

/**
 * "What do I need to know?": a one-page brief on the agent's latest turn, written by the same model from its own
 * context, for the user to read. It never enters the conversation: the brief is kept as a custom entry, which is not
 * model context, and the request that writes it is a copy of the conversation's last request with two messages
 * appended, so it reads the prompt cache and leaves it as it was for the conversation's next turn. When the cache has
 * expired, or there is no request to copy, the conversation is sent as a transcript instead, as Pi's compaction does.
 */
export const BRIEF_ENTRY = "pi-brief";
/** Desk asks for a brief over the extension event bus with a probe it reads back. */
export const BRIEF_EVENT = "pi:brief";
export type Brief = {
	markdown: string;
	/** The assistant reply the brief covers. */
	reply: string | null;
	created: number;
	model: string;
	/** "cache": from the conversation's own cached request; "transcript": from a copy of the conversation. */
	source: "cache" | "transcript";
	usage?: Usage;
	/** Already written for this reply; nothing was sent. */
	reused?: boolean;
};
export type BriefProbe = { session: string; refresh?: boolean; signal?: AbortSignal; result?: Promise<Brief> };

export const BRIEF_PROMPT = `[Brief for the user] Pause the task. Do not call any tools and do not continue the work. Write a one-page brief for the user about your most recent turn: everything from their latest message up to your final reply above. They will read it instead of the conversation, to understand what happened compared with what they asked for, and what needs them.

Write it from the user's side. Use only what happened in this conversation; never guess. Use exact values: names, numbers, dates, paths, amounts, confirmation codes. Write "None." for an empty section rather than filling it.

Use this structure, in Markdown, in under 400 words:

## Outcome
One or two sentences: did you do what they asked? If only partly, say what is missing first.

## What changed
Everything that is now different because of you. Group by kind; leave out kinds that do not apply:
- Files: each file and what changed in it. For the changes that matter, show **before → after** (a value, a line, a setting).
- This computer or other systems: services, settings, installed software, permissions.
- Outside: messages or emails sent, forms submitted, bookings, purchases, anything done on a website or through another agent or computer.
Say what is still in effect (something left running, enabled or open) and how to undo anything that is hard to undo.

## Needs you
Decisions to make, approvals, things to check, and the next step you recommend. Most important first.

## Judgment calls
Where you chose something for them or assumed something they did not say, and why. Name the main alternative you rejected.

## Not done or not verified
What you could not do, what failed, and what you did not test or confirm.

Adapt to the kind of work: for code, say what was tested and how; for research, give the findings and their sources; for errands, give the confirmations; for system changes, say what is different now and how to reverse it. If the turn only answered a question, keep it to Outcome and Needs you.`;

const BRIEF_SYSTEM = "You write short, factual briefs for a busy person about work an AI agent did on their behalf. Answer only from the conversation you are given.";

type Entry = { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; content?: unknown } };
const text = (content: unknown) => typeof content === "string" ? content
	: Array.isArray(content) ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim() : "";

/** The conversation's last request with the agent's final reply and the brief question appended, in its own shape. */
export function withReplyAndQuestion(payload: unknown, api: string, reply: string, question: string): unknown {
	if (!payload || typeof payload !== "object") return;
	const body = payload as Record<string, unknown>;
	if (api === "anthropic-messages" && Array.isArray(body.messages))
		return { ...body, messages: [...body.messages, ...reply ? [{ role: "assistant", content: [{ type: "text", text: reply }] }] : [], { role: "user", content: [{ type: "text", text: question }] }] };
	if (api === "openai-completions" && Array.isArray(body.messages))
		return { ...body, messages: [...body.messages, ...reply ? [{ role: "assistant", content: reply }] : [], { role: "user", content: question }] };
	if ((api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") && Array.isArray(body.input))
		return { ...body, input: [...body.input, ...reply ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] }] : [],
			{ role: "user", content: [{ type: "input_text", text: question }] }] };
	if ((api === "google-generative-ai" || api === "google-vertex") && Array.isArray(body.contents))
		return { ...body, contents: [...body.contents, ...reply ? [{ role: "model", parts: [{ text: reply }] }] : [], { role: "user", parts: [{ text: question }] }] };
}

/** The latest assistant reply that has text, and a brief already written for it, if any. */
function latest(branch: readonly Entry[]): { reply?: Entry; kept?: Brief } {
	let reply: Entry | undefined;
	for (let index = branch.length - 1; index >= 0 && !reply; index--) {
		const entry = branch[index]!;
		if (entry.type === "message" && entry.message?.role === "assistant" && text(entry.message.content)) reply = entry;
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === BRIEF_ENTRY && (entry.data as Brief | undefined)?.reply === (reply?.id ?? null)) return { reply, kept: entry.data as Brief };
	}
	return { reply };
}

export async function writeBrief(ctx: ExtensionContext, sent: SentRequest | undefined, save: (brief: Brief) => void,
	options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Brief> {
	const model = ctx.model;
	if (!model) throw Error("This conversation has no model yet.");
	const branch = ctx.sessionManager.getBranch() as unknown as Entry[];
	const { reply, kept } = latest(branch);
	if (kept && !options.refresh) return { ...kept, reused: true };
	const replyText = reply ? text(reply.message!.content) : "";
	const ids = branch.map(entry => entry.id), modelKey = `${model.provider}/${model.id}`;
	// The cached request applies when it is this model's, the cache is not known to have expired, and the reply came
	// after it (the reply is then exactly what the request produced).
	const replayable = sent && sent.model === modelKey && !cacheExpired(model, branch as never)
		&& (!reply || ids.indexOf(reply.id) > (sent.leaf ? ids.indexOf(sent.leaf) : -1));
	const payload = replayable ? withReplyAndQuestion(JSON.parse(sent!.payload), sent!.api, replyText, BRIEF_PROMPT) : undefined;
	// A side request: a provider with per-conversation connection state (codex-wire) sends it separately, leaving
	// that state for the conversation's next turn. Other providers ignore the header's meaning.
	const headers = { [SIDE_REQUEST_HEADER]: "1" };
	let result;
	if (payload) {
		// The request built from this placeholder is replaced by the copied payload, as in-place compaction does.
		result = await ctx.modelRegistry.complete(model, { systemPrompt: "", messages: [{ role: "user", content: "Brief.", timestamp: Date.now() }] },
			{ signal: options.signal, sessionId: ctx.sessionManager.getSessionId(), headers, onPayload: () => payload });
	} else {
		const entries = ctx.sessionManager.getEntries() as never;
		const conversation = serializeConversation(convertToLlm(buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages));
		result = await ctx.modelRegistry.complete(model, { systemPrompt: BRIEF_SYSTEM,
			messages: [{ role: "user", content: `<conversation>\n${conversation}\n</conversation>\n\n${BRIEF_PROMPT}`, timestamp: Date.now() }] },
			{ signal: options.signal, headers });
	}
	if (result.stopReason === "error" || result.stopReason === "aborted") throw Error(result.errorMessage ?? "The brief could not be written.");
	const markdown = text(result.content);
	if (!markdown) throw Error("The model returned no brief.");
	const brief: Brief = { markdown, reply: reply?.id ?? null, created: Date.now(), model: modelKey, source: payload ? "cache" : "transcript", usage: result.usage };
	save(brief);
	return brief;
}

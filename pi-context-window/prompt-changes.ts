import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A provider reads a request's prompt from its cache up to the first part that differs from the previous request.
 * When the tool list, the system prompt or an earlier message changes, everything after it is sent at full price
 * again. This records where such a change was and what changed, as a session entry that never enters the context,
 * so a cache miss can be traced to its cause. Changes at the end of the conversation, where new turns are added,
 * are not recorded.
 */
export const PROMPT_CHANGE = "pi-prompt-change";

const LINES = 4;
const LINE_CHARS = 240;

type Snapshot = { model: string; at: number; tools: Map<string, string>; toolsHash: string; system: string[]; messages: string[]; shapes: string[] };
type Payload = { tools?: unknown; system?: unknown; instructions?: unknown; messages?: unknown; input?: unknown };

// Cache breakpoints move to the newest message on every request; they are not part of the prompt.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item) ?? "").digest("base64url").slice(0, 16);
const cut = (line: string) => line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;

function systemText(payload: Payload): string {
	const system = payload.system ?? payload.instructions;
	if (typeof system === "string") return system;
	return Array.isArray(system) ? system.map(block => typeof block?.text === "string" ? block.text : JSON.stringify(block)).join("\n\n") : "";
}

/** Role and block kinds with sizes, enough to tell what kind of edit changed a message. */
function shape(message: unknown): string {
	const item = message as { role?: string; type?: string; content?: unknown };
	const content = item?.content;
	const blocks = typeof content === "string" ? [`text:${content.length}`]
		: Array.isArray(content) ? content.map(block => {
			const part = block as { type?: string; text?: string; content?: unknown; thinking?: string };
			const size = typeof part.text === "string" ? part.text.length : typeof part.thinking === "string" ? part.thinking.length
				: typeof part.content === "string" ? part.content.length : Array.isArray(part.content) ? part.content.length : 0;
			return `${part.type ?? "?"}:${size}`;
		}) : [];
	return `${item?.role ?? item?.type ?? "?"} [${blocks.join(" ")}]`;
}

function snapshot(model: string, payload: Payload): Snapshot {
	const list = Array.isArray(payload.tools) ? payload.tools : [];
	const tools = new Map(list.map((tool, index) => {
		const item = tool as { name?: string; type?: string; function?: { name?: string } };
		return [item.name ?? item.function?.name ?? `${item.type ?? "tool"}#${index}`, hash(tool)] as const;
	}));
	const messages = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
	return { model, at: Date.now(), tools, toolsHash: hash(list), system: systemText(payload).split("\n"),
		messages: messages.map(hash), shapes: messages.map(shape) };
}

/** Where `next` first differs from `previous` before its newest message, or undefined when only the end changed. */
export function promptChange(previous: Snapshot, next: Snapshot): Record<string, unknown> | undefined {
	const base = { model: next.model, idleSeconds: Math.round((next.at - previous.at) / 1000), previousMessages: previous.messages.length };
	if (previous.toolsHash !== next.toolsHash) {
		const added = [...next.tools.keys()].filter(name => !previous.tools.has(name));
		const removed = [...previous.tools.keys()].filter(name => !next.tools.has(name));
		const changed = [...next.tools].filter(([name, value]) => previous.tools.has(name) && previous.tools.get(name) !== value).map(([name]) => name);
		const order = !added.length && !removed.length && !changed.length;
		return { ...base, at: "tools", added, removed, changed, ...(order ? { reordered: true } : {}) };
	}
	if (previous.system.join("\n") !== next.system.join("\n")) {
		let start = 0;
		while (start < previous.system.length && start < next.system.length && previous.system[start] === next.system[start]) start++;
		let end = 0;
		while (end < previous.system.length - start && end < next.system.length - start
			&& previous.system[previous.system.length - 1 - end] === next.system[next.system.length - 1 - end]) end++;
		const removed = previous.system.slice(start, previous.system.length - end), added = next.system.slice(start, next.system.length - end);
		return { ...base, at: "system", line: start + 1, removedLines: removed.length, addedLines: added.length,
			removed: removed.slice(0, LINES).map(cut), added: added.slice(0, LINES).map(cut) };
	}
	const last = previous.messages.length - 1;
	for (let index = 0; index < last; index++) if (previous.messages[index] !== next.messages[index])
		return { ...base, at: "message", index, before: previous.shapes[index], after: next.shapes[index] ?? "(removed)" };
}

export default function promptChanges(pi: ExtensionAPI): void {
	let previous: Snapshot | undefined, session: string | undefined;
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		const id = ctx.sessionManager.getSessionId?.();
		if (!model || !event.payload || typeof event.payload !== "object") return;
		const next = snapshot(model, event.payload as Payload);
		// Another model or conversation has a cache of its own.
		if (!previous || previous.model !== model || session !== id) { previous = next; session = id; return; }
		// Fewer messages: compaction, whose new history is expected to miss, or a side request such as a summary,
		// whose own prompt says nothing about the conversation's. Only the conversation's own requests are kept.
		if (next.messages.length < previous.messages.length - 2) {
			if (next.toolsHash === previous.toolsHash && next.system.join("\n") === previous.system.join("\n")) previous = next;
			return;
		}
		const change = promptChange(previous, next);
		previous = next;
		if (change) pi.appendEntry(PROMPT_CHANGE, change);
	});
}

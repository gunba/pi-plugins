import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, HistoryPage, TranscriptEvent, WorkerMessage } from "../shared/protocol.ts";
import { Transcript } from "./transcript.ts";
import { MESSAGE_TEXT_CHARACTERS, THINKING_CHARACTERS, type HistoryPosition } from "../shared/history.ts";

/** Native message identity, persistence boundaries and bounded deltas for every conversation. */
export class TranscriptFeed {
	private live?: unknown;
	private liveId?: string;
	private revision = 0;
	private epoch = 0;
	private closed = false;
	private tools = new Map<string, ChatMessage>();
	private results = new Map<string, unknown>();
	private aliases = new Map<string, string>();
	private dirtyTools = new Set<string>();
	private dirtyArguments = new Set<number>();
	private previews = new Map<number, number>();
	private clipped = new Set<number>();
	private argumentsSent = new Map<number, string>();
	private timer?: ReturnType<typeof setTimeout>;
	private toolSequence = 0;
	private readonly transcript: Transcript;
	private readonly branch: () => readonly SessionEntry[];
	private readonly generation: () => string;
	private readonly send: (event: WorkerMessage) => void;
	private readonly source?: string;
	private readonly cwd: () => string;
	constructor(transcript: Transcript, branch: () => readonly SessionEntry[], generation: () => string,
		send: (event: WorkerMessage) => void, cwd: () => string, source?: string) {
		this.transcript = transcript; this.branch = branch; this.generation = generation;
		this.send = send; this.source = source; this.cwd = cwd;
	}
	reset(): void {
		this.epoch++; this.live = undefined; this.liveId = undefined;
		clearTimeout(this.timer); this.timer = undefined;
		this.tools.clear(); this.dirtyTools.clear(); this.dirtyArguments.clear();
		this.results.clear(); this.aliases.clear();
		this.previews.clear(); this.clipped.clear(); this.argumentsSent.clear();
	}
	close(): void { this.closed = true; this.reset(); }
	private emit(event: TranscriptEvent): void {
		this.send(this.source ? { type: "transcript", source: this.source, event } : event);
	}
	private toolId(id: string): string { return `live:tool:${id}`; }
	private soon(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), 100);
		this.timer.unref();
	}
	private flush(): void {
		clearTimeout(this.timer); this.timer = undefined;
		if (this.closed) return;
		const generation = this.generation();
		for (const id of this.dirtyTools) {
			const message = this.tools.get(id);
			if (message) this.emit({ type: "chat", generation, message: { ...message, revision: ++this.revision } });
		}
		this.dirtyTools.clear();
		const content = (this.live as { content?: unknown[] } | undefined)?.content;
		if (this.liveId && content) for (const index of this.dirtyArguments) {
			const block = this.transcript.toolCall(content[index], false, this.cwd());
			if (!block || index >= 128) continue;
			const used = [...this.previews].reduce((sum, [key, count]) => key === index ? sum : sum + count, 0);
			const argumentsText = block.arguments.slice(0, Math.max(0, MESSAGE_TEXT_CHARACTERS - used));
			const preview = { ...block, arguments: argumentsText, truncated: block.truncated || argumentsText.length < block.arguments.length };
			const signature = JSON.stringify(preview);
			this.previews.set(index, argumentsText.length);
			if (signature === this.argumentsSent.get(index)) continue;
			this.argumentsSent.set(index, signature);
			this.emit({ type: "block", generation, id: this.liveId, revision: ++this.revision, index, block: preview });
		}
		this.dirtyArguments.clear();
	}
	event(event: AgentSessionEvent): void {
		if (this.closed) return;
		// Nested calls have no native transcript entry. Their bounded record lives
		// on the calling tool's result; treating them as roots leaves orphan rows.
		if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end")
			&& event.parentToolCallId) return;
		const generation = this.generation(), epoch = this.epoch;
		if (event.type === "tool_execution_start") {
			if (this.tools.size >= 128) return;
			if (!this.tools.size) this.toolSequence = 0;
			const message: ChatMessage = { id: this.toolId(event.toolCallId), role: "tool", toolName: event.toolName,
				toolCallId: event.toolCallId, timestamp: Date.now(), revision: ++this.revision,
				order: this.branch().length + (++this.toolSequence) / 1000, blocks: [], complete: false, tool: { state: "running" } };
			this.tools.set(event.toolCallId, message);
			this.emit({ type: "chat", generation, message });
		} else if (event.type === "tool_execution_update") {
			const previous = this.tools.get(event.toolCallId);
			if (!previous) return;
			this.tools.set(event.toolCallId, { ...previous, blocks: this.transcript.progress(event.partialResult, previous.toolName!) });
			this.dirtyTools.add(event.toolCallId); this.soon();
		} else if (event.type === "tool_execution_end") {
			const previous = this.tools.get(event.toolCallId);
			if (!previous) return;
			const result = { ...event.result, role: "toolResult", toolName: event.toolName,
				toolCallId: event.toolCallId, isError: event.isError, timestamp: previous.timestamp };
			this.results.set(event.toolCallId, result);
			const message = this.transcript.message(result, undefined, previous.id, previous.order, this.cwd())!;
			this.tools.set(event.toolCallId, message);
			this.dirtyTools.delete(event.toolCallId);
			this.emit({ type: "chat", generation, message: { ...message, revision: ++this.revision } });
		} else if (event.type === "agent_settled") {
			for (const [id, message] of this.tools) {
				if (message.tool?.state !== "running") continue;
				this.tools.set(id, { ...message, complete: true, tool: { state: "interrupted" } });
				this.dirtyTools.add(id);
			}
			this.flush();
		} else if (event.type === "entry_appended") {
			const branch = this.branch(), order = branch.findIndex(entry => entry.id === event.entry.id);
			const message = order >= 0 ? this.transcript.entry(event.entry, order, this.cwd()) : undefined;
			if (message) {
				if (message.toolCallId) {
					this.replace(this.toolId(message.toolCallId), message.entryId);
					this.tools.delete(message.toolCallId); this.results.delete(message.toolCallId); this.dirtyTools.delete(message.toolCallId);
				}
				this.emit({ type: "chat", generation, message: { ...message, revision: ++this.revision },
					...(message.toolCallId ? { replaces: this.toolId(message.toolCallId) } : {}) });
			}
		} else if (event.type === "compaction_end" && event.result && !event.aborted) {
			// Pi appends compaction entries without an entry_appended event.
			const branch = this.branch();
			let order = branch.length - 1;
			while (order >= 0 && branch[order]!.type !== "compaction") order--;
			const message = order >= 0 ? this.transcript.entry(branch[order]!, order, this.cwd()) : undefined;
			if (message) this.emit({ type: "chat", generation, message: { ...message, revision: ++this.revision } });
		} else if (event.type === "message_update") {
			this.live = event.message;
			const delta = event.assistantMessageEvent;
			if (this.liveId && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
				if (delta.contentIndex >= 128) return;
				const used = [...this.previews.values()].reduce((sum, size) => sum + size, 0);
				const content = event.message.role === "assistant" ? event.message.content : [];
				const thinking = [...this.previews].reduce((sum, [index, size]) => sum + (content[index]?.type === "thinking" ? size : 0), 0);
				const limit = Math.min(MESSAGE_TEXT_CHARACTERS - used, delta.type === "thinking_delta" ? THINKING_CHARACTERS - thinking : Infinity);
				const text = delta.delta.slice(0, Math.max(0, limit));
				const truncated = text.length < delta.delta.length;
				this.previews.set(delta.contentIndex, (this.previews.get(delta.contentIndex) ?? 0) + text.length);
				if (text || truncated && !this.clipped.has(delta.contentIndex)) this.emit({
					type: "delta", generation, id: this.liveId, revision: ++this.revision,
					index: delta.contentIndex, kind: delta.type === "text_delta" ? "text" : "thinking", text, truncated,
				});
				if (truncated) this.clipped.add(delta.contentIndex);
			} else if (delta.type === "toolcall_start" || delta.type === "toolcall_delta" || delta.type === "toolcall_end") {
				this.dirtyArguments.add(delta.contentIndex); this.soon();
			}
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			this.live = event.message;
			this.liveId = `live:${randomUUID()}`;
			this.previews.clear(); this.clipped.clear(); this.argumentsSent.clear();
			const message = this.transcript.message(event.message, undefined, this.liveId, this.branch().length, this.cwd());
			if (message) {
				message.blocks.forEach((block, index) => this.previews.set(index, "text" in block ? block.text.length : block.type === "toolCall" ? block.arguments.length : 0));
				this.emit({ type: "chat", generation, message: { ...message, revision: ++this.revision, complete: false } });
			}
		} else if (event.type === "message_end") {
			const replaces = event.message.role === "assistant" ? this.liveId
				: event.message.role === "toolResult" ? this.toolId(event.message.toolCallId) : undefined;
			if (event.message.role === "assistant") { this.live = undefined; this.liveId = undefined; this.dirtyArguments.clear(); }
			queueMicrotask(() => {
				if (this.closed || epoch !== this.epoch || generation !== this.generation()) return;
				const branch = this.branch();
				const entry = branch.slice().reverse().find(entry =>
					entry.type === "message" && entry.message === event.message
					|| entry.type === "custom_message" && event.message.role === "custom"
						&& entry.customType === event.message.customType && entry.content === event.message.content);
				const message = this.transcript.message(event.message, entry?.id, replaces, entry ? branch.indexOf(entry) : branch.length, this.cwd());
				this.replace(replaces, entry?.id);
				if (message?.toolCallId) { this.tools.delete(message.toolCallId); this.results.delete(message.toolCallId); this.dirtyTools.delete(message.toolCallId); }
				if (message) this.emit({ type: "chat", generation, replaces,
					message: { ...message, revision: ++this.revision, complete: true } });
			});
		}
	}
	private replace(live: string | undefined, entry: string | undefined): void {
		if (!live || !entry) return;
		this.aliases.set(live, entry);
		while (this.aliases.size > 128) this.aliases.delete(this.aliases.keys().next().value!);
	}
	restore(id: string): void {
		if (this.closed) throw new Error("This transcript has closed.");
		const entryId = id.startsWith("entry:") ? id.slice(6) : this.aliases.get(id);
		if (entryId) {
			const branch = this.branch(), index = branch.findIndex(entry => entry.id === entryId);
			if (index >= 0 && this.transcript.entry(branch[index]!, index, this.cwd())) return;
		}
		if (id === this.liveId && this.live) { this.transcript.message(this.live, undefined, id, 0, this.cwd()); return; }
		const result = id.startsWith("live:tool:") ? this.results.get(id.slice(10)) : undefined;
		if (result) { this.transcript.message(result, undefined, id, 0, this.cwd()); return; }
		throw new Error("This message is no longer on the displayed branch. Reopen its transcript.");
	}
	history(position: HistoryPosition = {}): HistoryPage {
		if (this.closed) throw new Error("This transcript has closed.");
		const page = this.transcript.history(this.branch(), position, this.live, this.liveId, this.cwd());
		if (!position.before && !page.after) page.messages.push(...this.tools.values());
		return { ...page, generation: this.generation(), revision: this.revision,
			messages: page.messages.map(message => ({ ...message, revision: this.revision })) };
	}
}

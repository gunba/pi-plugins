import type { ChatMessage } from "../shared/protocol.ts";
import { isEmptyText, type CachedMessage } from "./state.ts";

const noResults: Record<string, ChatMessage> = {};
export interface TranscriptRow {
	message: CachedMessage;
	results: Record<string, ChatMessage>;
	thinking?: ChatMessage[];
	traceContinues?: boolean;
}

/** Join display rows only; native messages retain their identities and reference grants. */
export function transcriptRows(messages: CachedMessage[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [], calls = new Map<string, TranscriptRow>();
	for (const message of messages) {
		if (message.feedback) continue;
		const parent = message.role === "tool" && message.toolCallId ? calls.get(message.toolCallId) : undefined;
		if (parent) { parent.results = { ...parent.results, [message.toolCallId!]: message }; continue; }
		const blocks = message.blocks.filter(block => block && !isEmptyText(block));
		const thinkingOnly = message.role === "assistant" && blocks.length > 0 && blocks.every(block => block.type === "thinking");
		const previous = rows.at(-1);
		if (thinkingOnly && previous?.thinking) { previous.thinking.push(message); continue; }
		const row: TranscriptRow = { message, results: noResults, ...(thinkingOnly ? { thinking: [message] } : {}) };
		rows.push(row);
		if (message.role === "assistant") for (const block of message.blocks) {
			if (block?.type === "toolCall") calls.set(block.id, row);
		}
	}
	const visible = (message: ChatMessage) => message.blocks.filter(block => block && !isEmptyText(block));
	const trace = (block: ChatMessage["blocks"][number] | undefined) => block?.type === "thinking" || block?.type === "toolCall";
	for (let index = 0; index < rows.length - 1; index++) {
		const current = rows[index]!, next = rows[index + 1]!;
		if (current.message.role === "assistant" && next.message.role === "assistant" &&
			trace(visible(current.message).at(-1)) && trace(visible(next.message)[0])) current.traceContinues = true;
	}
	return rows;
}

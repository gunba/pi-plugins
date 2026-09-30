import type { ChatMessage } from "../shared/protocol.ts";
import type { CachedMessage } from "./state.ts";

const noResults: Record<string, ChatMessage> = {};
export interface TranscriptRow {
	message: CachedMessage;
	results: Record<string, ChatMessage>;
}

/** Join display rows only; native messages retain their identities and reference grants. */
export function transcriptRows(messages: CachedMessage[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [], calls = new Map<string, TranscriptRow>();
	for (const message of messages) {
		const parent = message.role === "tool" && message.toolCallId ? calls.get(message.toolCallId) : undefined;
		if (parent) { parent.results = { ...parent.results, [message.toolCallId!]: message }; continue; }
		const row: TranscriptRow = { message, results: noResults };
		rows.push(row);
		if (message.role === "assistant") for (const block of message.blocks) {
			if (block?.type === "toolCall") calls.set(block.id, row);
		}
	}
	return rows;
}

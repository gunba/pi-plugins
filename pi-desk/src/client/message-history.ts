import type { ChatMessage } from "../shared/protocol.ts";
import { splitDictationNote } from "../shared/dictation-note.ts";

/**
 * Your earlier messages in a conversation, oldest first, for the message box to recall with the arrow keys as a
 * terminal does. Messages that arrived shortened are left out (half a message is no use to send again), and a message
 * sent twice in a row is listed once.
 */
export function sentMessages(messages: readonly ChatMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" || message.feedback || message.blocks.some(block => block?.type === "text" && block.truncated)) continue;
		const text = splitDictationNote(message.blocks.flatMap(block => block?.type === "text" ? [block.text] : []).join("\n\n")).text.trim();
		if (text && texts.at(-1) !== text) texts.push(text);
	}
	return texts;
}

/** Where the message box is in that list: the message shown, and what was typed before recalling began. */
export interface Recall { index: number; shown: string; typed: string }

/**
 * The text an arrow key brings, or undefined to let it move the caret. Up recalls from an empty box, or steps back from
 * a recalled message whose caret is on its first line; Down steps forward from its last line, and past the newest
 * returns what was typed. Editing a recalled message ends recalling.
 */
export function recallStep(key: "ArrowUp" | "ArrowDown", draft: string, caret: { start: number; end: number }, sent: readonly string[], recall?: Recall): Recall | { done: string } | undefined {
	const recalling = recall && recall.shown === draft ? recall : undefined;
	if (key === "ArrowUp") {
		if (!recalling && draft !== "") return;
		if (recalling && draft.slice(0, caret.start).includes("\n")) return;
		const index = (recalling ? recalling.index : sent.length) - 1;
		return index >= 0 ? { index, shown: sent[index]!, typed: recalling?.typed ?? draft } : undefined;
	}
	if (!recalling || draft.slice(caret.end).includes("\n")) return;
	const index = recalling.index + 1;
	return index < sent.length ? { index, shown: sent[index]!, typed: recalling.typed } : { done: recalling.typed };
}

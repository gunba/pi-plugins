import { splitDictationNote } from "../shared/dictation-note.ts";

/**
 * The user's last messages in a branch, oldest first, for the message box to recall with Up and Down. From the whole
 * branch, not what the app has loaded: after a long turn, none of the user's messages may be loaded.
 */
export function sentMessageTexts(branch: readonly { type: string; message?: unknown }[], limit = 50): string[] {
	const texts: string[] = [];
	for (let index = branch.length - 1; index >= 0 && texts.length < limit; index--) {
		const entry = branch[index]!;
		const message = entry.type === "message" ? entry.message as { role?: string; content?: unknown } : undefined;
		if (message?.role !== "user") continue;
		const content = message.content;
		const raw = typeof content === "string" ? content
			: Array.isArray(content) ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n\n") : "";
		const text = splitDictationNote(raw).text.trim();
		if (text && texts.at(-1) !== text) texts.push(text);
	}
	return texts.reverse();
}

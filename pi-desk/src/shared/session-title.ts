import { splitDictationNote } from "./dictation-note.ts";

/** Match Pi's saved-session picker: explicit name, then the opening user message. */
export function sessionTitle(name?: string, opening?: string): string {
	return name?.trim() || opening?.replace(/\s+/g, " ").trim().slice(0, 100) || "New conversation";
}
export function openingMessage<Entry>(entries: readonly Entry[], full: (entry: Entry) => Entry = entry => entry): string | undefined {
	for (const entry of entries) {
		const value = full(entry) as { type?: string; message?: { role?: string; content?: unknown } };
		if (value.type !== "message" || value.message?.role !== "user") continue;
		const content = value.message.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join(" ") : "";
		// Desk's note on dictated messages is not part of what the user said.
		if (text.trim()) return splitDictationNote(text).text.replace(/\s+/g, " ").trim().slice(0, 100);
	}
}

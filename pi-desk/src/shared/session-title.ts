/** Match Pi's saved-session picker: explicit name, then the opening user message. */
export function sessionTitle(name?: string, opening?: string): string {
	return name?.trim() || opening?.replace(/\s+/g, " ").trim().slice(0, 100) || "New conversation";
}
export function openingMessage(entries: readonly unknown[]): string | undefined {
	for (const entry of entries) {
		const value = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (value.type !== "message" || value.message?.role !== "user") continue;
		const content = value.message.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join(" ") : "";
		if (text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 100);
	}
}

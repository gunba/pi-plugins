import type { ChatMessage } from "../shared/protocol.ts";

/** Only native custom-message types identify notices; user and assistant prose is untouched. */
export function receivedNotice(message: Record<string, unknown>): { notice?: ChatMessage["notice"]; content: unknown } {
	const content = message.content;
	if (message.role !== "custom") return { content };
	if (message.customType === "pi-party/message" && typeof content === "string") {
		const end = content.indexOf("\n\n"), details = message.details as { sender?: unknown } | undefined;
		const heading = end < 0 ? content : content.slice(0, end);
		const suffix = typeof details?.sender === "string" ? ` (${details.sender})` : "";
		return { notice: { kind: "party", title: (suffix && heading.endsWith(suffix) ? heading.slice(0, -suffix.length) : heading).slice(0, 200) },
			content: end < 0 ? "" : content.slice(end + 2) };
	}
	if (message.customType === "pi-work/wake-v1") {
		if (typeof content === "string" && /^Managed process \d+ /.test(content)) {
			const end = content.indexOf("\n");
			return { notice: { kind: "process", title: (end < 0 ? content : content.slice(0, end)).slice(0, 200) },
				content: end < 0 ? "" : content.slice(end + 1) };
		}
		return { notice: { kind: "work", title: "Work completed" }, content };
	}
	if (message.customType === "pi-subagents/notice") return { notice: { kind: "agent", title: "Agent update" }, content };
	return { content };
}

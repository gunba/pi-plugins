import type { WorkSection } from "../../pi-work-ui/index.ts";
import type { ScheduledMessage } from "./store.ts";

export function scheduledWorkSection(messages: readonly ScheduledMessage[], attempted: ReadonlySet<string>): WorkSection | undefined {
	const next = messages[0];
	if (!next) return undefined;
	const delivering = messages.filter(message => attempted.has(message.id)).length;
	return {
		label: "Scheduled",
		status: `${messages.length} pending${delivering ? ` · ${delivering} delivering` : ""}`,
		summary: `${new Date(next.dueAt).toLocaleString()} · ${next.message}`,
		tone: delivering ? "warning" : "accent",
		detail: [
			...messages.map(message => [
				`#${message.id} · ${attempted.has(message.id) ? "delivery pending" : "scheduled"}`,
				`Due: ${new Date(message.dueAt).toLocaleString()}`,
				`Queued: ${new Date(message.createdAt).toLocaleString()}`,
				`Delivery: ${message.delivery === "steer" ? "steering" : "follow-up"}`,
				"", message.message,
			].join("\n")),
			"/schedule cancel <id> · /schedule clear",
		].join("\n\n"),
	};
}

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage } from "../shared/protocol.ts";

type WatchEvent = { id?: unknown; title?: unknown; status?: unknown; command?: unknown; output?: unknown; log?: unknown };
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
/** A watch's log as a Markdown link the viewer opens (file-links.ts); the path as written when it isn't one. */
function logLink(path: string): string {
	try {
		const href = pathToFileURL(path).href.replaceAll("(", "%28").replaceAll(")", "%29");
		return `[${basename(path).replace(/[\\[\]]/g, "\\$&")}](${href})`;
	} catch { return path; }
}
/** A watch's wake, titled by what the watch is for and what happened; its output and log follow (pi-watch's WatchEvent). */
function watchNotice(details: unknown, content: unknown): { notice: NonNullable<ChatMessage["notice"]>; content: unknown } {
	const record = details && typeof details === "object" ? details as { watches?: unknown; events?: unknown } : {};
	const events = (Array.isArray(record.events) ? record.events : []).filter((event): event is WatchEvent => !!event && typeof event === "object");
	const first = events[0];
	// Wakes saved before watches described their events show the agent's text as it was.
	if (!first || !text(first.title, 200)) {
		const ids = Array.isArray(record.watches) ? record.watches.filter(id => typeof id === "string") : [];
		// Their first line ends with what happened: "Watch w1 (…) ended: it exited with code 1.", "Watch w2: it's …, the time you set."
		const first = typeof content === "string" ? content.split("\n", 1)[0]! : "";
		const note = /\) (has new output|checked|changed|ended: .+?)[.:]?$/.exec(first)?.[1] ?? /^Watch [\w-]+: (.+?)\.?$/.exec(first)?.[1];
		const plain = note?.replace(/^has new output/, "new output").replace(/^(checked|changed)$/, "output $1");
		const detail = plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : undefined;
		return { notice: { kind: "watch", title: ids.length ? `Watch ${ids.join(", ")}` : "Watch", ...(detail ? { detail: detail.slice(0, 300) } : {}) },
			content: typeof content === "string" ? content.replace(/^Full output: (.+)$/gm, (_line, path: string) => `Full output: ${logLink(path.trim())}`) : content };
	}
	const fence = (value: string) => "`".repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1)));
	const body = events.map(event => {
		const output = text(event.output, 8_000), command = text(event.command, 2_000), log = text(event.log, 1_000);
		return [events.length > 1 ? `**${text(event.title, 200)}**: ${text(event.status, 300)}` : "",
			output ? `${fence(output)}\n${output}\n${fence(output)}` : "",
			command ? `Command: \`${command.replaceAll("`", "'")}\`` : "", log ? `Full output: ${logLink(log)}` : ""].filter(Boolean).join("\n\n");
	}).join("\n\n");
	return { notice: { kind: "watch", title: `${text(first.title, 200)}${events.length > 1 ? ` and ${events.length - 1} more` : ""}`,
		detail: text(first.status, 300) }, content: body };
}

/** Only native custom-message types identify notices; user and assistant prose is untouched. */
export function receivedNotice(message: Record<string, unknown>): { notice?: ChatMessage["notice"]; content: unknown } {
	const content = message.content;
	if (message.role !== "custom") return { content };
	// Retain the attribution of reminders already saved in native histories.
	if (message.customType === "pi-scheduler-scheduled-message") {
		const details = message.details as { message?: unknown; createdAt?: unknown; dueAt?: unknown } | undefined;
		if (typeof details?.message === "string" && typeof details.createdAt === "number" && Number.isFinite(details.createdAt) &&
			typeof details.dueAt === "number" && Number.isFinite(details.dueAt)) {
			return { notice: { kind: "schedule", title: "Scheduled message", queuedAt: details.createdAt, dueAt: details.dueAt }, content: details.message };
		}
	}
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
	if (message.customType === "pi-watch/event") return watchNotice(message.details, content);
	return { content };
}

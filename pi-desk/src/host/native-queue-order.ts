import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface PendingQueue { messages: unknown[] }
interface QueueInternals {
	_steeringMessages: string[]; _followUpMessages: string[]; _emitQueueUpdate(): void;
	agent: { steeringQueue: PendingQueue; followUpQueue: PendingQueue };
}

const queuedText = (message: unknown): string | undefined => {
	const value = message as { role?: string; content?: { type?: string; text?: string }[] };
	return value?.role === "user" && Array.isArray(value.content) && value.content[0]?.type === "text" ? value.content[0].text : undefined;
};

const messageIds = new WeakMap<object, string>();
function messageId(message: object): string {
	let id = messageIds.get(message);
	if (!id) { id = randomUUID(); messageIds.set(message, id); }
	return id;
}

/** Stable identities refer to native messages, not their position or possibly identical previews. */
export function queuedMessageIds(session: AgentSession, queue: "steering" | "followUp"): (string | null)[] {
	const native = session as unknown as QueueInternals;
	const pending = queue === "steering" ? native.agent?.steeringQueue : native.agent?.followUpQueue;
	const texts = queue === "steering" ? session.getSteeringMessages() : session.getFollowUpMessages();
	const matches = new Map<string, object[]>(), occurrences = new Map<string, number>();
	for (const message of pending?.messages ?? []) {
		const text = queuedText(message);
		if (text === undefined) continue;
		const values = matches.get(text) ?? [];
		values.push(message as object); matches.set(text, values);
	}
	return texts.map(text => {
		const occurrence = occurrences.get(text) ?? 0;
		occurrences.set(text, occurrence + 1);
		const message = matches.get(text)?.[occurrence];
		return message ? messageId(message) : null;
	});
}

/** Read or replace a waiting message atomically; an edit keeps its attachments and place in the queue. */
export function editQueued(session: AgentSession, queue: "steering" | "followUp", id: string, change?: { original: string; text: string }): string {
	const native = session as unknown as QueueInternals;
	const pending = queue === "steering" ? native.agent?.steeringQueue : native.agent?.followUpQueue;
	const texts = queue === "steering" ? native._steeringMessages : native._followUpMessages;
	if (!Array.isArray(texts) || !Array.isArray(pending?.messages) || typeof native._emitQueueUpdate !== "function")
		throw new Error("This Pi version cannot edit waiting messages.");
	const index = queuedMessageIds(session, queue).indexOf(id);
	const message = pending.messages.find(message => message && typeof message === "object" && messageIds.get(message) === id) as
		{ content: { type: string; text?: string }[] } | undefined;
	if (index < 0 || !message) throw new Error("That message is no longer waiting. Your edit has not been sent.");
	const text = texts[index]!;
	if (!change) return text;
	if (change.original !== text) throw new Error("That message was edited elsewhere. Reopen it before saving.");
	if (!change.text.trim()) throw new Error("A waiting message cannot be empty. Cancel it instead.");
	message.content[0] = { ...message.content[0]!, text: change.text };
	texts[index] = change.text;
	native._emitQueueUpdate();
	return change.text;
}

/**
 * Take one waiting message, steering or follow-up, out of Pi's queue so it is never sent. Pi has no per-message removal;
 * like promoteFollowUp, this uses its queue fields and refuses if their shape changed.
 */
export function cancelQueued(session: AgentSession, queue: "steering" | "followUp", index: number, text: string): void {
	const native = session as unknown as QueueInternals;
	const pending = queue === "steering" ? native.agent?.steeringQueue : native.agent?.followUpQueue;
	const texts = queue === "steering" ? native._steeringMessages : native._followUpMessages;
	if (!Array.isArray(texts) || !Array.isArray(pending?.messages) || typeof native._emitQueueUpdate !== "function")
		throw new Error("This Pi version cannot cancel one waiting message.");
	if (texts[index] !== text) throw new Error("That message is no longer waiting.");
	// Duplicate texts are matched in order, the same way Pi removes delivered messages.
	const occurrence = texts.slice(0, index).filter(item => item === text).length;
	const position = pending.messages.map((message, at) => [queuedText(message), at] as const).filter(([value]) => value === text)[occurrence]?.[1];
	if (position === undefined) throw new Error("That message is no longer waiting.");
	pending.messages.splice(position, 1);
	const rest = texts.filter((_item, at) => at !== index);
	if (queue === "steering") native._steeringMessages = rest; else native._followUpMessages = rest;
	native._emitQueueUpdate();
}

/**
 * Move one queued follow-up, including its images, to the end of steering.
 * Pi 1.1 has no per-message dequeue, so this uses its queue fields and refuses if their shape changed.
 */
export function promoteFollowUp(session: AgentSession, index: number, text: string): void {
	const native = session as unknown as QueueInternals;
	const { steeringQueue, followUpQueue } = native.agent ?? {};
	if (!Array.isArray(native._steeringMessages) || !Array.isArray(native._followUpMessages) || typeof native._emitQueueUpdate !== "function"
		|| !Array.isArray(steeringQueue?.messages) || !Array.isArray(followUpQueue?.messages))
		throw new Error("This Pi version cannot reorder queued messages. Cancel the message and send it again.");
	if (native._followUpMessages[index] !== text) throw new Error("That message is no longer queued.");
	// Duplicate texts are matched in order, the same way Pi removes delivered messages.
	const occurrence = native._followUpMessages.slice(0, index).filter(item => item === text).length;
	const position = followUpQueue.messages.map((message, at) => [queuedText(message), at] as const)
		.filter(([value]) => value === text)[occurrence]?.[1];
	if (position === undefined) throw new Error("That message is no longer queued.");
	const [message] = followUpQueue.messages.splice(position, 1);
	steeringQueue.messages = [...steeringQueue.messages, message];
	native._followUpMessages = native._followUpMessages.filter((_item, at) => at !== index);
	native._steeringMessages = [...native._steeringMessages, text];
	native._emitQueueUpdate();
}

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

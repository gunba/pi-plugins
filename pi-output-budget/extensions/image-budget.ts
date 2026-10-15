import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["messages"][number];

/**
 * Base64 image data a request may carry. Anthropic refuses requests over 32 MB, and its server drops the upload
 * part-way, which the SDK reports only as "Connection error." Every request resends every image in the context, so
 * a long session that views screenshots and generates images crosses the limit and then fails on every turn: on
 * 15 October a Work PC conversation held 57 images, 67 MB of base64, at only 677k tokens. This leaves room for a
 * 1M-token text context beside the images.
 */
export const IMAGE_REQUEST_BYTES = 20 * 1024 * 1024;
/** Older images are dropped this many at a time, so the request prefix, and the provider cache, changes rarely. */
const DROP_STEP = 8;
export const OMITTED_IMAGE_NOTE = "[An earlier image was left out of this request to keep it under the provider's size limit. View it again if you need it.]";

type Part = { type: string; data?: string; text?: string };
const images = (message: AgentMessage): Part[] => {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? (content as Part[]).filter(part => part?.type === "image" && typeof part.data === "string") : [];
};

/**
 * Keep the newest images within the budget and replace older ones with a note. Deterministic over the history and
 * monotonic as it grows: an image once left out stays out, and the cut moves in steps of DROP_STEP images.
 * Returns the same array when nothing changes.
 */
export function boundImages(messages: AgentMessage[], budget = IMAGE_REQUEST_BYTES): AgentMessage[] {
	const sizes: number[] = [];
	for (const message of messages) for (const part of images(message)) sizes.push(part.data!.length);
	let total = sizes.reduce((sum, size) => sum + size, 0), needed = 0;
	while (total > budget && needed < sizes.length) total -= sizes[needed++]!;
	if (!needed) return messages;
	// The newest image is always kept: the agent has just asked to see it.
	const drop = Math.min(Math.ceil(needed / DROP_STEP) * DROP_STEP, sizes.length - 1);
	if (drop <= 0) return messages;
	let seen = 0;
	return messages.map(message => {
		const parts = images(message);
		if (!parts.length || seen >= drop) { seen += parts.length; return message; }
		const content = ((message as { content: Part[] }).content).map(part => {
			if (part?.type !== "image" || typeof part.data !== "string" || seen >= drop) return part;
			seen++;
			return { type: "text", text: OMITTED_IMAGE_NOTE };
		});
		return { ...message, content } as AgentMessage;
	});
}

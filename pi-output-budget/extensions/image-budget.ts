import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Anthropic refuses requests over 32 MB and drops the upload part-way, which its SDK reports only as
 * "Connection error.". Every request resends every image in the context, so a conversation that views many
 * screenshots crosses the limit and then fails on every turn (Work PC, 15 October: 57 images, 67 MB).
 * Images are shrunk when captured, so this is rare. When a request would still exceed the limit, the oldest images
 * are replaced in the saved conversation once, with a native context edit, until those left total KEEP_BYTES.
 * Later requests are built from the edited history, so the prompt cache only changes when this happens.
 */
const ANTHROPIC_LIMIT = 32 * 1024 * 1024 - 256 * 1024;
const KEEP_BYTES = 16 * 1024 * 1024;
export const OMITTED_IMAGE_NOTE = "[An earlier image was removed to keep requests under the provider's size limit. View it again if you need it.]";

type Part = { type?: string; data?: string; text?: string };
type Imaged = { id: string; content: Part[] };

/** The oldest images to replace so the rest total at most keepBytes; the newest image is always kept. */
export function oldestImages(entries: Imaged[], keepBytes = KEEP_BYTES): Map<string, Part[]> {
	const images = entries.flatMap(entry => entry.content.filter(part => part?.type === "image" && typeof part.data === "string").map(part => ({ entry, part })));
	let total = images.reduce((sum, { part }) => sum + part.data!.length, 0);
	const omit = new Set<Part>();
	for (const { part } of images.slice(0, -1)) {
		if (total <= keepBytes) break;
		omit.add(part); total -= part.data!.length;
	}
	const edits = new Map<string, Part[]>();
	for (const entry of entries) if (entry.content.some(part => omit.has(part)))
		edits.set(entry.id, entry.content.map(part => omit.has(part) ? { type: "text", text: OMITTED_IMAGE_NOTE } : part));
	return edits;
}

/** The request with the given image data replaced by the note, wherever it appears. */
function withoutImages(value: unknown, omitted: Set<string>): unknown {
	if (Array.isArray(value)) return value.map(item => withoutImages(item, omitted));
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>, source = record.source as { data?: unknown } | undefined;
	if (record.type === "image" && typeof source?.data === "string" && omitted.has(source.data)) return { type: "text", text: OMITTED_IMAGE_NOTE };
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutImages(item, omitted)]));
}

export function capAnthropicImages(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages" || Buffer.byteLength(JSON.stringify(event.payload)) <= ANTHROPIC_LIMIT) return;
		const manager = ctx.sessionManager as unknown as SessionManager;
		const entries = manager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }) => {
			const content = messages.length === 1 ? (messages[0] as { content?: unknown }).content : undefined;
			return Array.isArray(content) && content.some(part => part?.type === "image") ? [{ id: sourceEntry.id, content: content as Part[] }] : [];
		});
		const edits = oldestImages(entries);
		if (!edits.size) return;
		const omitted = new Set<string>();
		for (const entry of entries) if (edits.has(entry.id))
			for (const part of entry.content) if (part.type === "image" && !edits.get(entry.id)!.includes(part)) omitted.add(part.data!);
		for (const [id, content] of edits) manager.appendContextEdit(id, { content: content as never });
		return withoutImages(event.payload, omitted);
	});
}

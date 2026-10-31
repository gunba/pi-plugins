import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { freeMoment } from "./superseded.ts";

/**
 * A request that is too large is dropped part-way through its upload, which Anthropic's SDK reports only as
 * "Connection error.". Every request resends every image in the context, so a conversation that views many
 * screenshots crosses the limit and then fails on every turn (Work PC, 15 October: 57 images, 67 MB, after requests
 * with 62 MB of images had succeeded). Anthropic documents 128 MB, and a 120 MB request through a Claude subscription
 * succeeded from Linux on 31 October; the limit stays below what failed on the Work PC.
 * Images are shrunk when captured, so this is rare. The oldest images are replaced in the saved conversation, with a
 * native context edit, until those left total KEEP_BYTES. That changes the prompt from the first image replaced, so
 * the whole conversation after it is sent again at full price: it is done when a request would exceed the limit, or
 * earlier, past FREE_LIMIT, when the request pays for its whole prompt anyway. Later requests are built from the
 * edited history.
 */
const ANTHROPIC_LIMIT = 60 * 1024 * 1024;
const FREE_LIMIT = 40 * 1024 * 1024;
const KEEP_BYTES = 30 * 1024 * 1024;
export const OMITTED_IMAGE_NOTE = "[An earlier image was removed to keep requests under the provider's size limit. View it again if you need it.]";
/** The text Pi's Anthropic conversion puts before a tool result that has images and no text. */
const IMAGE_ONLY_PLACEHOLDER = "(see attached image)";

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

/**
 * The request with the given image data replaced by the note, wherever it appears, in the form Pi gives the edited
 * history on the next request; any difference would make that request miss the cache again. Pi adds a placeholder
 * text before a tool result's images when it has no text, which the note now is, and sends a tool result with no
 * images left as its texts joined into one string.
 */
export function withoutImages(value: unknown, omitted: Set<string>): unknown {
	if (Array.isArray(value)) return value.map(item => withoutImages(item, omitted));
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>, source = record.source as { data?: unknown } | undefined;
	if (record.type === "image" && typeof source?.data === "string" && omitted.has(source.data)) return { type: "text", text: OMITTED_IMAGE_NOTE };
	const next = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutImages(item, omitted)]));
	const original = record.content as { type?: string; text?: string; source?: { data?: unknown } }[];
	if (record.type === "tool_result" && Array.isArray(original)
		&& original.some(block => block?.type === "image" && typeof block.source?.data === "string" && omitted.has(block.source.data))) {
		let blocks = next.content as Part[];
		if (original[0]?.type === "text" && original[0].text === IMAGE_ONLY_PLACEHOLDER && original.filter(block => block?.type === "text").length === 1)
			blocks = blocks.slice(1);
		next.content = blocks.every(block => block?.type === "text") ? blocks.map(block => block.text ?? "").join("\n") : blocks;
	}
	return next;
}

export function capAnthropicImages(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") return;
		const size = Buffer.byteLength(JSON.stringify(event.payload));
		if (size <= FREE_LIMIT || size <= ANTHROPIC_LIMIT && !freeMoment(ctx.model, ctx.sessionManager.getBranch() as never)) return;
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

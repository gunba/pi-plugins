import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * Why an image file cannot be read, or undefined when its structure is sound: PNG chunk CRCs and IEND, JPEG start
 * and end markers, the GIF trailer and the WebP RIFF size. Cheap enough to run on every image a request carries.
 */
export function imageDamage(data: Uint8Array): string | undefined {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		let at = 8, sawData = false;
		while (at + 12 <= bytes.length) {
			const length = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8);
			if (at + 12 + length > bytes.length) return `PNG chunk ${type} at byte ${at} runs past the end of the file`;
			if ((crc32(bytes.subarray(at + 4, at + 8 + length)) >>> 0) !== bytes.readUInt32BE(at + 8 + length)) return `PNG chunk ${type} at byte ${at} is corrupt`;
			if (type === "IDAT") sawData = true;
			if (type === "IEND") return sawData ? undefined : "PNG has no image data";
			at += 12 + length;
		}
		return "PNG ends before its IEND chunk";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		// Trailing padding after the end marker is common; the marker must be near the end.
		const tail = bytes.subarray(Math.max(0, bytes.length - 64));
		return tail.includes(Buffer.from([0xff, 0xd9])) ? undefined : "JPEG ends before its end marker";
	}
	if (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return bytes.at(-1) === 0x3b ? undefined : "GIF ends before its trailer";
	if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
		return bytes.length >= 8 && bytes.readUInt32LE(4) + 8 <= bytes.length ? undefined : "WebP is shorter than its declared size";
}

export const DAMAGED_IMAGE_NOTE = (reason: string) => `[An attached image could not be read and was left out: ${reason}.]`;

type Content = { type: string; data?: string; mimeType?: string; text?: string };
type Message = { role: string; content?: unknown; timestamp?: number; stopReason?: string; errorMessage?: string };
const REJECTED = /could not process image|invalid[_ ]image|image (?:is )?(?:invalid|corrupt|unsupported|could not be (?:processed|decoded))|unsupported image/i;
const checked = new Map<string, string | undefined>();
// The same image is the same object in every request of a conversation: looked up without hashing it again.
const verdicts = new WeakMap<Content, string | undefined>();
function damageOf(image: Content): string | undefined {
	if (verdicts.has(image)) return verdicts.get(image);
	const damage = damageByContent(image);
	verdicts.set(image, damage);
	return damage;
}
function damageByContent(image: Content): string | undefined {
	const data = image.data ?? "", key = createHash("sha1").update(data).digest("hex");
	if (!checked.has(key)) {
		let damage: string | undefined;
		try { damage = imageDamage(Buffer.from(data, "base64")); } catch { damage = "it is not valid base64"; }
		checked.set(key, damage);
		if (checked.size > 500) checked.delete(checked.keys().next().value!);
	}
	return checked.get(key);
}
/**
 * Images left out of the provider request, never the session: damaged ones, and those sent in a turn the provider
 * rejected for an image, so one bad file cannot make every later request in the conversation fail.
 */
export function withoutUnreadableImages<T extends Message>(messages: T[], rejectedAt: number[]): T[] | undefined {
	// The turn a rejection answered: after the last request that succeeded before it.
	const windows = rejectedAt.map(at => {
		const before = messages.filter(message => message.role === "assistant" && message.stopReason !== "error" && (message.timestamp ?? 0) < at);
		return [Math.max(0, ...before.map(message => message.timestamp ?? 0)), at] as const;
	});
	let changed = false;
	const next = messages.map(message => {
		if (!Array.isArray(message.content) || !message.content.some((part: Content) => part?.type === "image")) return message;
		const rejected = windows.some(([from, to]) => (message.timestamp ?? 0) > from && (message.timestamp ?? 0) <= to);
		let replaced = false;
		const content = (message.content as Content[]).map(part => {
			if (part?.type !== "image") return part;
			const reason = rejected ? "the model's provider could not process it" : damageOf(part);
			if (!reason) return part;
			replaced = changed = true;
			return { type: "text", text: DAMAGED_IMAGE_NOTE(reason) };
		});
		return replaced ? { ...message, content } : message;
	});
	return changed ? next : undefined;
}
/** Timestamps of requests a provider rejected because of an image, from the session branch. */
export function imageRejections(branch: readonly { type: string; message?: Message }[]): number[] {
	return branch.flatMap(entry => entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "error"
		&& REJECTED.test(entry.message.errorMessage ?? "") ? [entry.message.timestamp ?? 0] : []);
}

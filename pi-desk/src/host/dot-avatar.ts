import { resizeImage, convertToPng } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import type { DotHttp } from "./dot-http.ts";

const MAXIMUM = 4 * 1024 * 1024;
export async function dotAvatar(bytes: Buffer, mime: string): Promise<string> {
	if (bytes.length > MAXIMUM || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) throw Error("Unsupported Dot avatar.");
	const size = getImageDimensions(bytes.toString("base64"), mime);
	if (!size || size.widthPx < 1 || size.heightPx < 1 || size.widthPx > 4096 || size.heightPx > 4096) throw Error("Dot avatar dimensions are too large.");
	const resized = await resizeImage(bytes, mime, { maxWidth: 128, maxHeight: 128, maxBytes: 64_000 });
	const png = resized && await convertToPng(resized.data, resized.mimeType);
	if (!png || png.mimeType !== "image/png" || png.data.length > 100_000) throw Error("Dot avatar could not be prepared.");
	return `data:image/png;base64,${png.data}`;
}

export class DotAvatar {
	private source?: string;
	private image?: string;
	private fetched = 0;
	private work?: Promise<string | undefined>;
	private abort?: AbortController;
	private generation = 0;
	private changed: () => void;
	constructor(changed: () => void) { this.changed = changed; }
	get value(): string | undefined { return this.image; }
	error?: string;
	get(http: Pick<DotHttp, "asset">, source: string | undefined, signal: AbortSignal): Promise<string | undefined> {
		if (this.source === source && this.work) return this.work;
		if (this.source === source && (this.image || Date.now() - this.fetched < 60_000)) return Promise.resolve(this.image);
		this.abort?.abort(); this.abort = new AbortController();
		const ownAbort = this.abort.signal;
		const epoch = ++this.generation, abort = AbortSignal.any([signal, ownAbort, AbortSignal.timeout(10_000)]);
		this.source = source; this.image = undefined; this.error = undefined; this.work = undefined;
		if (!source) return Promise.resolve(undefined);
		const job = (async () => {
			try {
				const { bytes, mime } = await http.asset(source, { maximum: MAXIMUM, signal: abort });
				const image = await dotAvatar(bytes, mime); abort.throwIfAborted();
				if (epoch === this.generation) this.image = image;
				return image;
			} catch {
				if (epoch === this.generation && !signal.aborted && !ownAbort.aborted) this.error = "Dot's avatar is temporarily unavailable.";
				return undefined;
			} finally {
				if (epoch === this.generation) {
					this.work = undefined; this.fetched = Date.now();
					if (!signal.aborted && !ownAbort.aborted) this.changed();
				}
			}
		})();
		this.work = job; return job;
	}
}

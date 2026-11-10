export interface BlobLease { loaded: Promise<string>; release: () => void }
interface Entry {
	key: string; references: number; load: () => Promise<Blob>; url?: string; at?: number;
	loaded: Promise<string>; resolve: (url: string) => void; reject: (error: unknown) => void;
}

/**
 * Only consumers retain URLs, apart from the last `keep` released ones, which stay loaded in case they are wanted
 * again soon. Queued transfers with no consumers never start.
 */
export class BlobPool {
	private entries = new Map<string, Entry>();
	/** Loaded entries no consumer holds, least recently used first. */
	private idle = new Map<string, Entry>();
	private queue: Entry[] = [];
	private active = 0;
	private readonly concurrency: number;
	private readonly keep: number;
	constructor(concurrency = 2, keep = 0) { this.concurrency = concurrency; this.keep = keep; }

	/** The URL of a loaded entry, and when it loaded (performance.now()), without taking a lease on it. */
	peek(key: string): { url: string; at: number } | undefined {
		const entry = this.entries.get(key);
		if (!entry?.url) return;
		if (this.idle.delete(key)) this.idle.set(key, entry);
		return { url: entry.url, at: entry.at! };
	}

	acquire(key: string, load: () => Promise<Blob>): BlobLease {
		let entry = this.entries.get(key);
		if (!entry) {
			let resolve!: Entry["resolve"], reject!: Entry["reject"];
			const loaded = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
			entry = { key, references: 0, load, loaded, resolve, reject };
			this.entries.set(key, entry); this.queue.push(entry);
		}
		this.idle.delete(key);
		entry.references++;
		this.drain();
		let released = false;
		return { loaded: entry.loaded, release: () => {
			if (released) return;
			released = true;
			if (--entry.references !== 0 || !entry.url) return;
			if (this.entries.get(key) !== entry) { URL.revokeObjectURL(entry.url); return; }
			this.idle.set(key, entry);
			for (const [oldest, old] of this.idle) {
				if (this.idle.size <= this.keep) break;
				this.idle.delete(oldest); this.entries.delete(oldest); URL.revokeObjectURL(old.url!);
			}
		} };
	}
	private drain(): void {
		while (this.active < this.concurrency && this.queue.length) {
			const entry = this.queue.shift()!;
			if (!entry.references) {
				this.entries.delete(entry.key);
				entry.reject(new DOMException("Preview closed.", "AbortError"));
				continue;
			}
			this.active++;
			void this.run(entry);
		}
	}
	private async run(entry: Entry): Promise<void> {
		try {
			const blob = await entry.load();
			if (!entry.references) throw new DOMException("Preview closed.", "AbortError");
			entry.url = URL.createObjectURL(blob); entry.at = performance.now(); entry.resolve(entry.url);
		} catch (error) {
			if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
			entry.reject(error);
		} finally { this.active--; this.drain(); }
	}
}

export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
	const text = atob(base64), bytes = new Uint8Array(text.length);
	for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
	return bytes;
}

export interface BlobLease { loaded: Promise<string>; release: () => void }
interface Entry {
	key: string; references: number; load: () => Promise<Blob>; url?: string;
	loaded: Promise<string>; resolve: (url: string) => void; reject: (error: unknown) => void;
}

/** Only consumers retain URLs. Queued transfers with no consumers never start. */
export class BlobPool {
	private entries = new Map<string, Entry>();
	private queue: Entry[] = [];
	private active = 0;
	private readonly concurrency: number;
	constructor(concurrency = 2) { this.concurrency = concurrency; }

	acquire(key: string, load: () => Promise<Blob>): BlobLease {
		let entry = this.entries.get(key);
		if (!entry) {
			let resolve!: Entry["resolve"], reject!: Entry["reject"];
			const loaded = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
			entry = { key, references: 0, load, loaded, resolve, reject };
			this.entries.set(key, entry); this.queue.push(entry);
		}
		entry.references++;
		this.drain();
		let released = false;
		return { loaded: entry.loaded, release: () => {
			if (released) return;
			released = true;
			if (--entry.references === 0 && entry.url) {
				URL.revokeObjectURL(entry.url);
				if (this.entries.get(key) === entry) this.entries.delete(key);
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
			entry.url = URL.createObjectURL(blob); entry.resolve(entry.url);
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

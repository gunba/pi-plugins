import { Buffer } from "node:buffer";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CHUNK = 1 << 20;
/** An entry line starts `{"type":"…","id":"…"`; the ID is found within its first few hundred bytes. */
const ID = /"id":"([^"]+)"/;

/**
 * A session's JSONL file read entry by entry, for payloads released from memory. Each line's position is indexed on
 * first use and the index extends as Pi appends; a read is one line, so history is shown without loading the file.
 */
export class SessionArchive {
	readonly file: string;
	private readonly lines = new Map<string, { offset: number; length: number }>();
	private indexed = 0;
	constructor(file: string) { this.file = file; }

	/** The saved entry with this ID, or undefined when the file has none. */
	entry(id: string): SessionEntry | undefined {
		if (!this.lines.has(id)) this.extend(id);
		const line = this.lines.get(id);
		if (!line) return;
		const fd = openSync(this.file, "r");
		try {
			const buffer = Buffer.alloc(line.length);
			readSync(fd, buffer, 0, line.length, line.offset);
			const entry = JSON.parse(buffer.toString("utf8")) as SessionEntry;
			return entry.id === id ? entry : undefined;
		} catch { return; }
		finally { closeSync(fd); }
	}

	/** Indexes lines not yet seen, stopping once `wanted` is found: the first user message is near the start. */
	private extend(wanted: string): void {
		const fd = openSync(this.file, "r");
		try {
			const size = fstatSync(fd).size, buffer = Buffer.alloc(CHUNK);
			let start = this.indexed, carry = Buffer.alloc(0);
			while (start + carry.length < size && !this.lines.has(wanted)) {
				const read = readSync(fd, buffer, 0, Math.min(CHUNK, size - start - carry.length), start + carry.length);
				if (!read) break;
				const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
				let from = 0;
				for (let end = data.indexOf(10); end >= 0; from = end + 1, end = data.indexOf(10, from)) {
					const id = ID.exec(data.subarray(from, Math.min(end, from + 400)).toString("utf8"))?.[1];
					if (id) this.lines.set(id, { offset: start + from, length: end - from });
				}
				// A line still being written, or longer than a chunk, is finished on the next pass.
				start += from;
				carry = Buffer.from(data.subarray(from));
			}
			this.indexed = start;
		} finally { closeSync(fd); }
	}
}

/** Whether pruning released this entry's payload from memory (pruneCompactedSession), so it must come from the file. */
export function released(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message": {
			const message = entry.message as unknown as Record<string, unknown>;
			return Array.isArray(message.content) && message.content.length === 0 || message.output === "";
		}
		case "compaction":
		case "branch_summary":
			return entry.summary === "";
		case "custom_message":
			return Array.isArray(entry.content) && entry.content.length === 0;
		default:
			return false;
	}
}

/** The entry with its payload, read back from the file when pruning released it. Memory keeps the pruned entry. */
export function withPayload(entry: SessionEntry, archive: SessionArchive | undefined): SessionEntry {
	if (!archive || !released(entry)) return entry;
	const saved = archive.entry(entry.id);
	return saved && saved.type === entry.type ? saved : entry;
}

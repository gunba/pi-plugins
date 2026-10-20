import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies of conversations kept away from their own computer, so one can be resumed on another computer even when its
 * own is off (a laptop's battery ran out and every conversation on it was out of reach).
 *
 * A computer that keeps copies (the workspace server) receives each other computer's conversation files as they grow:
 * Pi only appends to them, so only new lines are sent. A file that shrank or whose beginning changed (Pi rewrote it) is
 * sent again from the start. Copies go 30 days after their conversation was last active.
 */
import type { ConversationCopy } from "../shared/protocol.ts";
export type CopyInfo = ConversationCopy;
/** What a computer sends: its conversation's next bytes, from `offset`, whole lines only. */
export type CopyChunk = { session: string; cwd: string; title?: string; offset: number; data: string; total: number; head: string; updated: number };

const KEPT_DAYS = 30, HEAD = 64 * 1024, CHUNK = 4 * 1024 * 1024, ROUND = 16 * 1024 * 1024;
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/, COMPUTER = /^[a-f0-9-]{36}$/;

/** The first bytes' hash: a file Pi rewrote no longer starts the same way. */
export function fileHead(path: string): string {
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(HEAD), read = readSync(descriptor, buffer, 0, HEAD, 0);
		return createHash("sha256").update(buffer.subarray(0, read)).digest("hex").slice(0, 32);
	} finally { closeSync(descriptor); }
}
const LONGEST = 16 * 1024 * 1024;
/**
 * Bytes of `path` from `offset`, about `limit` of them, ending at a line break (a line still being written waits). A line
 * longer than the limit (a result holding several screenshots) is read whole, up to 16 MB; one longer still is sent in
 * parts, cut between characters. A copy taken for a move is trimmed to its last whole line (CopyStore.path).
 */
function linesFrom(path: string, offset: number, limit: number, size: number): string {
	const descriptor = openSync(path, "r");
	try {
		for (let length = Math.min(limit, size - offset); ; length = Math.min(length * 4, LONGEST, size - offset)) {
			const buffer = Buffer.alloc(length), read = readSync(descriptor, buffer, 0, length, offset);
			const end = buffer.subarray(0, read).lastIndexOf(10);
			if (end >= 0) return buffer.subarray(0, end + 1).toString("utf8");
			if (offset + read >= size) return "";
			if (length >= LONGEST) {
				// The last character's lead byte, and whether all of that character was read.
				let lead = read - 1;
				while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
				const first = buffer[lead]!, width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
				return buffer.subarray(0, lead + width <= read ? read : lead).toString("utf8");
			}
		}
	} finally { closeSync(descriptor); }
}

/** The byte just after a file's last line break (0 when it has none), found from the end. */
export function lastLineEnd(file: string): number {
	const descriptor = openSync(file, "r");
	try {
		const size = statSync(file).size, step = 64 * 1024, buffer = Buffer.alloc(step);
		for (let end = size; end > 0; end -= step) {
			const start = Math.max(0, end - step), read = readSync(descriptor, buffer, 0, end - start, start);
			const at = buffer.subarray(0, read).lastIndexOf(10);
			if (at >= 0) return start + at + 1;
		}
		return 0;
	} finally { closeSync(descriptor); }
}
/** The sending side: what of each conversation the copy holder does not have yet. */
export class CopySender {
	/** What each holder reported it has, by session. */
	private held = new Map<string, Map<string, { size: number; head: string }>>();
	/** A holder's report of what it has from this computer; nothing is sent to a holder before it reports. */
	status(holder: string, copies: unknown): void {
		const known = new Map<string, { size: number; head: string }>();
		if (copies && typeof copies === "object") for (const [session, value] of Object.entries(copies as Record<string, { size?: unknown; head?: unknown }>))
			if (SESSION.test(session) && Number.isSafeInteger(value?.size) && typeof value?.head === "string") known.set(session, { size: Number(value.size), head: value.head });
		this.held.set(holder, known);
	}
	acknowledge(holder: string, session: string, size: number, head: string): void { this.held.get(holder)?.set(session, { size, head }); }
	forget(holder: string): void { this.held.delete(holder); }
	/** The next chunks for a holder, at most ROUND bytes in all; empty when it is up to date or has not reported. */
	next(holder: string, conversations: readonly { session: string; file: string; cwd: string; title?: string }[]): CopyChunk[] {
		const held = this.held.get(holder);
		if (!held) return [];
		const chunks: CopyChunk[] = [];
		let budget = ROUND;
		for (const conversation of conversations) {
			if (budget <= 0) break;
			let stat;
			try { stat = statSync(conversation.file); } catch { continue; }
			if (Date.now() - stat.mtimeMs > KEPT_DAYS * 86_400_000) continue;
			const head = fileHead(conversation.file), known = held.get(conversation.session);
			const offset = known && known.head === head && known.size <= stat.size ? known.size : 0;
			if (offset === stat.size) continue;
			const data = linesFrom(conversation.file, offset, Math.min(CHUNK, budget), stat.size), bytes = Buffer.byteLength(data);
			if (!data) continue;
			// A long line that does not fit this round goes alone in the next: a round stays well under a packet's limit.
			if (chunks.length && bytes > budget) break;
			budget -= bytes;
			chunks.push({ session: conversation.session, cwd: conversation.cwd, ...(conversation.title ? { title: conversation.title } : {}),
				offset, data, total: stat.size, head, updated: Math.floor(stat.mtimeMs) });
		}
		return chunks;
	}
}

/** The holding side: other computers' conversations, as files, with an index of what each one is. */
export class CopyStore {
	private readonly directory: string;
	private index: Record<string, CopyInfo>;
	constructor(directory: string) {
		this.directory = directory;
		try { this.index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")); } catch { this.index = {}; }
		this.prune();
	}
	private key(computer: string, session: string) { return `${computer}/${session}`; }
	private file(computer: string, session: string) { return join(this.directory, computer, `${session}.jsonl`); }
	private save(): void {
		mkdirSync(this.directory, { recursive: true });
		writeFileSync(join(this.directory, "index.json.tmp"), JSON.stringify(this.index)); renameSync(join(this.directory, "index.json.tmp"), join(this.directory, "index.json"));
	}
	/** What this holder has of one computer's conversations, for that computer to continue from. */
	status(computer: string): Record<string, { size: number; head: string }> {
		return Object.fromEntries(Object.values(this.index).filter(copy => copy.computer === computer).map(copy => [copy.session, { size: copy.size, head: copy.head }]));
	}
	/** Appends a chunk if it continues the copy exactly; returns what the copy is now, for the sender. */
	receive(computer: string, chunk: CopyChunk): { size: number; head: string } {
		if (!COMPUTER.test(computer) || !SESSION.test(chunk.session) || !Number.isSafeInteger(chunk.offset) || typeof chunk.data !== "string"
			|| typeof chunk.cwd !== "string" || chunk.cwd.length > 4096 || typeof chunk.head !== "string" || chunk.head.length > 64) throw new Error("Invalid conversation copy.");
		const key = this.key(computer, chunk.session), known = this.index[key], file = this.file(computer, chunk.session);
		const size = known && known.head === chunk.head && existsSync(file) ? statSync(file).size : 0;
		if (chunk.offset !== size) return { size, head: known?.head ?? "" };
		mkdirSync(join(this.directory, computer), { recursive: true });
		if (chunk.offset === 0) writeFileSync(file, chunk.data); else appendFileSync(file, chunk.data);
		const now = statSync(file).size;
		this.index[key] = { session: chunk.session, computer, cwd: chunk.cwd, ...(chunk.title ? { title: chunk.title.slice(0, 300) } : {}),
			size: now, head: chunk.head, updated: chunk.updated, ...(known?.moved ? { moved: known.moved } : {}) };
		this.save();
		return { size: now, head: chunk.head };
	}
	/** Every copy, newest first. */
	list(): CopyInfo[] { return Object.values(this.index).sort((a, b) => b.updated - a.updated); }
	get(computer: string, session: string): CopyInfo | undefined { return this.index[this.key(computer, session)]; }
	/**
	 * The copy's file and where its last whole line ends: a computer that went off mid-line leaves the rest unfinished.
	 * Read in parts, never as one string (a conversation can be larger than the longest string Node can hold).
	 */
	whole(computer: string, session: string): { file: string; end: number } | undefined {
		const file = this.file(computer, session);
		if (!this.index[this.key(computer, session)] || !existsSync(file)) return;
		const end = lastLineEnd(file);
		return end > 0 ? { file, end } : undefined;
	}
	/** A conversation moved to another computer: its copy stays until it expires, marked as moved. */
	moved(session: string, to: string, at: number): void {
		let changed = false;
		for (const copy of Object.values(this.index)) if (copy.session === session && copy.computer !== to && (!copy.moved || copy.moved.at < at)) { copy.moved = { to, at }; changed = true; }
		if (changed) this.save();
	}
	private prune(): void {
		let changed = false;
		for (const [key, copy] of Object.entries(this.index)) {
			if (Date.now() - copy.updated <= KEPT_DAYS * 86_400_000) continue;
			rmSync(this.file(copy.computer, copy.session), { force: true }); delete this.index[key]; changed = true;
		}
		// Files no index entry knows (a write interrupted before its index was saved).
		try {
			for (const computer of readdirSync(this.directory)) {
				if (!COMPUTER.test(computer)) continue;
				for (const name of readdirSync(join(this.directory, computer)))
					if (!this.index[this.key(computer, name.replace(/\.jsonl$/, ""))]) rmSync(join(this.directory, computer, name), { force: true });
			}
		} catch { /* Nothing kept yet. */ }
		if (changed) this.save();
	}
}

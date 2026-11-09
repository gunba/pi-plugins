import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HistoryPage } from "../shared/protocol.ts";
import type { HistoryPosition } from "../shared/history.ts";
import { Transcript } from "./transcript.ts";

const CHUNK = 1 << 20;
/** Most entry lines start with their type, ID and parent, and a message's role soon after. */
const HEAD = /^\{"type":"([a-z_]+)","id":"([^"]+)","parentId":(?:null|"([^"]+)")/;
const ROLE = /"message":\{"role":"([A-Za-z]+)"/;
/** Closed conversations whose files stay indexed, most recently read last. */
const KEPT = 4;

interface Line { offset: number; length: number }
interface Indexed { size: number; mtime: number; transcript: Transcript; branch: SessionEntry[]; lines: Map<string, Line>; leaf?: string }

/**
 * The saved history of conversations that are not running, read from their session files so they can be read without
 * starting Pi. Each file is indexed once, in chunks that leave the host free between them, keeping only each entry's
 * position and what decides whether it is shown; a page reads its few dozen lines. Read-only: assets of the messages
 * read can be opened; files, artifacts and every control still need the conversation running.
 */
export class ClosedHistory {
	private readonly files = new Map<string, Indexed>();
	private readonly pending = new Map<string, Promise<Indexed>>();

	async history(file: string, leaf: string | undefined, cwd: string, position: HistoryPosition): Promise<HistoryPage> {
		const indexed = await this.indexed(file, leaf);
		const full = (entry: SessionEntry) => this.read(file, indexed, entry);
		const page = indexed.transcript.history(indexed.branch, position, undefined, undefined, cwd, full);
		return { ...page, generation: "" };
	}

	asset(file: string, id: string): { mimeType: string; base64: string } {
		const indexed = this.files.get(file);
		if (!indexed) throw new Error("Open this conversation's messages again to load the image.");
		return indexed.transcript.getAsset(id);
	}

	/** Forgets a file once its conversation runs again: the running conversation serves its own history. */
	forget(file: string): void { this.files.delete(file); }

	private async indexed(file: string, leaf: string | undefined): Promise<Indexed> {
		let stat;
		try { stat = statSync(file); }
		catch { this.files.delete(file); throw new Error("This conversation's saved history is no longer on this computer."); }
		const known = this.files.get(file);
		if (known && known.size === stat.size && known.mtime === stat.mtimeMs && known.leaf === leaf) {
			this.files.delete(file); this.files.set(file, known);
			return known;
		}
		const key = file + "\0" + stat.size + "\0" + stat.mtimeMs + "\0" + (leaf ?? "");
		let pending = this.pending.get(key);
		if (!pending) {
			pending = this.index(file, leaf, stat.size, stat.mtimeMs).finally(() => this.pending.delete(key));
			this.pending.set(key, pending);
		}
		const indexed = await pending;
		this.files.delete(file); this.files.set(file, indexed);
		while (this.files.size > KEPT) this.files.delete(this.files.keys().next().value!);
		return indexed;
	}

	private async index(file: string, leaf: string | undefined, size: number, mtime: number): Promise<Indexed> {
		const entries = new Map<string, SessionEntry>(), lines = new Map<string, Line>();
		let last: string | undefined;
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.alloc(CHUNK);
			let start = 0, carry = Buffer.alloc(0);
			while (start + carry.length < size) {
				const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - start - carry.length), start + carry.length);
				if (!bytesRead) break;
				const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
				let from = 0;
				for (let end = data.indexOf(10); end >= 0; from = end + 1, end = data.indexOf(10, from)) {
					const entry = light(data.subarray(from, end));
					if (!entry) continue;
					entries.set(entry.id, entry); lines.set(entry.id, { offset: start + from, length: end - from }); last = entry.id;
				}
				start += from;
				carry = Buffer.from(data.subarray(from));
			}
			// The last line may lack its newline.
			if (carry.length) {
				const entry = light(carry);
				if (entry) { entries.set(entry.id, entry); lines.set(entry.id, { offset: start, length: carry.length }); last = entry.id; }
			}
		} finally { await handle.close(); }
		const branch: SessionEntry[] = [];
		for (let at = leaf && entries.has(leaf) ? leaf : last; at;) {
			const entry = entries.get(at);
			if (!entry) break;
			branch.push(entry); at = entry.parentId ?? undefined;
		}
		return { size, mtime, transcript: new Transcript(), branch: branch.reverse(), lines, leaf };
	}

	private read(file: string, indexed: Indexed, entry: SessionEntry): SessionEntry {
		const line = indexed.lines.get(entry.id);
		if (!line) return entry;
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(line.length);
			readSync(fd, buffer, 0, line.length, line.offset);
			const saved = JSON.parse(buffer.toString("utf8")) as SessionEntry;
			return saved.id === entry.id ? saved : entry;
		} catch { return entry; }
		finally { closeSync(fd); }
	}
}

/**
 * An entry with only what places it on the branch and decides whether it is shown. A message line is read from its
 * start; other entries are small and parsed whole.
 */
function light(line: Buffer): SessionEntry | undefined {
	const head = HEAD.exec(line.subarray(0, 300).toString("utf8"));
	if (head && head[1] === "message") {
		const role = ROLE.exec(line.subarray(0, 600).toString("utf8"))?.[1];
		if (role && role !== "custom") return { type: "message", id: head[2]!, parentId: head[3] ?? null, message: { role, content: [] } } as unknown as SessionEntry;
	}
	if (head && !["message", "custom", "custom_message"].includes(head[1]!)) return { type: head[1], id: head[2]!, parentId: head[3] ?? null } as unknown as SessionEntry;
	try {
		const entry = JSON.parse(line.toString("utf8")) as SessionEntry & { message?: { role?: string; display?: boolean } };
		if (typeof entry.id !== "string") return;
		if (entry.type === "message") return { type: "message", id: entry.id, parentId: entry.parentId ?? null,
			message: { role: entry.message?.role, display: entry.message?.display, content: [] } } as unknown as SessionEntry;
		if (entry.type === "custom_message") return { type: "custom_message", id: entry.id, parentId: entry.parentId ?? null, display: entry.display } as unknown as SessionEntry;
		if (entry.type === "custom") return { type: "custom", id: entry.id, parentId: entry.parentId ?? null, customType: entry.customType } as unknown as SessionEntry;
		return { type: entry.type, id: entry.id, parentId: entry.parentId ?? null } as unknown as SessionEntry;
	} catch { return; }
}

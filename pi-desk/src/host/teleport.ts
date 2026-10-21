import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CopySender, CopyStore, lastLineEnd, type CopyChunk, type CopyInfo } from "./copies.ts";

/**
 * Moving a conversation to another computer ("teleport"), including from a computer that is off.
 *
 * - Every computer sends copies of its conversations to the computers that keep copies (the workspace server), as
 *   they are written (copies.ts). A computer can stop sending in Settings.
 * - A move opens the conversation on the chosen computer from the freshest copy there is: its own computer's file when
 *   that computer is on (which then stops the conversation), otherwise a kept copy.
 * - A move is recorded and shared with every computer, so the original never runs again: its computer stops it when
 *   it hears of the move, even if it was off at the time.
 */
export const COPIES = "copies";
export const HOLD = "copies-hold";
/** A move between computers. `file` is kept only by the computer the conversation moved to: where it was placed. */
export type Move = { from: string; to: string; at: number; file?: string };
export type Conversation = { session: string; file: string; cwd: string; title?: string };
export type TeleportPacket =
	| { type: "copies-status"; copies: Record<string, { size: number; head: string }> }
	| { type: "copies"; chunks: CopyChunk[] }
	| { type: "copies-ack"; acks: { session: string; size: number; head: string }[] }
	| { type: "moves"; moves: Record<string, Move> }
	| { type: "copy-fetch"; id: string; computer: string; session: string; release: boolean }
	| { type: "copy-data"; id: string; part: number; last: boolean; data?: string; cwd?: string; title?: string; error?: string };
export const TELEPORT_PACKETS = new Set(["copies-status", "copies", "copies-ack", "moves", "copy-fetch", "copy-data"]);
export type Settings = { hold: boolean; send: boolean };
type Send = (packet: TeleportPacket) => Promise<void>;
type Fetch = { file: string; output: ReturnType<typeof createWriteStream>; next: number; cwd?: string; title?: string; done: (error?: Error) => void; timer?: ReturnType<typeof setTimeout> };

const PART = 8 * 1024 * 1024, QUIET_MS = 120_000;
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/, COMPUTER = /^[a-f0-9-]{36}$/;

export class Teleport {
	settings: Settings;
	store?: CopyStore;
	private readonly sender = new CopySender();
	private readonly directory: string;
	private moves: Record<string, Move>;
	private readonly hooks: {
		self(): string;
		/** This computer's conversations that may be copied. */
		conversations(): Conversation[];
		/** Another computer took this conversation over: stop it here. */
		movedAway(session: string, move: Move): void;
		/** Stop this conversation here and give its file, for a move that takes it elsewhere. */
		release(session: string): Promise<{ file: string; cwd: string; title?: string }>;
	};
	private sentMoves = new Map<string, string>();
	private sentStatus = new Set<string>();
	private fetches = new Map<string, Fetch>();
	constructor(directory: string, hooks: Teleport["hooks"]) {
		this.directory = directory; this.hooks = hooks;
		try { this.settings = { hold: false, send: true, ...JSON.parse(readFileSync(join(directory, "copies.json"), "utf8")) }; } catch { this.settings = { hold: false, send: true }; }
		try { this.moves = JSON.parse(readFileSync(join(directory, "moves.json"), "utf8")); } catch { this.moves = {}; }
		if (this.settings.hold) this.store = new CopyStore(join(directory, "copies"));
	}
	/** What this computer announces: it understands copies and moves, and whether it keeps copies. */
	operations(): string[] { return [COPIES, ...(this.store ? [HOLD] : [])]; }
	configure(settings: Partial<Settings>): void {
		this.settings = { ...this.settings, ...settings };
		mkdirSync(this.directory, { recursive: true }); writeFileSync(join(this.directory, "copies.json"), JSON.stringify(this.settings));
		// Kept copies stay on disk when holding stops; they are no longer received or offered.
		this.store = this.settings.hold ? this.store ?? new CopyStore(join(this.directory, "copies")) : undefined;
	}
	/** A copy this computer keeps, as a file of its own for a move here. */
	copyLocal(computer: string, session: string): { file: string; cwd?: string; title?: string } | undefined {
		const copy = this.store?.get(computer, session), whole = copy && this.store!.whole(computer, session);
		if (!copy || !whole) return;
		mkdirSync(join(this.directory, "incoming"), { recursive: true });
		const file = join(this.directory, "incoming", `${randomUUID()}.jsonl`), source = openSync(whole.file, "r"), output = openSync(file, "w");
		try {
			const buffer = Buffer.alloc(8 * 1024 * 1024);
			for (let offset = 0; offset < whole.end;) {
				const count = readSync(source, buffer, 0, Math.min(buffer.length, whole.end - offset), offset);
				if (!count) break;
				writeSync(output, buffer, 0, count); offset += count;
			}
		} finally { closeSync(source); closeSync(output); }
		return { file, cwd: copy.cwd, ...(copy.title ? { title: copy.title } : {}) };
	}
	/** Where a conversation went, if it moved off this computer. */
	movedAway(session: string): Move | undefined { const move = this.moves[session]; return move && move.to !== this.hooks.self() ? move : undefined; }
	/** Whether a file of a conversation that moved here is an older one than where it was placed: one that went away and came back. */
	superseded(session: string, file: string): boolean { const move = this.moves[session]; return !!move?.file && move.to === this.hooks.self() && move.file !== file; }
	copies(): CopyInfo[] { return this.store?.list() ?? []; }
	record(session: string, move: Move): void {
		this.moves[session] = move;
		mkdirSync(this.directory, { recursive: true }); writeFileSync(join(this.directory, "moves.json"), JSON.stringify(this.moves));
		this.store?.moved(session, move.to, move.at);
	}
	disconnected(peer: string): void { this.sender.forget(peer); this.sentStatus.delete(peer); this.sentMoves.delete(peer); }

	/** What to send a peer on this round: moves it has not had, what this holder has of it, and new conversation lines. */
	outgoing(peer: string, operations: readonly string[]): TeleportPacket[] {
		if (!operations.includes(COPIES)) return [];
		const shared = Object.fromEntries(Object.entries(this.moves).map(([session, { from, to, at }]) => [session, { from, to, at }]));
		const packets: TeleportPacket[] = [], moves = JSON.stringify(shared);
		if (this.sentMoves.get(peer) !== moves) { packets.push({ type: "moves", moves: shared }); this.sentMoves.set(peer, moves); }
		if (this.store && !this.sentStatus.has(peer)) { packets.push({ type: "copies-status", copies: this.store.status(peer) }); this.sentStatus.add(peer); }
		if (this.settings.send && operations.includes(HOLD)) {
			const chunks = this.sender.next(peer, this.hooks.conversations().filter(conversation => !this.movedAway(conversation.session)));
			if (chunks.length) packets.push({ type: "copies", chunks });
		}
		return packets;
	}

	async receive(peer: string, packet: TeleportPacket, send: Send): Promise<void> {
		if (packet.type === "copies-status") { this.sender.status(peer, packet.copies); return; }
		if (packet.type === "copies-ack") {
			for (const ack of Array.isArray(packet.acks) ? packet.acks : []) if (SESSION.test(ack?.session)) this.sender.acknowledge(peer, ack.session, Number(ack.size), String(ack.head));
			return;
		}
		if (packet.type === "copies") {
			if (!this.store || !Array.isArray(packet.chunks)) throw Error("This computer does not keep conversation copies.");
			await send({ type: "copies-ack", acks: packet.chunks.slice(0, 64).map(chunk => ({ session: chunk.session, ...this.store!.receive(peer, chunk) })) });
			return;
		}
		if (packet.type === "moves") {
			for (const [session, move] of Object.entries(packet.moves && typeof packet.moves === "object" ? packet.moves : {})) {
				if (!SESSION.test(session) || !COMPUTER.test(move?.to) || !COMPUTER.test(move?.from) || !Number.isFinite(move?.at)) continue;
				if (this.moves[session] && this.moves[session]!.at >= move.at) continue;
				this.record(session, { from: move.from, to: move.to, at: move.at });
				if (move.to !== this.hooks.self()) this.hooks.movedAway(session, move);
			}
			return;
		}
		if (packet.type === "copy-fetch") {
			const answer = async (part: Omit<Extract<TeleportPacket, { type: "copy-data" }>, "type" | "id">) => send({ type: "copy-data", id: packet.id, ...part });
			try {
				if (!SESSION.test(packet.session) || !COMPUTER.test(packet.computer)) throw Error("Invalid conversation.");
				let file: string, end: number, cwd: string, title: string | undefined;
				if (packet.computer === this.hooks.self()) {
					if (!packet.release) throw Error("A conversation is given up only for a move.");
					({ file, cwd, title } = await this.hooks.release(packet.session)); end = statSync(file).size;
				} else {
					const copy = this.store?.get(packet.computer, packet.session), whole = copy && this.store!.whole(packet.computer, packet.session);
					if (!copy || !whole) throw Error("This computer has no copy of that conversation.");
					({ file, end } = whole); cwd = copy.cwd; title = copy.title;
				}
				const descriptor = openSync(file, "r");
				try {
					for (let offset = 0, part = 0; offset < end || part === 0; part++) {
						const buffer = Buffer.alloc(Math.min(PART, end - offset)), read = readSync(descriptor, buffer, 0, buffer.length, offset);
						// Cut between characters, so each part is text on its own.
						let cut = read;
						if (offset + read < end) { let lead = read - 1; while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--; const first = buffer[lead]!; if (lead + (first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1) > read) cut = lead; }
						offset += cut;
						await answer({ part, last: offset >= end, data: buffer.subarray(0, cut).toString("utf8"), ...(part === 0 ? { cwd, ...(title ? { title } : {}) } : {}) });
					}
				} finally { closeSync(descriptor); }
			} catch (error) { await answer({ part: 0, last: true, error: error instanceof Error ? error.message : String(error) }); }
			return;
		}
		if (packet.type === "copy-data") {
			const fetch = this.fetches.get(packet.id);
			if (!fetch) return;
			if (packet.error) { fetch.done(new Error(packet.error)); return; }
			if (packet.part !== fetch.next++ || typeof packet.data !== "string") { fetch.done(new Error("A conversation copy arrived out of order.")); return; }
			if (packet.part === 0) { fetch.cwd = packet.cwd; fetch.title = packet.title; }
			fetch.output.write(packet.data);
			this.quiet(packet.id);
			if (packet.last) fetch.done();
			return;
		}
	}
	private quiet(id: string): void {
		const fetch = this.fetches.get(id);
		if (!fetch) return;
		clearTimeout(fetch.timer);
		fetch.timer = setTimeout(() => fetch.done(new Error("The conversation stopped arriving.")), QUIET_MS);
	}
	/** A conversation's file from a computer that has it, into a temporary file here. */
	fetch(send: Send, computer: string, session: string, release: boolean): Promise<{ file: string; cwd?: string; title?: string }> {
		const id = randomUUID(), file = join(this.directory, "incoming", `${id}.jsonl`);
		mkdirSync(join(this.directory, "incoming"), { recursive: true });
		return new Promise((resolve, reject) => {
			const output = createWriteStream(file);
			const entry: Fetch = { file, output, next: 0, done: error => {
				clearTimeout(entry.timer); this.fetches.delete(id);
				output.end(() => { if (error) { rmSync(file, { force: true }); reject(error); } else resolve({ file, cwd: entry.cwd, title: entry.title }); });
			} };
			this.fetches.set(id, entry); this.quiet(id);
			send({ type: "copy-fetch", id, computer, session, release }).catch(error => entry.done(error instanceof Error ? error : new Error(String(error))));
		});
	}
}

/** Pi's session folder for a working folder (its default, unless sessionDir is configured). */
export function sessionFolder(agentDir: string, cwd: string, configured?: string): string {
	return configured ?? join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/**
 * Places a moved conversation's file where Pi keeps this folder's conversations: its header names the new folder, and a
 * note tells the model where it now is (paths and tools from earlier may differ). Returns the file's path.
 */
/** Places a moved conversation in `folder`, its header pointing at `cwd`, with `note` appended when given. */
export function placeMoved(incoming: string, folder: string, cwd: string, note?: string): string {
	// Read and written in parts: a conversation can be larger than the longest string Node can hold.
	const source = openSync(incoming, "r"), size = statSync(incoming).size;
	let end = lastLineEnd(incoming);
	try {
		const first = Buffer.alloc(Math.min(size, 1024 * 1024)), read = readSync(source, first, 0, first.length, 0), headerEnd = first.subarray(0, read).indexOf(10);
		if (headerEnd < 0) throw Error("The copy is not a Pi conversation.");
		const header = JSON.parse(first.subarray(0, headerEnd).toString("utf8"));
		if (header?.type !== "session" || typeof header.id !== "string") throw Error("The copy is not a Pi conversation.");
		// The note continues from the conversation's last entry: its last line, parsed whole (an entry's own id can come
		// after fields holding other ids). A line is at most tens of megabytes; a damaged one gives way to the line before.
		const lineStart = (to: number) => {
			const step = Buffer.alloc(64 * 1024);
			for (let at = to - 1; at > 0;) {
				const from = Math.max(0, at - step.length), read = readSync(source, step, 0, at - from, from), found = step.subarray(0, read).lastIndexOf(10);
				if (found >= 0) return from + found + 1;
				at = from;
			}
			return 0;
		};
		let leaf: string | null = null;
		for (let to = end, tries = 0; to > headerEnd + 1 && leaf === null && tries < 8; tries++) {
			const from = lineStart(to), line = Buffer.alloc(to - from);
			readSync(source, line, 0, line.length, from);
			try { const entry = JSON.parse(line.toString("utf8")); if (typeof entry?.id === "string") leaf = entry.id; }
			catch { end = from; /* Damaged: left out, and the line before is the last. */ }
			to = from;
		}
		const notice = { type: "custom_message", id: randomUUID().slice(0, 8), parentId: leaf, timestamp: new Date().toISOString(),
			customType: "pi-desk/moved", content: note, display: true };
		mkdirSync(folder, { recursive: true });
		const target = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}_${header.id}.jsonl`);
		const output = openSync(`${target}.tmp`, "w");
		try {
			writeSync(output, `${JSON.stringify({ ...header, cwd })}\n`);
			const buffer = Buffer.alloc(8 * 1024 * 1024);
			for (let offset = headerEnd + 1; offset < end;) {
				const count = readSync(source, buffer, 0, Math.min(buffer.length, end - offset), offset);
				if (!count) break;
				writeSync(output, buffer, 0, count); offset += count;
			}
			if (note !== undefined) writeSync(output, `${JSON.stringify(notice)}\n`);
		} finally { closeSync(output); }
		renameSync(`${target}.tmp`, target);
		return target;
	} finally { closeSync(source); rmSync(incoming, { force: true }); }
}

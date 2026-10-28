import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { agentId, nativeId, networkMembers, remoteMember, remoteMessage, NETWORK_LIMIT, MAX_NETWORK_PACKET, uuid,
	type DeliveryReceipt, type NetworkMember } from "./network.ts";

export const LEASE_MS = 45_000;
/** Messages are direct; an epoch change (new registration) withdraws undelivered ones. */
export const CURRENT_MESSAGE_SQL = `m.room='' AND sender.agent_epoch=m.sender_epoch AND recipient.agent_epoch=m.recipient_epoch`;
export interface Member {
	session: string; room: string; epoch: string; label: string; owner: string;
	heartbeat: number; state: string; wakes: number;
	agent_epoch: string; cwd: string; description: string; kind: string; delivery: number; muted: number;
	computer?: string;
}
export interface PartyMessage {
	id: string; room: string; sender: string; sender_epoch: string; sender_label: string;
	recipient: string; recipient_epoch: string; text: string; created: number; wake: number;
	kind: string; invite_room: string;
}
/** A file sent with a message, stored until the recipient's process saves it to disk. data is base64. */
export interface MessageFile { name: string; size: number; sha256: string; data: string }
/**
 * Files per message. Between computers they travel in parts the recipient asks for, one at a time ("message-parts"),
 * so a large set is never one packet; a computer whose Desk predates that takes them inside the message, up to 8 MB.
 */
export const MAX_MESSAGE_FILES = 50, MAX_MESSAGE_FILE_BYTES = 200 * 1024 * 1024, INLINE_FILE_BYTES = 8 * 1024 * 1024;
export const FILE_PART_BYTES = 4 * 1024 * 1024, MESSAGE_PARTS = "message-parts";
/**
 * Names for files sent together: their own, or, where two share one (in any case: Windows would merge them), with as
 * many parent folders as tell them apart, joined by "-": projectplan/offices/sydney.md becomes projectplan-offices-sydney.md.
 * Sending them failed outright before.
 */
export function sendNames(paths: readonly string[]): string[] {
	const parts = paths.map(path => path.split(/[\\/]+/).filter(Boolean)), depth = paths.map(() => 1);
	const name = (index: number) => parts[index]!.slice(-depth[index]!).join("-");
	for (let round = 0; round < 64; round++) {
		const groups = new Map<string, number[]>();
		paths.forEach((_path, index) => { const key = name(index).toLowerCase(); groups.set(key, [...groups.get(key) ?? [], index]); });
		let grew = false;
		for (const group of groups.values()) if (group.length > 1) for (const index of group) if (depth[index]! < parts[index]!.length) { depth[index]!++; grew = true; }
		if (!grew) break;
	}
	// Still the same (a folder named like another's file): numbered.
	const seen = new Map<string, number>();
	return paths.map((_path, index) => {
		const base = name(index), count = (seen.get(base.toLowerCase()) ?? 0) + 1;
		seen.set(base.toLowerCase(), count);
		const dot = base.lastIndexOf(".");
		return count === 1 ? base : dot > 0 ? `${base.slice(0, dot)} (${count})${base.slice(dot)}` : `${base} (${count})`;
	});
}
/** What a message with files in parts says of each: the data follows on request. */
export interface FileHeader { name: string; size: number; sha256: string }

/**
 * Check files before they are stored: count, total size, plain file names, and that each matches its hash. With
 * `headers`, only what a message with files in parts says of them: the data is checked as it arrives.
 */
export function checkFiles(files: MessageFile[], headers = false): void {
	if (files.length > MAX_MESSAGE_FILES) throw Error(`Send at most ${MAX_MESSAGE_FILES} files with one message.`);
	let total = 0;
	const names = new Set<string>();
	for (const file of files) {
		if (typeof file.name !== "string" || !file.name || file.name.length > 255 || /[\\/\x00-\x1f]|^\.\.?$/.test(file.name)) throw Error("Invalid file name.");
		if (names.has(file.name)) throw Error(`Two files are called ${file.name}.`);
		names.add(file.name);
		if (headers) {
			if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw Error(`${file.name} is described wrongly.`);
			total += file.size;
			continue;
		}
		const bytes = Buffer.from(typeof file.data === "string" ? file.data : "", "base64");
		if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Error(`${file.name} arrived incomplete.`);
		total += bytes.length;
	}
	if (total > MAX_MESSAGE_FILE_BYTES) throw Error(`Files are limited to ${MAX_MESSAGE_FILE_BYTES / 1024 / 1024} MB per message.`);
}
export interface HistoryCursor { created: number; id: string }
export type HistoryQuery = { before: HistoryCursor } | { after: HistoryCursor } | { oldest: true } | undefined;
export interface HistoryMessage extends PartyMessage { admitted: number; recipient_label: string }
export interface HistoryPage { messages: HistoryMessage[]; hasOlder: boolean; hasNewer: boolean }

/** One local-user database, independent of scheduler and session JSONL storage. */
export class PartyStore {
	private db: DatabaseSync;
	private now: () => number;
	constructor(directory: string, now = Date.now) {
		this.now = now;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		try { writeFileSync(join(directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		this.db = new DatabaseSync(join(directory, "party.sqlite"));
		this.db.exec(`
			PRAGMA busy_timeout=5000;
			PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS members (
				session TEXT PRIMARY KEY, room TEXT NOT NULL, epoch TEXT NOT NULL,
				label TEXT NOT NULL, owner TEXT NOT NULL, heartbeat INTEGER NOT NULL,
				state TEXT NOT NULL, wakes INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS members_room ON members(room);
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY, room TEXT NOT NULL, sender TEXT NOT NULL, sender_epoch TEXT NOT NULL,
				sender_label TEXT NOT NULL, recipient TEXT NOT NULL, recipient_epoch TEXT NOT NULL,
				text TEXT NOT NULL, created INTEGER NOT NULL, wake INTEGER NOT NULL, admitted INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, recipient_epoch, admitted);
			CREATE INDEX IF NOT EXISTS messages_history ON messages(room, created, id);
		`);
		// Upgrade durable party data in place; membership epochs and receipts survive.
		this.tx(() => {
			const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
			const members = columns("members"), messages = columns("messages");
			for (const [name, definition] of Object.entries({
				agent_epoch: "TEXT NOT NULL DEFAULT ''", cwd: "TEXT NOT NULL DEFAULT ''",
				description: "TEXT NOT NULL DEFAULT ''", kind: "TEXT NOT NULL DEFAULT 'session'",
				delivery: "INTEGER NOT NULL DEFAULT 0", muted: "INTEGER NOT NULL DEFAULT 0",
			})) if (!members.has(name)) this.db.exec(`ALTER TABLE members ADD COLUMN ${name} ${definition}`);
			for (const [name, definition] of Object.entries({
				kind: "TEXT NOT NULL DEFAULT 'message'", invite_room: "TEXT NOT NULL DEFAULT ''",
			})) if (!messages.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
			this.db.exec("UPDATE members SET agent_epoch=epoch WHERE agent_epoch=''");
			// Parties were removed; keep the columns for older peers but drop group state and broadcasts.
			this.db.exec("UPDATE members SET room='' WHERE room<>''; DELETE FROM messages WHERE room<>'' OR kind<>'message';");
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS network_members (session TEXT PRIMARY KEY, computer TEXT NOT NULL,
					profile TEXT NOT NULL, heartbeat INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS network_computers (computer TEXT PRIMARY KEY, connected INTEGER NOT NULL, seen INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS network_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS session_files (session TEXT PRIMARY KEY, file TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS network_messages (message TEXT PRIMARY KEY, computer TEXT NOT NULL,
					status TEXT NOT NULL, error TEXT);
				CREATE TABLE IF NOT EXISTS message_files (message TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
					sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(message, name));
				-- A message from another computer whose files are still arriving: kept apart until they all have,
				-- so no version of an agent sees it half received.
				CREATE TABLE IF NOT EXISTS incoming_messages (message TEXT PRIMARY KEY, computer TEXT NOT NULL, wire TEXT NOT NULL, created INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS incoming_files (message TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
					sha256 TEXT NOT NULL, PRIMARY KEY(message, name));
				CREATE TABLE IF NOT EXISTS incoming_parts (message TEXT NOT NULL, name TEXT NOT NULL, offset INTEGER NOT NULL,
					data BLOB NOT NULL, PRIMARY KEY(message, name, offset));
			`);
			// What each other computer's Desk said it supports, such as receiving files.
			if (!columns("network_computers").has("operations")) this.db.exec("ALTER TABLE network_computers ADD COLUMN operations TEXT");
			// Its name (host name) and platform, so agents can name a computer rather than guess its ID.
			if (!columns("network_computers").has("name")) this.db.exec("ALTER TABLE network_computers ADD COLUMN name TEXT; ALTER TABLE network_computers ADD COLUMN platform TEXT");
			const policy = this.db.prepare("SELECT value FROM network_meta WHERE key=\'wake-policy\'").get() as { value: string } | undefined;
			if (policy?.value !== "idle-starts") {
				// Old delivery-batch counts cannot represent actual autonomous starts.
				this.db.exec("UPDATE members SET wakes=0");
				this.db.prepare("INSERT INTO network_meta VALUES (\'wake-policy\',\'idle-starts\') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
			}
			const fields = ["session", "room", "epoch", "label", "owner", "heartbeat", "state", "wakes",
				"agent_epoch", "cwd", "description", "kind", "delivery", "muted"];
			this.db.exec(`CREATE VIEW IF NOT EXISTS party_agents AS SELECT ${fields.join(",")}, NULL AS computer FROM members
				UNION ALL SELECT ${fields.map(field => ["session", "heartbeat"].includes(field) ? field : `json_extract(profile,'$.${field}')`).join(",")}, computer FROM network_members`);
		});
	}
	close(): void { this.db.close(); }
	localMembers(): Member[] {
		return this.db.prepare("SELECT * FROM members WHERE heartbeat>? ORDER BY heartbeat DESC,session LIMIT ?")
			.all(this.now() - LEASE_MS, NETWORK_LIMIT) as unknown as Member[];
	}
	networkDirectory(): NetworkMember[] { return networkMembers(this.localMembers(), this.now(), LEASE_MS); }
	setNetworkScope(scope: string): void {
		this.tx(() => {
			const old = this.db.prepare("SELECT value FROM network_meta WHERE key='scope'").get() as { value: string } | undefined;
			if (old && old.value !== scope) {
				this.db.exec("DELETE FROM network_members; DELETE FROM network_computers; DELETE FROM messages WHERE admitted=0 AND instr(sender,'@')>0;");
				this.db.prepare("UPDATE network_messages SET status='failed',error=? WHERE status='queued'").run("Desk account changed before delivery.");
			}
			this.db.prepare("INSERT INTO network_meta (key,value) VALUES ('scope',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(scope);
			this.db.exec("UPDATE network_computers SET connected=0; UPDATE network_members SET heartbeat=0;");
		});
	}
	setComputerConnected(computer: string, connected: boolean): void {
		if (!uuid(computer)) throw Error("Invalid party computer.");
		this.tx(() => {
			this.db.prepare("INSERT INTO network_computers (computer,connected,seen) VALUES (?,?,?) ON CONFLICT(computer) DO UPDATE SET connected=excluded.connected,seen=excluded.seen")
				.run(computer, connected ? 1 : 0, this.now());
			if (!connected) this.db.prepare("UPDATE network_members SET heartbeat=0 WHERE computer=?").run(computer);
		});
	}
	touchComputer(computer: string): void {
		this.tx(() => {
			this.db.prepare("UPDATE network_computers SET seen=? WHERE computer=? AND connected=1").run(this.now(), computer);
			this.db.prepare("UPDATE network_members SET heartbeat=? WHERE computer=? AND json_extract(profile,'$.state')<>'offline'").run(this.now(), computer);
		});
	}
	/** Record what a computer's Desk announced it supports; older ones announce nothing. */
	setComputerOperations(computer: string, operations: string[], name?: string, platform?: string): void {
		this.db.prepare("UPDATE network_computers SET operations=?, name=coalesce(?, name), platform=coalesce(?, platform) WHERE computer=?")
			.run(JSON.stringify(operations), name ?? null, platform ?? null, computer);
	}
	/**
	 * A computer as an agent names it: its ID, the start of its ID, or its name, in any case; "local" or "this" for
	 * this one. An unknown one is an error that lists the computers there are, so a wrong name is not taken for an outage.
	 */
	resolveComputer(input: string, self?: string): string {
		const value = input.trim(), lower = value.toLowerCase(), known = this.computers();
		if (["", "local", "this", "here"].includes(lower) || self && lower === self.toLowerCase()) return "local";
		const matches = known.filter(computer => computer.id === value || computer.name?.toLowerCase() === lower)
			.concat(lower.length >= 8 ? known.filter(computer => computer.id.startsWith(lower)) : []);
		const ids = [...new Set(matches.map(computer => computer.id))];
		if (ids.length === 1) return ids[0]!;
		const list = known.map(computer => `${computer.name ?? "unnamed"} (${computer.platform ?? "?"}, ${computer.state}): ${computer.id}`).join("; ");
		throw Error(`${ids.length ? "More than one" : "No"} computer matches "${input}". ${list ? `Computers: ${list}; or "local" for this one.` : "No other computers are known; \"local\" is this one."}`);
	}
	/** The conversations a computer last listed as open (native ids); kept while it is disconnected. */
	openSessions(computer: string): string[] {
		return (this.db.prepare("SELECT session FROM network_members WHERE computer=?").all(computer) as { session: string }[]).map(row => row.session.split("@")[0]!);
	}
	computerSupports(computer: string, operation: string): boolean {
		const row = this.db.prepare("SELECT operations FROM network_computers WHERE computer=?").get(computer) as { operations: string | null } | undefined;
		try { return !!row?.operations && (JSON.parse(row.operations) as string[]).includes(operation); } catch { return false; }
	}
	/** The files sent with a message, while they await delivery. */
	messageFiles(message: string): MessageFile[] {
		return (this.db.prepare("SELECT name,size,sha256,data FROM message_files WHERE message=? ORDER BY name").all(message) as { name: string; size: number; sha256: string; data: Uint8Array }[])
			.map(row => ({ name: row.name, size: row.size, sha256: row.sha256, data: Buffer.from(row.data).toString("base64") }));
	}
	private insertFiles(message: string, files: MessageFile[]): void {
		const insert = this.db.prepare("INSERT INTO message_files (message,name,size,sha256,data) VALUES (?,?,?,?,?)");
		for (const file of files) insert.run(message, file.name, file.size, file.sha256, Buffer.from(file.data, "base64"));
	}
	computers(): { id: string; state: string; name?: string; platform?: string }[] {
		return (this.db.prepare("SELECT computer, name, platform FROM network_computers ORDER BY computer").all() as { computer: string; name: string | null; platform: string | null }[])
			.map(row => ({ id: row.computer, state: this.computerOnline(row.computer) ? "connected" : "offline",
				...(row.name ? { name: row.name } : {}), ...(row.platform ? { platform: row.platform } : {}) }));
	}
	computerOnline(computer: string): boolean {
		return !!this.db.prepare("SELECT 1 FROM network_computers WHERE computer=? AND connected=1 AND seen>?").get(computer, this.now() - LEASE_MS);
	}
	cacheDirectory(computer: string, input: unknown): void {
		if (!Array.isArray(input) || input.length > NETWORK_LIMIT) throw Error("Invalid party directory.");
		const peers = input.map(value => remoteMember(computer, value, this.now()));
		if (new Set(peers.map(peer => peer.session)).size !== peers.length) throw Error("Duplicate party agent.");
		this.tx(() => {
			this.db.prepare("DELETE FROM network_members WHERE computer=?").run(computer);
			const insert = this.db.prepare("INSERT INTO network_members (session,computer,profile,heartbeat) VALUES (?,?,?,?)");
			for (const peer of peers) insert.run(peer.session, computer, JSON.stringify(peer), peer.heartbeat);
			this.db.prepare("INSERT INTO network_computers (computer,connected,seen) VALUES (?,1,?) ON CONFLICT(computer) DO UPDATE SET connected=1,seen=excluded.seen")
				.run(computer, this.now());
		});
	}
	outgoing(computer: string): PartyMessage[] {
		const messages = this.db.prepare(`SELECT m.* FROM messages m JOIN network_messages n ON n.message=m.id
			WHERE n.computer=? AND n.status='queued' ORDER BY m.created,m.id LIMIT 16`).iterate(computer) as unknown as Iterable<PartyMessage>;
		const result: PartyMessage[] = [];
		let size = 256;
		const parts = this.computerSupports(computer, MESSAGE_PARTS);
		for (const message of messages) {
			if (this.messageCurrent(message)) {
				// Files go in parts the recipient asks for; to an older Desk, inside a packet of the message's own.
				const headers = this.fileHeaders(message.id), inline = headers.length > 0 && !parts;
				if (inline && headers.reduce((total, file) => total + file.size, 0) > INLINE_FILE_BYTES) {
					this.db.prepare("UPDATE network_messages SET status='failed',error=? WHERE message=?")
						.run("The recipient's computer runs an older Desk that takes at most 8 MB of files. It updates itself; send again then.", message.id);
					continue;
				}
				if (inline && result.length) break;
				const wire = { ...message, recipient: nativeId(message.recipient),
					...(inline ? { files: this.messageFiles(message.id) } : headers.length ? { files: headers, parts: true } : {}) }, bytes = Buffer.byteLength(JSON.stringify(wire));
				if (size + bytes > MAX_NETWORK_PACKET) break;
				result.push(wire); size += bytes;
				if (inline) break;
			}
			else this.db.prepare("UPDATE network_messages SET status='failed',error=? WHERE message=?")
				.run("Agent membership changed before delivery.", message.id);
		}
		return result;
	}
	/** A message from another computer: delivered, refused, or (undefined) held while its files arrive in parts. */
	acceptRemoteMessage(computer: string, input: unknown): DeliveryReceipt | undefined {
		if ((input as { parts?: unknown }).parts === true) return this.holdForParts(computer, input);
		const wire = remoteMessage(input), message = { ...wire, sender: agentId(computer, wire.sender) };
		// Files are checked against their hashes and stored apart from the message row.
		const raw = (input as { files?: unknown }).files, files = Array.isArray(raw) ? raw.slice(0, MAX_MESSAGE_FILES + 1) as MessageFile[] : [];
		checkFiles(files);
		return this.tx(() => {
			const old = this.db.prepare("SELECT * FROM messages WHERE id=?").get(message.id) as unknown as PartyMessage | undefined;
			if (old) {
				if (Object.keys(message).some(key => old[key as keyof PartyMessage] !== message[key as keyof PartyMessage])) throw Error("Party message identity was reused.");
				return { id: message.id, accepted: true };
			}
			const sender = this.member(message.sender), recipient = this.member(message.recipient);
			if (!this.computerOnline(computer) || sender?.computer !== computer || !recipient || recipient.computer
				|| !this.messageCurrent(message)) {
				return { id: message.id, accepted: false, error: "Agent membership changed before delivery." };
			}
			const pending = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND admitted=0").get(message.recipient) as { n: number };
			if (pending.n >= 64) return { id: message.id, accepted: false, error: "The recipient's inbox is full." };
			if (files.length && recipient.cwd === "ChatGPT") return { id: message.id, accepted: false, error: "This agent cannot receive files." };
			this.insertMessage(message);
			this.insertFiles(message.id, files);
			return { id: message.id, accepted: true };
		});
	}
	private holdForParts(computer: string, input: unknown): DeliveryReceipt | undefined {
		const wire = remoteMessage(input), raw = (input as { files?: unknown }).files;
		const headers = Array.isArray(raw) ? raw.slice(0, MAX_MESSAGE_FILES + 1) as FileHeader[] : [];
		checkFiles(headers.map(file => ({ ...file, data: "" })), true);
		if (this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(wire.id)) return { id: wire.id, accepted: true };
		if (this.db.prepare("SELECT 1 FROM incoming_messages WHERE message=?").get(wire.id)) return;
		// Refused now rather than after the files arrive: the same checks run again when they have.
		const sender = this.member(agentId(computer, wire.sender)), recipient = this.member(wire.recipient);
		if (!this.computerOnline(computer) || sender?.computer !== computer || !recipient || recipient.computer || !this.messageCurrent({ ...wire, sender: agentId(computer, wire.sender) }))
			return { id: wire.id, accepted: false, error: "Agent membership changed before delivery." };
		if (recipient.cwd === "ChatGPT") return { id: wire.id, accepted: false, error: "This agent cannot receive files." };
		this.tx(() => {
			this.db.prepare("DELETE FROM incoming_messages WHERE created<?").run(this.now() - 2 * 86_400_000);
			this.db.exec("DELETE FROM incoming_files WHERE message NOT IN (SELECT message FROM incoming_messages); DELETE FROM incoming_parts WHERE message NOT IN (SELECT message FROM incoming_messages)");
			this.db.prepare("INSERT INTO incoming_messages VALUES (?,?,?,?)").run(wire.id, computer, JSON.stringify({ ...input as object, files: undefined, parts: undefined }), this.now());
			for (const file of headers) this.db.prepare("INSERT INTO incoming_files VALUES (?,?,?,?)").run(wire.id, file.name, file.size, file.sha256);
		});
	}
	/** The next part this computer should ask a computer for: the first file of its oldest held message not yet whole. */
	nextFilePart(computer: string): { message: string; name: string; offset: number } | undefined {
		const row = this.db.prepare(`SELECT f.message, f.name, coalesce((SELECT sum(length(p.data)) FROM incoming_parts p WHERE p.message=f.message AND p.name=f.name), 0) AS offset, f.size
			FROM incoming_files f JOIN incoming_messages m ON m.message=f.message WHERE m.computer=? ORDER BY m.created, f.message, f.name`).all(computer) as { message: string; name: string; offset: number; size: number }[];
		const next = row.find(file => file.offset < file.size);
		return next ? { message: next.message, name: next.name, offset: next.offset } : undefined;
	}
	/**
	 * A part of a held message's file. When every file is whole and matches its hash, the message is delivered as one
	 * that arrived with its files, and its receipt is returned; a mismatch drops it, to be sent again.
	 */
	addFilePart(computer: string, input: unknown): DeliveryReceipt | undefined {
		const part = input as { message?: unknown; name?: unknown; offset?: unknown; data?: unknown; error?: unknown };
		const held = this.db.prepare("SELECT wire FROM incoming_messages WHERE message=? AND computer=?").get(part.message as string, computer) as { wire: string } | undefined;
		if (!held || typeof part.name !== "string") return;
		const drop = (error: string): DeliveryReceipt => {
			this.tx(() => { for (const table of ["incoming_messages", "incoming_files", "incoming_parts"]) this.db.prepare(`DELETE FROM ${table} WHERE message=?`).run(part.message as string); });
			return { id: part.message as string, accepted: false, error };
		};
		if (typeof part.error === "string") return drop(part.error.slice(0, 400));
		const file = this.db.prepare("SELECT size FROM incoming_files WHERE message=? AND name=?").get(part.message as string, part.name) as { size: number } | undefined;
		const next = this.nextFilePart(computer);
		if (!file || !next || typeof part.data !== "string" || next.message !== part.message || next.name !== part.name || next.offset !== part.offset) return;
		const data = Buffer.from(part.data, "base64");
		if (!data.length || data.length > FILE_PART_BYTES || next.offset + data.length > file.size) return drop("A file part arrived damaged.");
		this.db.prepare("INSERT INTO incoming_parts VALUES (?,?,?,?)").run(part.message as string, part.name, next.offset, data);
		const remaining = this.db.prepare(`SELECT 1 FROM incoming_files f WHERE f.message=? AND f.size > coalesce((SELECT sum(length(p.data)) FROM incoming_parts p
			WHERE p.message=f.message AND p.name=f.name), 0)`).get(part.message as string);
		if (remaining) return;
		const files = (this.db.prepare("SELECT name, size, sha256 FROM incoming_files WHERE message=? ORDER BY name").all(part.message as string) as unknown as FileHeader[]).map(header => {
			const chunks = (this.db.prepare("SELECT data FROM incoming_parts WHERE message=? AND name=? ORDER BY offset").all(part.message as string, header.name) as { data: Uint8Array }[]);
			return { ...header, data: Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data))).toString("base64") };
		});
		let receipt: DeliveryReceipt | undefined;
		try { receipt = this.acceptRemoteMessage(computer, { ...JSON.parse(held.wire), files }); }
		catch (error) { return drop(error instanceof Error ? error.message : String(error)); }
		this.tx(() => { for (const table of ["incoming_messages", "incoming_files", "incoming_parts"]) this.db.prepare(`DELETE FROM ${table} WHERE message=?`).run(part.message as string); });
		return receipt;
	}
	/** A part of a file this computer sent, for the computer the message is for; undefined once that message is settled. */
	filePart(computer: string, message: string, name: string, offset: number): Buffer | undefined {
		if (!this.db.prepare("SELECT 1 FROM network_messages WHERE message=? AND computer=? AND status='queued'").get(message, computer)) return;
		const row = this.db.prepare("SELECT substr(data, ?, ?) AS part FROM message_files WHERE message=? AND name=?").get(offset + 1, FILE_PART_BYTES, message, name) as { part: Uint8Array } | undefined;
		return row ? Buffer.from(row.part) : undefined;
	}
	private fileHeaders(message: string): FileHeader[] {
		return this.db.prepare("SELECT name, size, sha256 FROM message_files WHERE message=? ORDER BY name").all(message) as unknown as FileHeader[];
	}
	recordReceipts(computer: string, input: unknown): void {
		if (!Array.isArray(input) || input.length > 16) throw Error("Invalid party receipts.");
		this.tx(() => {
			for (const value of input) {
				const receipt = value as DeliveryReceipt;
				if (!receipt || !uuid(receipt.id) || typeof receipt.accepted !== "boolean"
					|| receipt.error !== undefined && (typeof receipt.error !== "string" || receipt.error.length > 500)) throw Error("Invalid party receipt.");
				this.db.prepare("UPDATE network_messages SET status=?,error=? WHERE message=? AND computer=? AND status='queued'")
					.run(receipt.accepted ? "delivered" : "failed", receipt.error ?? null, receipt.id, computer);
			}
		});
	}
	deliveryStatus(session: string, owner: string): { id: string; to: string; status: string; error?: string }[] {
		this.owned(session, owner);
		return this.db.prepare(`SELECT m.id,m.recipient AS 'to',n.status,n.error FROM network_messages n JOIN messages m ON m.id=n.message
			WHERE m.sender=? ORDER BY m.created DESC,m.id LIMIT 20`).all(session) as unknown as { id: string; to: string; status: string; error?: string }[];
	}
	private messageCurrent(message: PartyMessage): boolean {
		const sender = this.member(message.sender), recipient = this.member(message.recipient);
		return !!sender && !!recipient && !message.room && message.kind === "message"
			&& sender.agent_epoch === message.sender_epoch && recipient.agent_epoch === message.recipient_epoch;
	}
	private tx<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const value = run(); this.db.exec("COMMIT"); return value; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	member(session: string): Member | undefined {
		return this.db.prepare("SELECT * FROM party_agents WHERE session=?").get(session) as unknown as Member | undefined;
	}
	private owned(session: string, owner: string): Member {
		const member = this.member(session);
		if (!member || member.owner !== owner) throw Error("Agent registration is no longer owned by this session process.");
		return member;
	}
	register(session: string, owner: string, label: string, cwd = "", kind = "session", file?: string): Member {
		return this.tx(() => {
			const old = this.member(session);
			// A conversation Desk is restarting has released its old process; its replacement takes the registration over.
			if (old && old.owner !== owner && old.heartbeat > this.now() - LEASE_MS && old.state !== "restarting")
				throw Error("This session is already connected from another Pi process.");
			this.db.prepare(`INSERT INTO members
				(session,room,epoch,label,owner,heartbeat,state,wakes,agent_epoch,cwd,description,kind,delivery)
				VALUES (?,'',?,?,?,?, 'idle',0,?,?,'',?,0)
				ON CONFLICT(session) DO UPDATE SET label=excluded.label, owner=excluded.owner,
				heartbeat=excluded.heartbeat,state=excluded.state,cwd=excluded.cwd,kind=excluded.kind,
				delivery=CASE WHEN members.state='restarting' THEN members.delivery ELSE 0 END`)
				.run(session, randomUUID(), label.slice(0, 120), owner, this.now(), randomUUID(), cwd, kind);
			if (file) this.db.prepare("INSERT INTO session_files VALUES (?,?) ON CONFLICT(session) DO UPDATE SET file=excluded.file").run(session, file);
			return this.member(session)!;
		});
	}
	/**
	 * Desk is restarting this agent's conversation onto a new version. It keeps its identity and inbox, so
	 * peers see it as restarting rather than offline. Only the old process's registration is changed;
	 * pass the returned owner to refresh it, which stops once the new process registers.
	 */
	restarting(session: string, owner?: string, delivery?: boolean): string | undefined {
		const member = this.member(session);
		if (!member || owner !== undefined && member.owner !== owner) return;
		// Releasing the old process disarmed delivery; restore what it was so peers can still wake the agent.
		this.db.prepare("UPDATE members SET state='restarting', heartbeat=?, delivery=COALESCE(?, delivery) WHERE session=? AND owner=?")
			.run(this.now(), delivery === undefined ? null : delivery ? 1 : 0, session, member.owner);
		return member.owner;
	}
	sessionFile(session: string): string | undefined {
		return (this.db.prepare("SELECT file FROM session_files WHERE session=?").get(session) as { file: string } | undefined)?.file;
	}
	profile(session: string, owner: string, description: string): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET description=? WHERE session=? AND owner=?").run(description, session, owner);
	}
	discover(query = "", includeOffline = false, offset = 0): { agents: Member[]; nextOffset?: number } {
		const rows = this.db.prepare(`SELECT * FROM party_agents
			WHERE (? OR heartbeat>?) AND instr(lower(label || ' ' || cwd || ' ' || description),lower(?))>0
			ORDER BY session LIMIT 51 OFFSET ?`).all(includeOffline ? 1 : 0, this.now() - LEASE_MS, query, offset) as unknown as Member[];
		return { agents: rows.slice(0, 50), ...(rows.length > 50 ? { nextOffset: offset + 50 } : {}) };
	}
	touch(session: string, owner: string, state: string, label?: string): void {
		const result = this.db.prepare("UPDATE members SET heartbeat=?,state=?,label=COALESCE(?,label) WHERE session=? AND owner=?")
			.run(this.now(), state, label?.slice(0, 120) ?? null, session, owner);
		if (result.changes !== 1) throw Error("Party ownership changed.");
	}
	release(session: string, owner: string): void {
		this.db.prepare("UPDATE members SET heartbeat=0,state='offline',delivery=0 WHERE session=? AND owner=?").run(session, owner);
	}
	/** Read direct-message history without admitting messages, renewing leases or reserving wakes. */
	history(session: string, owner: string, query?: HistoryQuery): HistoryPage {
		this.owned(session, owner);
		const scope = "m.room='' AND (m.sender=? OR m.recipient=?)", scopeArgs = [session, session];
		const cursor = query && ("before" in query ? query.before : "after" in query ? query.after : undefined);
		const ascending = !!query && !("before" in query);
		const comparison = query && "before" in query ? "<" : ">";
		const rows = this.db.prepare(`SELECT m.*, COALESCE(sender.label, m.sender_label) AS sender_label,
			COALESCE(recipient.label, 'Former agent') AS recipient_label
			FROM messages m LEFT JOIN party_agents recipient ON recipient.session=m.recipient AND recipient.agent_epoch=m.recipient_epoch
			LEFT JOIN party_agents sender ON sender.session=m.sender AND sender.agent_epoch=m.sender_epoch
			WHERE ${scope} ${cursor ? `AND (m.created,m.id) ${comparison} (?,?)` : ""}
			ORDER BY m.created ${ascending ? "ASC" : "DESC"}, m.id ${ascending ? "ASC" : "DESC"} LIMIT 20`)
			.all(...scopeArgs, ...(cursor ? [cursor.created, cursor.id] : [])) as unknown as HistoryMessage[];
		if (!ascending) rows.reverse();
		const first = rows[0], last = rows.at(-1);
		const exists = (cursor: HistoryCursor, comparison: "<" | ">") => !!this.db.prepare(
			`SELECT 1 FROM messages m WHERE ${scope} AND (m.created,m.id) ${comparison} (?,?) LIMIT 1`,
		).get(...scopeArgs, cursor.created, cursor.id);
		return { messages: rows, hasOlder: !!first && exists(first, "<"), hasNewer: !!last && exists(last, ">") };
	}
	private resolve(target: string, peers: Member[]): Member {
		if (!target.trim()) throw Error("Choose an agent ID from agent_list.");
		const exact = peers.find(peer => peer.session === target);
		if (exact) return exact;
		const matches = peers.filter(peer => peer.session.startsWith(target));
		if (matches.length > 1) throw Error(`More than one agent ID starts with ${target}. Choose one from agent_list.`);
		// Other computers list only their open conversations, so a closed one there is unknown here.
		if (!matches.length) throw Error(target.includes("@")
			? `${target} is not open on its computer. A conversation on another computer can be messaged only while it is open there.`
			: `No agent has the ID ${target}. Choose an agent ID from agent_list.`);
		return matches[0];
	}
	send(session: string, owner: string, target: string, text: string, wake: boolean, files: MessageFile[] = []): PartyMessage {
		if (!text.trim()) throw Error("Messages must contain non-whitespace text.");
		checkFiles(files);
		return this.tx(() => {
			const self = this.owned(session, owner);
			const peer = this.resolve(target, this.db.prepare("SELECT * FROM party_agents WHERE session<>?").all(session) as unknown as Member[]);
			if (peer.computer && !this.computerOnline(peer.computer)) throw Error(`The computer for ${peer.session} is disconnected.`);
			const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND admitted=0
				AND NOT EXISTS (SELECT 1 FROM network_messages n WHERE n.message=messages.id AND n.status<>'queued')`)
				.get(peer.session) as { n: number };
			if (pending.n >= 64) throw Error(`The inbox for ${peer.session} is full.`);
			if (files.length && peer.cwd === "ChatGPT") throw Error(`${peer.label} cannot receive files; put what it needs in the message.`);
			if (files.length && peer.computer && !this.computerSupports(peer.computer, "files"))
				throw Error(`The computer for ${peer.label} runs an older Desk that cannot receive files. Update Desk there, or put what it needs in the message.`);
			const message: PartyMessage = {
				id: randomUUID(), room: "", sender: session, sender_epoch: self.agent_epoch, sender_label: self.label,
				recipient: peer.session, recipient_epoch: peer.agent_epoch, text, created: this.now(), wake: wake ? 1 : 0, kind: "message", invite_room: "",
			};
			if (peer.computer && Buffer.byteLength(JSON.stringify(message)) > MAX_NETWORK_PACKET - 1024) throw Error("Message exceeds the encrypted transport limit.");
			this.insertMessage(message);
			this.insertFiles(message.id, files);
			if (peer.computer) this.db.prepare("INSERT INTO network_messages (message,computer,status) VALUES (?,?,'queued')").run(message.id, peer.computer);
			this.db.prepare(`DELETE FROM messages WHERE created<? AND (admitted=1 OR EXISTS
				(SELECT 1 FROM network_messages n WHERE n.message=messages.id AND n.status<>'queued'))`).run(this.now() - 7 * 86_400_000);
			this.db.exec("DELETE FROM network_messages WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id=network_messages.message)");
			this.db.exec("DELETE FROM message_files WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id=message_files.message)");
			return message;
		});
	}
	private insertMessage(message: PartyMessage): void {
		this.db.prepare("INSERT INTO messages (id,room,sender,sender_epoch,sender_label,recipient,recipient_epoch,text,created,wake,kind,invite_room) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
			.run(message.id, message.room, message.sender, message.sender_epoch, message.sender_label, message.recipient,
				message.recipient_epoch, message.text, message.created, message.wake, message.kind, message.invite_room);
	}
	private validMessages = `SELECT m.* FROM messages m JOIN party_agents sender ON sender.session=m.sender
		JOIN party_agents recipient ON recipient.session=m.recipient
		WHERE m.recipient=? AND (${CURRENT_MESSAGE_SQL})`;
	/** Unadmitted messages for an agent, oldest first; seq is the local arrival order, independent of any sender's clock. */
	pending(session: string, owner: string): (PartyMessage & { seq: number })[] {
		this.owned(session, owner);
		return this.db.prepare(`${this.validMessages.replace("SELECT m.*", "SELECT m.*, m.rowid AS seq")} AND m.admitted=0 ORDER BY m.created,m.id LIMIT 64`)
			.all(session) as unknown as (PartyMessage & { seq: number })[];
	}
	/** The arrival position of the newest stored message; later messages have a higher seq. */
	messageMark(): number {
		return Number((this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM messages").get() as { n: number }).n);
	}
	/**
	 * Whether a message delivered to this agent still belongs in its context. Only the recipient's side counts: a
	 * sender that has since closed or restarted does not withdraw what was already delivered. Removing such a
	 * message left a request ending with the agent's own reply, which Claude rejects as prefill.
	 */
	isDelivered(session: string, owner: string, id: string): boolean {
		this.owned(session, owner);
		return !!this.db.prepare(`SELECT 1 FROM messages m JOIN party_agents recipient ON recipient.session=m.recipient
			WHERE m.recipient=? AND m.id=? AND m.room='' AND recipient.agent_epoch=m.recipient_epoch`).get(session, id);
	}
	admit(session: string, owner: string, ids: string[]): void {
		this.tx(() => {
			this.owned(session, owner);
			for (const id of ids) if (this.isDelivered(session, owner, id)) {
				this.db.prepare("UPDATE messages SET admitted=1 WHERE id=? AND recipient=?").run(id, session);
				// Its files were saved to the recipient's disk when it was delivered.
				this.db.prepare("DELETE FROM message_files WHERE message=?").run(id);
			}
		});
	}
	setDelivery(session: string, owner: string, enabled: boolean): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET delivery=? WHERE session=? AND owner=?").run(enabled ? 1 : 0, session, owner);
	}

}

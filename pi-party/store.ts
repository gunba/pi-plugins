import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { agentId, nativeId, networkMembers, remoteMember, remoteMessage, NETWORK_LIMIT, MAX_NETWORK_PACKET, uuid,
	type DeliveryReceipt, type NetworkMember } from "./network.ts";

export const LEASE_MS = 45_000;
export const CURRENT_MESSAGE_SQL = `(m.room='' AND sender.agent_epoch=m.sender_epoch AND recipient.agent_epoch=m.recipient_epoch)
	OR (m.room<>'' AND sender.epoch=m.sender_epoch AND recipient.epoch=m.recipient_epoch
		AND sender.room=m.room AND recipient.room=m.room)`;
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
export interface HistoryCursor { created: number; id: string }
export type HistoryQuery = { before: HistoryCursor } | { after: HistoryCursor } | { oldest: true } | undefined;
export interface HistoryMessage extends PartyMessage { admitted: number; recipient_label: string }
export interface HistoryPage { room: string; messages: HistoryMessage[]; hasOlder: boolean; hasNewer: boolean }

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
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS network_members (session TEXT PRIMARY KEY, computer TEXT NOT NULL,
					profile TEXT NOT NULL, heartbeat INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS network_computers (computer TEXT PRIMARY KEY, connected INTEGER NOT NULL, seen INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS network_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS session_files (session TEXT PRIMARY KEY, file TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS network_messages (message TEXT PRIMARY KEY, computer TEXT NOT NULL,
					status TEXT NOT NULL, error TEXT);
			`);
			const fields = ["session", "room", "epoch", "label", "owner", "heartbeat", "state", "wakes",
				"agent_epoch", "cwd", "description", "kind", "delivery", "muted"];
			this.db.exec(`CREATE VIEW IF NOT EXISTS party_agents AS SELECT ${fields.join(",")}, NULL AS computer FROM members
				UNION ALL SELECT ${fields.map(field => ["session", "heartbeat"].includes(field) ? field : `json_extract(profile,'$.${field}')`).join(",")}, computer FROM network_members`);
		});
	}
	close(): void { this.db.close(); }
	localMembers(): Member[] {
		return this.db.prepare("SELECT * FROM members WHERE heartbeat>? OR room<>'' ORDER BY heartbeat DESC,session LIMIT ?")
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
	computers(): { id: string; state: string }[] {
		return (this.db.prepare("SELECT computer FROM network_computers ORDER BY computer").all() as { computer: string }[])
			.map(row => ({ id: row.computer, state: this.computerOnline(row.computer) ? "connected" : "offline" }));
	}
	computerOnline(computer: string): boolean {
		return !!this.db.prepare("SELECT 1 FROM network_computers WHERE computer=? AND connected=1 AND seen>?").get(computer, this.now() - LEASE_MS);
	}
	cacheDirectory(computer: string, input: unknown): void {
		if (!Array.isArray(input) || input.length > NETWORK_LIMIT) throw Error("Invalid party directory.");
		const peers = input.map(value => remoteMember(computer, value, this.now()));
		if (new Set(peers.map(peer => peer.session)).size !== peers.length) throw Error("Duplicate party agent.");
		this.tx(() => {
			const old = this.db.prepare("SELECT session FROM network_members WHERE computer=?").all(computer) as { session: string }[];
			for (const { session } of old) {
				const previous = this.member(session)!, next = peers.find(peer => peer.session === session);
				if (!next || previous.room !== next.room || previous.epoch !== next.epoch) this.revokeRoom(session);
			}
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
		for (const message of messages) {
			if (this.messageCurrent(message)) {
				const wire = { ...message, recipient: nativeId(message.recipient) }, bytes = Buffer.byteLength(JSON.stringify(wire));
				if (size + bytes > MAX_NETWORK_PACKET) break;
				result.push(wire); size += bytes;
			}
			else this.db.prepare("UPDATE network_messages SET status='failed',error=? WHERE message=?")
				.run("Agent membership changed before delivery.", message.id);
		}
		return result;
	}
	acceptRemoteMessage(computer: string, input: unknown): DeliveryReceipt {
		const wire = remoteMessage(input), message = { ...wire, sender: agentId(computer, wire.sender) };
		return this.tx(() => {
			const old = this.db.prepare("SELECT * FROM messages WHERE id=?").get(message.id) as unknown as PartyMessage | undefined;
			if (old) {
				if (Object.keys(message).some(key => old[key as keyof PartyMessage] !== message[key as keyof PartyMessage])) throw Error("Party message identity was reused.");
				return { id: message.id, accepted: true };
			}
			const sender = this.member(message.sender), recipient = this.member(message.recipient);
			if (!this.computerOnline(computer) || sender?.computer !== computer || !recipient || recipient.computer
				|| !this.messageCurrent(message) || message.kind === "invite" && sender.room !== message.invite_room) {
				return { id: message.id, accepted: false, error: "Agent membership changed before delivery." };
			}
			const pending = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND admitted=0").get(message.recipient) as { n: number };
			if (pending.n >= 64) return { id: message.id, accepted: false, error: "The recipient's inbox is full." };
			this.insertMessage(message);
			return { id: message.id, accepted: true };
		});
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
		if (!sender || !recipient) return false;
		return message.room ? sender.room === message.room && recipient.room === message.room
			&& sender.epoch === message.sender_epoch && recipient.epoch === message.recipient_epoch
			: sender.agent_epoch === message.sender_epoch && recipient.agent_epoch === message.recipient_epoch;
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
			if (old && old.owner !== owner && old.heartbeat > this.now() - LEASE_MS) throw Error("This session is already connected from another Pi process.");
			this.db.prepare(`INSERT INTO members
				(session,room,epoch,label,owner,heartbeat,state,wakes,agent_epoch,cwd,description,kind,delivery)
				VALUES (?,'',?,?,?,?, 'idle',0,?,?,'',?,0)
				ON CONFLICT(session) DO UPDATE SET label=excluded.label, owner=excluded.owner,
				heartbeat=excluded.heartbeat,state=excluded.state,cwd=excluded.cwd,kind=excluded.kind,delivery=0`)
				.run(session, randomUUID(), label.slice(0, 120), owner, this.now(), randomUUID(), cwd, kind);
			if (file) this.db.prepare("INSERT INTO session_files VALUES (?,?) ON CONFLICT(session) DO UPDATE SET file=excluded.file").run(session, file);
			return this.member(session)!;
		});
	}
	sessionFile(session: string): string | undefined {
		return (this.db.prepare("SELECT file FROM session_files WHERE session=?").get(session) as { file: string } | undefined)?.file;
	}
	resumeDelivery(session: string, epoch: string): void {
		this.db.prepare("UPDATE members SET delivery=1 WHERE session=? AND epoch=? AND muted=0 AND kind='session'").run(session, epoch);
	}
	profile(session: string, owner: string, description: string): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET description=? WHERE session=? AND owner=?").run(description, session, owner);
	}
	discover(query = "", includeOffline = false, offset = 0): { agents: Member[]; nextOffset?: number } {
		const rows = this.db.prepare(`SELECT * FROM party_agents
			WHERE (? OR heartbeat>?) AND instr(lower(label || ' ' || cwd || ' ' || description || ' ' || room),lower(?))>0
			ORDER BY session LIMIT 51 OFFSET ?`).all(includeOffline ? 1 : 0, this.now() - LEASE_MS, query, offset) as unknown as Member[];
		return { agents: rows.slice(0, 50), ...(rows.length > 50 ? { nextOffset: offset + 50 } : {}) };
	}
	private roomId(room: string): string {
		if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(room)) throw Error("Party IDs use 1–48 letters, numbers, hyphens or underscores.");
		return room.toLowerCase();
	}
	private revokeRoom(session: string): void {
		this.db.prepare("DELETE FROM messages WHERE room<>'' AND admitted=0 AND (recipient=? OR sender=?)").run(session, session);
	}
	join(session: string, owner: string, room: string, label: string): Member {
		room = this.roomId(room);
		if (!this.member(session)) this.register(session, owner, label);
		return this.tx(() => {
			const old = this.owned(session, owner);
			if (old.room !== room) this.revokeRoom(session);
			const epoch = old.room === room ? old.epoch : randomUUID();
			this.db.prepare("UPDATE members SET room=?,epoch=?,label=? WHERE session=? AND owner=?")
				.run(room, epoch, label.slice(0, 120), session, owner);
			return this.member(session)!;
		});
	}
	touch(session: string, owner: string, state: string, label?: string): void {
		const result = this.db.prepare("UPDATE members SET heartbeat=?,state=?,label=COALESCE(?,label) WHERE session=? AND owner=?")
			.run(this.now(), state, label?.slice(0, 120) ?? null, session, owner);
		if (result.changes !== 1) throw Error("Party ownership changed.");
	}
	release(session: string, owner: string): void {
		this.db.prepare("UPDATE members SET heartbeat=0,state='offline',delivery=0 WHERE session=? AND owner=?").run(session, owner);
	}
	/** Explicit user membership changes, atomic across the selected registered agents. */
	setMembership(sessions: string[], room: string | null, expectedRoom?: string): void {
		const next = room === null ? "" : this.roomId(room);
		const expected = expectedRoom === undefined ? undefined : this.roomId(expectedRoom);
		this.tx(() => {
			const members = [...new Set(sessions)].map(session => {
				const member = this.member(session);
				if (!member) throw Error("Agent is no longer registered.");
				if (member.computer) throw Error("Change this agent's membership on its computer.");
				if (expected !== undefined && member.room !== expected) throw Error("Agent party changed; refresh before removing it.");
				return member;
			});
			for (const member of members) if (member.room !== next) {
				this.revokeRoom(member.session);
				this.db.prepare("UPDATE members SET room=?,epoch=? WHERE session=?").run(next, randomUUID(), member.session);
			}
		});
	}
	leave(session: string, owner: string): void {
		this.tx(() => {
			this.owned(session, owner);
			this.revokeRoom(session);
			this.db.prepare("UPDATE members SET room='',epoch=? WHERE session=?").run(randomUUID(), session);
		});
	}
	partyTarget(session: string, owner: string, target: string): Member {
		if (!this.owned(session, owner).room) throw Error("Join a party before managing its members.");
		return this.resolve(target, this.members(session, owner).filter(peer => peer.session !== session));
	}
	remove(session: string, owner: string, target: string): Member {
		const peer = this.partyTarget(session, owner, target);
		if (peer.computer) throw Error("Change this agent's membership on its computer.");
		return this.detachMember(peer.session, peer.room, peer.epoch, { id: session, epoch: this.owned(session, owner).epoch, owner });
	}
	detachMember(session: string, room: string, epoch: string, sender?: { id: string; epoch: string; owner?: string }): Member {
		return this.tx(() => {
			if (sender) {
				const actor = this.member(sender.id);
				if (!actor || actor.room !== room || actor.epoch !== sender.epoch || sender.owner !== undefined && actor.owner !== sender.owner) throw Error("The requesting agent's party membership changed.");
			}
			const peer = this.member(session);
			if (!peer || peer.computer || peer.room !== room || peer.epoch !== epoch) throw Error("The agent's party membership changed.");
			this.revokeRoom(peer.session);
			this.db.prepare("UPDATE members SET room='',epoch=? WHERE session=?").run(randomUUID(), peer.session);
			return peer;
		});
	}
	members(session: string, owner: string): Member[] {
		const self = this.owned(session, owner);
		if (!self.room) return [];
		return this.group(self.room);
	}
	group(room: string): Member[] {
		return this.db.prepare("SELECT * FROM party_agents WHERE room=? ORDER BY label,session").all(this.roomId(room)) as unknown as Member[];
	}
	/** Read room history without admitting messages, renewing leases or reserving wakes. */
	history(session: string, owner: string, query?: HistoryQuery, direct = false): HistoryPage {
		const self = this.owned(session, owner);
		const room = direct ? "" : self.room;
		const scope = room ? "m.room=?" : "m.room=? AND (m.sender=? OR m.recipient=?)";
		const scopeArgs = room ? [room] : [room, session, session];
		const cursor = query && ("before" in query ? query.before : "after" in query ? query.after : undefined);
		const ascending = !!query && !("before" in query);
		const comparison = query && "before" in query ? "<" : ">";
		const rows = this.db.prepare(`SELECT m.*, COALESCE(sender.label, m.sender_label) AS sender_label,
			COALESCE(recipient.label, 'Former member') AS recipient_label
			FROM messages m LEFT JOIN party_agents recipient ON recipient.session=m.recipient
				AND (CASE WHEN m.room='' THEN recipient.agent_epoch ELSE recipient.epoch END)=m.recipient_epoch
			LEFT JOIN party_agents sender ON sender.session=m.sender
				AND (CASE WHEN m.room='' THEN sender.agent_epoch ELSE sender.epoch END)=m.sender_epoch
			WHERE ${scope} ${cursor ? `AND (m.created,m.id) ${comparison} (?,?)` : ""}
			ORDER BY m.created ${ascending ? "ASC" : "DESC"}, m.id ${ascending ? "ASC" : "DESC"} LIMIT 20`)
			.all(...scopeArgs, ...(cursor ? [cursor.created, cursor.id] : [])) as unknown as HistoryMessage[];
		if (!ascending) rows.reverse();
		const first = rows[0], last = rows.at(-1);
		const exists = (cursor: HistoryCursor, comparison: "<" | ">") => !!this.db.prepare(
			`SELECT 1 FROM messages m WHERE ${scope} AND (m.created,m.id) ${comparison} (?,?) LIMIT 1`,
		).get(...scopeArgs, cursor.created, cursor.id);
		return { room, messages: rows, hasOlder: !!first && exists(first, "<"), hasNewer: !!last && exists(last, ">") };
	}
	private resolve(target: string, peers: Member[]): Member {
		if (!target.trim()) throw Error("Choose an agent ID from party_discover or party_members.");
		const exact = peers.find(peer => peer.session === target);
		if (exact) return exact;
		const matches = peers.filter(peer => peer.session.startsWith(target));
		if (matches.length !== 1) throw Error("Choose an unambiguous agent ID from party_discover or party_members.");
		return matches[0];
	}
	send(session: string, owner: string, target: string, text: string, wake: boolean, inviteRoom?: string): PartyMessage[] {
		if (!text.trim()) throw Error("Party messages must contain non-whitespace text.");
		return this.tx(() => {
			const self = this.owned(session, owner);
			const invitation = inviteRoom === undefined ? "" : this.roomId(inviteRoom);
			if (invitation && invitation !== self.room) throw Error("Join the party before inviting agents to it.");
			if (target === "all" && (invitation || !self.room)) throw Error("Broadcast requires a party; invitations address one agent.");
			const matches = target === "all"
				? this.members(session, owner).filter(peer => peer.session !== session)
				: [this.resolve(target, this.db.prepare("SELECT * FROM party_agents WHERE session<>?").all(session) as unknown as Member[])];
			if (matches.length > 16) throw Error("Broadcast is limited to 16 peers; address individual members.");
			const messages: PartyMessage[] = [];
			for (const peer of matches) {
				if (peer.computer && !this.computerOnline(peer.computer)) throw Error(`The computer for ${peer.session} is disconnected.`);
				const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND admitted=0
					AND NOT EXISTS (SELECT 1 FROM network_messages n WHERE n.message=messages.id AND n.status<>'queued')`)
					.get(peer.session) as { n: number };
				if (pending.n >= 64) throw Error(`The inbox for ${peer.session} is full.`);
				const message: PartyMessage = {
					id: randomUUID(), room: target === "all" ? self.room : "", sender: session,
					sender_epoch: target === "all" ? self.epoch : self.agent_epoch, sender_label: self.label,
					recipient: peer.session, recipient_epoch: target === "all" ? peer.epoch : peer.agent_epoch,
					text, created: this.now(), wake: wake ? 1 : 0, kind: invitation ? "invite" : "message", invite_room: invitation,
				};
				if (peer.computer && Buffer.byteLength(JSON.stringify(message)) > MAX_NETWORK_PACKET - 1024) throw Error("Message exceeds the encrypted transport limit.");
				this.insertMessage(message);
				if (peer.computer) this.db.prepare("INSERT INTO network_messages (message,computer,status) VALUES (?,?,'queued')").run(message.id, peer.computer);
				messages.push(message);
			}
			this.db.prepare(`DELETE FROM messages WHERE created<? AND (admitted=1 OR EXISTS
				(SELECT 1 FROM network_messages n WHERE n.message=messages.id AND n.status<>'queued'))`).run(this.now() - 7 * 86_400_000);
			this.db.exec("DELETE FROM network_messages WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id=network_messages.message)");
			return messages;
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
	pending(session: string, owner: string): PartyMessage[] {
		this.owned(session, owner);
		return this.db.prepare(`${this.validMessages} AND m.admitted=0 ORDER BY m.created,m.id LIMIT 64`).all(session) as unknown as PartyMessage[];
	}
	isCurrent(session: string, owner: string, id: string): boolean {
		this.owned(session, owner);
		return !!this.db.prepare(`${this.validMessages} AND m.id=?`).get(session, id);
	}
	admit(session: string, owner: string, ids: string[]): void {
		this.tx(() => {
			this.owned(session, owner);
			for (const id of ids) if (this.isCurrent(session, owner, id)) this.db.prepare("UPDATE messages SET admitted=1 WHERE id=? AND recipient=?")
				.run(id, session);
		});
	}
	resetWakes(session: string, owner: string): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET wakes=0 WHERE session=? AND owner=?").run(session, owner);
	}
	setDelivery(session: string, owner: string, enabled: boolean): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET delivery=? WHERE session=? AND owner=?").run(enabled ? 1 : 0, session, owner);
	}
	setPaused(session: string, owner: string, paused: boolean): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET muted=? WHERE session=? AND owner=?").run(paused ? 1 : 0, session, owner);
	}
	reserveWake(session: string, owner: string): boolean {
		return this.db.prepare("UPDATE members SET wakes=wakes+1 WHERE session=? AND owner=? AND wakes<8").run(session, owner).changes === 1;
	}
}

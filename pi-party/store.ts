import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const LEASE_MS = 45_000;
export interface Member {
	session: string; room: string; epoch: string; label: string; owner: string;
	heartbeat: number; state: string; wakes: number;
	agent_epoch: string; cwd: string; description: string; kind: string; delivery: number; muted: number;
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
		});
	}
	close(): void { this.db.close(); }
	private tx<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const value = run(); this.db.exec("COMMIT"); return value; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	member(session: string): Member | undefined {
		return this.db.prepare("SELECT * FROM members WHERE session=?").get(session) as unknown as Member | undefined;
	}
	private owned(session: string, owner: string): Member {
		const member = this.member(session);
		if (!member || member.owner !== owner) throw Error("Agent registration is no longer owned by this session process.");
		return member;
	}
	register(session: string, owner: string, label: string, cwd = "", kind = "session"): Member {
		return this.tx(() => {
			const old = this.member(session);
			if (old && old.owner !== owner && old.heartbeat > this.now() - LEASE_MS) throw Error("This session is already connected from another Pi process.");
			this.db.prepare(`INSERT INTO members
				(session,room,epoch,label,owner,heartbeat,state,wakes,agent_epoch,cwd,description,kind,delivery)
				VALUES (?,'',?,?,?,?, 'idle',0,?,?,'',?,0)
				ON CONFLICT(session) DO UPDATE SET label=excluded.label, owner=excluded.owner,
				heartbeat=excluded.heartbeat,state=excluded.state,cwd=excluded.cwd,kind=excluded.kind,delivery=0`)
				.run(session, randomUUID(), label.slice(0, 120), owner, this.now(), randomUUID(), cwd, kind);
			return this.member(session)!;
		});
	}
	profile(session: string, owner: string, description: string): void {
		this.owned(session, owner);
		this.db.prepare("UPDATE members SET description=? WHERE session=? AND owner=?").run(description, session, owner);
	}
	discover(query = "", includeOffline = false, offset = 0): { agents: Member[]; nextOffset?: number } {
		const rows = this.db.prepare(`SELECT * FROM members
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
	leave(session: string, owner: string): void {
		this.tx(() => {
			this.owned(session, owner);
			this.revokeRoom(session);
			this.db.prepare("UPDATE members SET room='',epoch=? WHERE session=?").run(randomUUID(), session);
		});
	}
	remove(session: string, owner: string, target: string): Member {
		return this.tx(() => {
			const self = this.owned(session, owner);
			if (!self.room) throw Error("Join a party before removing a member.");
			const peer = this.resolve(target, this.members(session, owner).filter(peer => peer.session !== session));
			this.revokeRoom(peer.session);
			this.db.prepare("UPDATE members SET room='',epoch=? WHERE session=?").run(randomUUID(), peer.session);
			return peer;
		});
	}
	members(session: string, owner: string): Member[] {
		const self = this.owned(session, owner);
		if (!self.room) return [];
		return this.db.prepare("SELECT * FROM members WHERE room=? ORDER BY label,session").all(self.room) as unknown as Member[];
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
			FROM messages m LEFT JOIN members recipient ON recipient.session=m.recipient
				AND (CASE WHEN m.room='' THEN recipient.agent_epoch ELSE recipient.epoch END)=m.recipient_epoch
			LEFT JOIN members sender ON sender.session=m.sender
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
				: [this.resolve(target, this.db.prepare("SELECT * FROM members WHERE session<>?").all(session) as unknown as Member[])];
			if (matches.length > 16) throw Error("Broadcast is limited to 16 peers; address individual members.");
			const messages: PartyMessage[] = [];
			for (const peer of matches) {
				const pending = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND admitted=0")
					.get(peer.session) as { n: number };
				if (pending.n >= 64) throw Error(`The inbox for ${peer.session} is full.`);
				const message: PartyMessage = {
					id: randomUUID(), room: target === "all" ? self.room : "", sender: session,
					sender_epoch: target === "all" ? self.epoch : self.agent_epoch, sender_label: self.label,
					recipient: peer.session, recipient_epoch: target === "all" ? peer.epoch : peer.agent_epoch,
					text, created: this.now(), wake: wake ? 1 : 0, kind: invitation ? "invite" : "message", invite_room: invitation,
				};
				this.db.prepare("INSERT INTO messages (id,room,sender,sender_epoch,sender_label,recipient,recipient_epoch,text,created,wake,kind,invite_room) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
					.run(message.id, message.room, session, message.sender_epoch, self.label, peer.session, message.recipient_epoch, text, message.created, message.wake, message.kind, invitation);
				messages.push(message);
			}
			this.db.prepare("DELETE FROM messages WHERE admitted=1 AND created<?").run(this.now() - 7 * 86_400_000);
			return messages;
		});
	}
	private validMessages = `SELECT m.* FROM messages m JOIN members sender ON sender.session=m.sender
		JOIN members recipient ON recipient.session=m.recipient
		WHERE m.recipient=? AND (
			(m.room='' AND sender.agent_epoch=m.sender_epoch AND recipient.agent_epoch=m.recipient_epoch)
			OR (m.room<>'' AND sender.epoch=m.sender_epoch AND recipient.epoch=m.recipient_epoch
				AND sender.room=m.room AND recipient.room=m.room)
		)`;
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

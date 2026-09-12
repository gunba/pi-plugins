import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const LEASE_MS = 45_000;
export interface Member {
	session: string; room: string; epoch: string; label: string; owner: string;
	heartbeat: number; state: string; wakes: number;
}
export interface PartyMessage {
	id: string; room: string; sender: string; sender_epoch: string; sender_label: string;
	recipient: string; recipient_epoch: string; text: string; created: number; wake: number;
}

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
		`);
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
		if (!member || member.owner !== owner) throw Error("Party membership is no longer owned by this session process.");
		return member;
	}
	join(session: string, owner: string, room: string, label: string): Member {
		if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(room)) throw Error("Party IDs use 1–48 letters, numbers, hyphens or underscores.");
		room = room.toLowerCase();
		return this.tx(() => {
			const old = this.member(session);
			if (old && old.owner !== owner && old.heartbeat > this.now() - LEASE_MS) throw Error("This session is already connected from another Pi process.");
			if (old && old.room !== room) this.db.prepare("DELETE FROM messages WHERE admitted=0 AND (recipient=? OR sender=?)").run(session, session);
			const epoch = old?.room === room ? old.epoch : randomUUID();
			this.db.prepare(`INSERT INTO members VALUES (?,?,?,?,?,?,?,?)
				ON CONFLICT(session) DO UPDATE SET room=excluded.room, epoch=excluded.epoch,
				label=excluded.label, owner=excluded.owner, heartbeat=excluded.heartbeat, state=excluded.state,
				wakes=excluded.wakes`).run(session, room, epoch, label.slice(0, 120), owner, this.now(), "idle", old?.room === room ? old.wakes : 0);
			return this.member(session)!;
		});
	}
	touch(session: string, owner: string, state: string, label?: string): void {
		const result = this.db.prepare("UPDATE members SET heartbeat=?,state=?,label=COALESCE(?,label) WHERE session=? AND owner=?")
			.run(this.now(), state, label?.slice(0, 120) ?? null, session, owner);
		if (result.changes !== 1) throw Error("Party ownership changed.");
	}
	release(session: string, owner: string): void {
		this.db.prepare("UPDATE members SET heartbeat=0,state='offline' WHERE session=? AND owner=?").run(session, owner);
	}
	leave(session: string, owner: string): void {
		this.tx(() => {
			this.owned(session, owner);
			this.db.prepare("DELETE FROM messages WHERE admitted=0 AND (recipient=? OR sender=?)").run(session, session);
			this.db.prepare("DELETE FROM members WHERE session=?").run(session);
		});
	}
	members(session: string, owner: string): Member[] {
		const self = this.owned(session, owner);
		return this.db.prepare("SELECT * FROM members WHERE room=? ORDER BY label,session").all(self.room) as unknown as Member[];
	}
	send(session: string, owner: string, target: string, text: string, wake: boolean): PartyMessage[] {
		if (!text.trim()) throw Error("Party messages must contain non-whitespace text.");
		return this.tx(() => {
			const self = this.owned(session, owner);
			const peers = this.members(session, owner).filter(member => member.session !== session);
			const matches = target === "all" ? peers : peers.filter(member => member.session === target || member.session.startsWith(target));
			if (!matches.length || (target !== "all" && matches.length !== 1)) throw Error("Choose 'all' or an unambiguous member ID from party_members.");
			if (matches.length > 16) throw Error("Broadcast is limited to 16 peers; address individual members.");
			const messages: PartyMessage[] = [];
			for (const peer of matches) {
				const pending = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND recipient_epoch=? AND admitted=0")
					.get(peer.session, peer.epoch) as { n: number };
				if (pending.n >= 64) throw Error(`The inbox for ${peer.session} is full.`);
				const message: PartyMessage = {
					id: randomUUID(), room: self.room, sender: session, sender_epoch: self.epoch, sender_label: self.label,
					recipient: peer.session, recipient_epoch: peer.epoch, text, created: this.now(), wake: wake ? 1 : 0,
				};
				this.db.prepare("INSERT INTO messages (id,room,sender,sender_epoch,sender_label,recipient,recipient_epoch,text,created,wake) VALUES (?,?,?,?,?,?,?,?,?,?)")
					.run(message.id, message.room, session, self.epoch, self.label, peer.session, peer.epoch, text, message.created, message.wake);
				messages.push(message);
			}
			this.db.prepare("DELETE FROM messages WHERE admitted=1 AND created<?").run(this.now() - 7 * 86_400_000);
			return messages;
		});
	}
	pending(session: string, owner: string): PartyMessage[] {
		const self = this.owned(session, owner);
		return this.db.prepare(`SELECT m.* FROM messages m JOIN members sender
			ON sender.session=m.sender AND sender.epoch=m.sender_epoch AND sender.room=m.room
			WHERE m.recipient=? AND m.recipient_epoch=? AND m.room=? AND m.admitted=0
			ORDER BY m.created,m.id LIMIT 64`).all(session, self.epoch, self.room) as unknown as PartyMessage[];
	}
	admit(session: string, owner: string, ids: string[]): void {
		this.tx(() => {
			const self = this.owned(session, owner);
			for (const id of ids) this.db.prepare("UPDATE messages SET admitted=1 WHERE id=? AND recipient=? AND recipient_epoch=?")
				.run(id, session, self.epoch);
		});
	}
	resetWakes(session: string, owner: string): void {
		this.db.prepare("UPDATE members SET wakes=0 WHERE session=? AND owner=?").run(session, owner);
	}
	reserveWake(session: string, owner: string): boolean {
		return this.db.prepare("UPDATE members SET wakes=wakes+1 WHERE session=? AND owner=? AND wakes<8").run(session, owner).changes === 1;
	}
}

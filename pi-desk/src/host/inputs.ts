import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InputStatus, InputSubmission, PromptCommand } from "../shared/inputs.ts";
import { ReceiptConflict } from "./worker-errors.ts";
import type { UpdateCheckpoint } from "../shared/checkpoint.ts";

interface Row {
	id: string; session: string; activation: string; generation: string | null;
	fingerprint: string; payload: string | null; state: InputStatus["state"];
	created: number; updated: number; preview: string; files: number; error: string | null;
}
const fingerprint = (input: InputSubmission) => createHash("sha256")
	.update(JSON.stringify({ activation: input.activation, generation: input.generation, command: input.command })).digest("hex");
const status = (row: Row): InputStatus => ({
	id: row.id, state: row.state, created: row.created, updated: row.updated,
	preview: row.preview, files: row.files, ...(row.error ? { error: row.error } : {}),
});

/** Admission receipts, not conversation history. Only unresolved input retains its payload. */
export class InputLedger {
	private readonly db: DatabaseSync;
	constructor(directory: string) {
		const file = join(directory, "inputs.sqlite");
		this.db = new DatabaseSync(file);
		chmodSync(file, 0o600);
		this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS inputs (
				session TEXT NOT NULL, id TEXT NOT NULL, activation TEXT NOT NULL, generation TEXT,
				fingerprint TEXT NOT NULL, payload TEXT, state TEXT NOT NULL,
				created INTEGER NOT NULL, updated INTEGER NOT NULL, preview TEXT NOT NULL,
				files INTEGER NOT NULL, error TEXT, PRIMARY KEY(session, id));
			CREATE INDEX IF NOT EXISTS inputs_pending ON inputs(session, state, created);
			CREATE TABLE IF NOT EXISTS update_checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL);`);
	}
	checkpoint(): UpdateCheckpoint | undefined {
		const row = this.db.prepare("SELECT payload FROM update_checkpoint WHERE singleton=1").get() as { payload: string } | undefined;
		return row ? JSON.parse(row.payload) as UpdateCheckpoint : undefined;
	}
	writeCheckpoint(ticket: UpdateCheckpoint): void {
		if (!/^[a-f0-9]{64}$/.test(ticket.source) || !/^[a-f0-9]{64}$/.test(ticket.target) || ticket.source === ticket.target)
			throw new Error("Invalid update checkpoint runtime.");
		this.db.prepare("INSERT INTO update_checkpoint VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload")
			.run(JSON.stringify(ticket));
	}
	finishCheckpointActor(id: string, key: string, error?: string): void {
		const ticket = this.checkpoint(), actor = (ticket?.workers ?? ticket?.sessions)?.find(actor => actor.key === key);
		if (!ticket || ticket.id !== id || !["committed", "complete"].includes(ticket.state) || !actor) throw new Error("The restore checkpoint changed.");
		actor.restored = true;
		if (error) actor.error = error.slice(0, 2000);
		this.writeCheckpoint(ticket);
	}
	completeCheckpoint(id: string): void {
		const ticket = this.checkpoint();
		if (!ticket || ticket.id !== id || ticket.state !== "committed" || (ticket.workers ?? ticket.sessions).some(actor => !actor.restored))
			throw new Error("Conversation restoration is not complete.");
		ticket.state = "complete"; this.writeCheckpoint(ticket);
	}
	assertCheckpointInputs(): void {
		if (this.db.prepare("SELECT 1 FROM inputs WHERE state IN ('queued','sending') LIMIT 1").get())
			throw new Error("Wait for pending Desk input to reach Pi before updating.");
	}
	/** The continuation receipt and dispatch marker commit together; unknown admission is never replayed. */
	continueCheckpoint(id: string, key: string, input: InputSubmission): InputStatus | undefined {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const ticket = this.checkpoint(), actor = ticket?.sessions.find(actor => actor.key === key);
			if (!ticket || ticket.id !== id || ticket.state !== "committed" || !actor?.running)
				throw new Error("This conversation has no active-work continuation checkpoint.");
			let result: InputStatus | undefined;
			if (!actor.dispatched) {
				result = this.admit(key, input);
				actor.dispatched = true; actor.restored = true;
				this.writeCheckpoint(ticket);
			}
			this.db.exec("COMMIT"); return result;
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	private row(session: string, id: string): Row | undefined {
		return this.db.prepare("SELECT * FROM inputs WHERE session=? AND id=?").get(session, id) as unknown as Row | undefined;
	}
	existing(session: string, input: InputSubmission): InputStatus | undefined {
		const row = this.row(session, input.id);
		if (!row) return;
		if (row.fingerprint !== fingerprint(input)) throw new ReceiptConflict("This message receipt has different contents.");
		return status(row);
	}
	admit(session: string, input: InputSubmission): InputStatus {
		const previous = this.existing(session, input);
		if (previous) return previous;
		if (this.pending(session).length >= 16) throw new Error("Resolve or dismiss the pending messages before sending more (limit 16).");
		const now = Date.now();
		this.db.prepare(`INSERT INTO inputs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
			session, input.id, input.activation, input.generation ?? null, fingerprint(input),
			JSON.stringify(input.command), "queued", now, now, input.command.text.slice(0, 240),
			input.command.attachments?.length ?? 0, null);
		return status(this.row(session, input.id)!);
	}
	pending(session: string): InputStatus[] {
		return (this.db.prepare(`SELECT id,state,created,updated,preview,files,error FROM inputs WHERE session=? AND state IN ('queued','sending','failed','interrupted')
			AND payload IS NOT NULL ORDER BY created, rowid`).all(session) as unknown as Row[]).map(status);
	}
	files(session: string): Set<string> {
		const rows = this.db.prepare("SELECT payload FROM inputs WHERE session=? AND state IN ('queued','sending','failed','interrupted') AND payload IS NOT NULL")
			.all(session) as { payload: string }[];
		return new Set(rows.flatMap(row => (JSON.parse(row.payload) as PromptCommand).attachments ?? []));
	}
	next(session: string): { input: InputSubmission; status: InputStatus } | undefined {
		const row = this.db.prepare("SELECT * FROM inputs WHERE session=? AND state='queued' ORDER BY created, rowid LIMIT 1")
			.get(session) as unknown as Row | undefined;
		return row ? { status: status(row), input: {
			id: row.id, activation: row.activation, ...(row.generation ? { generation: row.generation } : {}),
			command: JSON.parse(row.payload!) as PromptCommand,
		} } : undefined;
	}
	read(session: string, id: string): { status: InputStatus; command?: PromptCommand } {
		const row = this.row(session, id);
		if (!row) throw new Error("Unknown message receipt.");
		return { status: status(row), ...(row.payload ? { command: JSON.parse(row.payload) as PromptCommand } : {}) };
	}
	settle(session: string, id: string, state: InputStatus["state"], error?: string): InputStatus {
		const retain = state === "queued" || state === "sending" || state === "failed" || state === "interrupted";
		this.db.prepare(`UPDATE inputs SET state=?, updated=?, error=?,
			payload=CASE WHEN ? THEN payload ELSE NULL END,
			preview=CASE WHEN ? THEN preview ELSE '' END WHERE session=? AND id=?`)
			.run(state, Date.now(), error?.slice(0, 2000) ?? null, Number(retain), Number(retain), session, id);
		return this.read(session, id).status;
	}
	cancel(session: string, id: string): InputStatus {
		const { status } = this.read(session, id);
		if (status.state === "cancelled") return status;
		if (status.state !== "queued") throw new ReceiptConflict("This message has already left the host queue. Check its status before taking another action.");
		return this.settle(session, id, "cancelled");
	}
	dismiss(session: string, id: string): void {
		const { status } = this.read(session, id);
		if (status.state === "queued" || status.state === "sending") throw new ReceiptConflict("Cancel a queued message or wait for its outcome first.");
		this.db.prepare("UPDATE inputs SET payload=NULL, preview='' WHERE session=? AND id=?").run(session, id);
	}
	interrupt(session: string | undefined, reason: string): void {
		const scope = session === undefined ? "" : " AND session=?";
		const args = session === undefined ? [] : [session];
		this.db.prepare(`UPDATE inputs SET state='failed', updated=?, error=? WHERE state='queued'${scope}`)
			.run(Date.now(), `${reason} before this message was dispatched. It was not retried.`, ...args);
		this.db.prepare(`UPDATE inputs SET state='interrupted', updated=?, error=? WHERE state='sending'${scope}`)
			.run(Date.now(), `${reason} before admission was confirmed. Check saved history; this message was not retried.`, ...args);
	}
	close(): void { this.db.close(); }
}

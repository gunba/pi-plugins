import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HomeMessage, HomeRun } from "../shared/home.ts";

/** Shared by the host and its Home worker: Home's messages, runs and delivery requests. */
export type HomeRequest = { action: "notify"; title: string; text: string };
export class HomeStore {
	private db: DatabaseSync;
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(directory, "home.sqlite"));
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS home_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS home_messages (id TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS home_requests (id TEXT PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL, result TEXT);`);
	}
	get<T>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM home_values WHERE key=?").get(key) as { value: string } | undefined;
		return row ? JSON.parse(row.value) : undefined;
	}
	set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO home_values VALUES (?,?)").run(key, JSON.stringify(value)); }
	message(message: HomeMessage): void { this.db.prepare("INSERT OR IGNORE INTO home_messages VALUES (?,?,?)").run(message.id, JSON.stringify(message), message.at); }
	messages(): HomeMessage[] { return (this.db.prepare("SELECT value FROM home_messages ORDER BY at DESC, rowid DESC LIMIT 80").all() as { value: string }[]).reverse().map(row => JSON.parse(row.value)); }
	run(run: HomeRun): void { this.set("run", run); }
	request(id: string, command: HomeRequest): void {
		const existing = this.db.prepare("SELECT command FROM home_requests WHERE id=?").get(id) as { command: string } | undefined;
		if (existing && existing.command !== JSON.stringify(command)) throw Error("Home request id already belongs to another command.");
		this.db.prepare("INSERT OR IGNORE INTO home_requests VALUES (?,?,'pending',NULL)").run(id, JSON.stringify(command));
	}
	pending(): { id: string; command: HomeRequest }[] {
		return (this.db.prepare("SELECT id, command FROM home_requests WHERE state='pending' ORDER BY rowid LIMIT 20").all() as { id: string; command: string }[])
			.map(row => ({ id: row.id, command: JSON.parse(row.command) }));
	}
	claim(id: string): boolean { return this.db.prepare("UPDATE home_requests SET state='applying' WHERE id=? AND state='pending'").run(id).changes === 1; }
	settle(id: string, result: unknown): void { this.db.prepare("UPDATE home_requests SET state='done', result=? WHERE id=?").run(JSON.stringify(result), id); }
	result(id: string): { value?: unknown; error?: string } | undefined {
		const row = this.db.prepare("SELECT result FROM home_requests WHERE id=?").get(id) as { result?: string } | undefined;
		return row?.result ? JSON.parse(row.result) : undefined;
	}
	recover(): void { this.db.prepare("UPDATE home_requests SET state='done', result=? WHERE state='applying'").run(JSON.stringify({ error: "Desk restarted during this delivery. Check Home before repeating it." })); }
	close(): void { this.db.close(); }
}

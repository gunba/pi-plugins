import { chmodSync } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readSessionMetadata } from "./session-metadata.ts";
import { SAVED_PAGE_SIZE, type SavedPage } from "../shared/catalog.ts";
import type { SavedSession } from "../shared/protocol.ts";

export class CatalogChanged extends Error {}
const lifetime = 30_000;

/** Rebuildable metadata only. Native JSONL remains authoritative. */
export class SavedSessionIndex {
	private db: DatabaseSync;
	private custom?: string;
	private root: string;
	private revision = randomUUID();
	private scanned = 0;
	private dirty = true;
	private warning?: string;
	private pending?: Promise<void>;
	private controller = new AbortController();
	private closed = false;
	private knownDirectories: () => string[];

	constructor(directory: string, cwd: string, agentDir: string, sessionDir?: string,
		knownDirectories: () => string[] = () => []) {
		this.knownDirectories = knownDirectories;
		const configured = sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? SettingsManager.create(cwd, agentDir).getSessionDir();
		this.custom = configured === "~" ? homedir() : configured ? resolve(configured.startsWith("~/") || configured.startsWith("~\\")
			? join(homedir(), configured.slice(2)) : configured) : undefined;
		this.root = join(agentDir, "sessions");
		const file = join(directory, "history.sqlite");
		this.db = new DatabaseSync(file);
		try {
			chmodSync(file, 0o600);
			if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) !== 1) {
				this.db.exec("DROP TABLE IF EXISTS saved; PRAGMA user_version=1;");
			}
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-2048;
				CREATE TABLE IF NOT EXISTS saved (
					file TEXT PRIMARY KEY, stamp TEXT NOT NULL, data TEXT NOT NULL,
					modified INTEGER NOT NULL, searchable TEXT NOT NULL, seen TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS saved_order ON saved(modified DESC, file);`);
		} catch (error) { this.db.close(); throw error; }
	}
	invalidate(): void { this.dirty = true; }

	private async *files(directory: string, visited: Set<string>): AsyncGenerator<string> {
		let entries;
		try {
			directory = await realpath(directory);
			if (visited.has(directory)) return;
			visited.add(directory); entries = await opendir(directory);
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		for await (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")) yield join(directory, entry.name);
		}
	}
	private async *discover(): AsyncGenerator<string> {
		const visited = new Set<string>();
		const extra = new Set(this.knownDirectories().map(directory => resolve(directory)));
		if (this.custom) { extra.delete(this.custom); yield* this.files(this.custom, visited); }
		else {
			let directories;
			try { directories = await opendir(this.root); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (directories) for await (const entry of directories) {
				if (entry.isDirectory() || entry.isSymbolicLink()) {
					const directory = join(this.root, entry.name);
					extra.delete(directory); yield* this.files(directory, visited);
				}
			}
		}
		for (const directory of extra) yield* this.files(directory, visited);
	}
	private async scan(): Promise<void> {
		this.dirty = false;
		const seen = randomUUID(), signal = this.controller.signal;
		const previous = this.db.prepare("SELECT stamp, data FROM saved WHERE file=?");
		const touch = this.db.prepare("UPDATE saved SET seen=? WHERE file=?");
		const save = this.db.prepare("INSERT OR REPLACE INTO saved VALUES(?,?,?,?,?,?)");
		let changed = false, errors = 0;
		let failure: unknown;
		const parallelism = availableParallelism();
		const pending = new Set<Promise<void>>();
		const inspect = async (file: string) => {
			signal.throwIfAborted();
			touch.run(seen, file);
			try {
				const info = await stat(file, { bigint: true });
				if (!info.isFile()) return;
				const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
				const old = previous.get(file) as { stamp: string; data: string } | undefined;
				if (old?.stamp === stamp) return;
				const item = await readSessionMetadata(file, Number(info.mtimeMs), signal);
				if (!item) { errors++; return; }
				const data = JSON.stringify(item);
				if (data !== old?.data) changed = true;
				save.run(file, stamp, data, Date.parse(item.modified),
					`${item.name ?? ""}\n${item.firstMessage}\n${item.cwd}\n${file}`.toLowerCase(), seen);
			} catch { signal.throwIfAborted(); errors++; }
		};
		this.db.exec("BEGIN");
		try {
			for await (const file of this.discover()) {
				signal.throwIfAborted();
				const job = inspect(file).catch(error => { failure = error; }).finally(() => pending.delete(job));
				pending.add(job);
				if (pending.size >= parallelism) await Promise.race(pending);
			}
			await Promise.all(pending);
			if (failure) throw failure;
			signal.throwIfAborted();
			changed ||= Number(this.db.prepare("SELECT COUNT(*) AS count FROM saved WHERE seen<>?").get(seen)!.count) > 0;
			this.db.prepare("DELETE FROM saved WHERE seen<>?").run(seen);
			this.db.exec("COMMIT");
			if (changed) this.revision = randomUUID();
			this.warning = errors ? `${errors} session file${errors === 1 ? "" : "s"} could not be indexed. Existing previews were kept.` : undefined;
		} catch (error) {
			await Promise.allSettled(pending);
			this.db.exec("ROLLBACK");
			if (!this.closed) this.warning = `Could not refresh saved sessions: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.scanned = Date.now();
	}
	async page({ query = "", offset = 0, revision, refresh = false }: {
		query?: string; offset?: number; revision?: string; refresh?: boolean;
	} = {}): Promise<SavedPage> {
		if (this.closed) throw new Error("The session index is closed.");
		if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 200) throw new Error("Invalid catalog position or query.");
		if (!this.pending && (refresh || revision === undefined && (this.dirty || Date.now() - this.scanned > lifetime))) {
			this.pending = this.scan().finally(() => { this.pending = undefined; });
		}
		await this.pending;
		if (this.closed) throw new Error("The session index is closed.");
		if (revision !== undefined && revision !== this.revision) throw new CatalogChanged("Saved sessions changed. Refresh this list.");
		const search = query.trim().toLowerCase();
		const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM saved").get()!.count);
		const matched = Number(this.db.prepare("SELECT COUNT(*) AS count FROM saved WHERE instr(searchable,?)>0").get(search)!.count);
		const rows = this.db.prepare("SELECT data FROM saved WHERE instr(searchable,?)>0 ORDER BY modified DESC,file LIMIT ? OFFSET ?")
			.all(search, SAVED_PAGE_SIZE, offset) as { data: string }[];
		const sessions: SavedSession[] = [];
		let characters = 0;
		for (const row of rows) {
			if (sessions.length && characters + row.data.length > 128_000) break;
			characters += row.data.length; sessions.push(JSON.parse(row.data));
		}
		return { sessions, total, matched, offset, revision: this.revision, scanned: this.scanned, warning: this.warning,
			...(offset + sessions.length < matched ? { next: offset + sessions.length } : {}) };
	}
	async close(): Promise<void> {
		this.closed = true; this.controller.abort();
		await this.pending; this.db.close();
	}
}

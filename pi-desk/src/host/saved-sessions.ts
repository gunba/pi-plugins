import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { SAVED_PAGE_SIZE, type CatalogProgress, type SavedPage } from "../shared/catalog.ts";
import type { SavedSession } from "../shared/protocol.ts";
import type { RecentProject } from "../shared/folders.ts";

export class CatalogChanged extends Error {}
interface View {
	scope: string; cwd?: string; revision: string; scanned: number; dirty: boolean;
	progress: CatalogProgress; warning?: string; worker?: Worker; accessed: number; readers: Map<string, number>;
}
interface Update { type: "progress" | "done" | "failed"; loaded?: number; total?: number; items?: SavedSession[]; error?: string }
const lifetime = 30_000;

/** Native Pi listing runs off the host event loop. Only rebuildable previews persist here. */
export class SavedSessionIndex {
	private db: DatabaseSync;
	private views = new Map<string, View>();
	private closed = false;
	private endings = new Set<Promise<number>>();
	private cwd: string;
	private agentDir: string;
	private sessionDir?: string;
	private knownDirectories: () => string[];
	constructor(directory: string, cwd: string, agentDir: string, sessionDir?: string,
		knownDirectories: () => string[] = () => []) {
		this.cwd = cwd; this.agentDir = agentDir; this.sessionDir = sessionDir; this.knownDirectories = knownDirectories;
		const file = join(directory, "history.sqlite");
		this.db = new DatabaseSync(file);
		try {
			chmodSync(file, 0o600);
			if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) !== 2) {
				this.db.exec("DROP TABLE IF EXISTS saved; PRAGMA user_version=2;");
			}
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-2048;
				CREATE TABLE IF NOT EXISTS saved (
					scope TEXT NOT NULL, file TEXT NOT NULL, data TEXT NOT NULL,
					modified INTEGER NOT NULL, searchable TEXT NOT NULL, seen TEXT NOT NULL,
					PRIMARY KEY(scope,file));
				CREATE INDEX IF NOT EXISTS saved_order ON saved(scope,modified DESC,file);`);
		} catch (error) { this.db.close(); throw error; }
	}
	invalidate(): void { for (const view of this.views.values()) view.dirty = true; }
	recentProjects(): RecentProject[] {
		return this.db.prepare(`SELECT json_extract(data,'$.cwd') AS path, MAX(modified) AS modified
			FROM saved GROUP BY path ORDER BY modified DESC LIMIT 64`).all() as unknown as RecentProject[];
	}
	private view(cwd?: string): View {
		const scope = cwd === undefined ? "*" : resolve(cwd);
		let view = this.views.get(scope);
		if (!view) {
			if (this.views.size >= 16) {
				const oldest = [...this.views.values()].filter(v => !v.worker && v.progress.state !== "queued")
					.sort((a, b) => a.accessed - b.accessed)[0];
				if (!oldest) throw new Error("Too many session catalogues are being read.");
				this.views.delete(oldest.scope);
			}
			view = { scope, cwd: cwd === undefined ? undefined : scope, revision: randomUUID(), scanned: 0,
				dirty: true, accessed: Date.now(), readers: new Map(), progress: { id: randomUUID(), state: "ready", loaded: 0, total: 0 } };
			this.views.set(scope, view);
		}
		view.accessed = Date.now(); return view;
	}
	private terminate(view: View): void {
		const worker = view.worker; view.worker = undefined;
		if (!worker) return;
		const ending = worker.terminate().finally(() => { this.endings.delete(ending); this.startQueued(); });
		this.endings.add(ending);
	}
	private startQueued(): void {
		if (this.closed) return;
		for (const view of this.views.values()) {
			if ([...this.views.values()].filter(v => v.worker).length + this.endings.size >= 2) break;
			if (view.progress.state !== "queued") continue;
			const built = new URL("./catalog-worker.js", import.meta.url);
			const worker = new Worker(existsSync(built) ? built : new URL("./catalog-worker.ts", import.meta.url), {
				workerData: { cwd: view.cwd, baseCwd: this.cwd, agentDir: this.agentDir,
					sessionDir: this.sessionDir, directories: this.knownDirectories() },
				env: { ...process.env, PI_CODING_AGENT_DIR: this.agentDir },
				resourceLimits: { maxOldGenerationSizeMb: 512 },
			});
			const id = view.progress.id;
			view.worker = worker; view.progress.state = "loading";
			const current = () => !this.closed && view.worker === worker && view.progress.id === id;
			worker.on("message", (update: Update) => {
				if (!current()) return;
				try {
					if (update.type === "progress") {
						view.progress.loaded = update.loaded!; view.progress.total = update.total!;
						if (!update.items?.length) return;
						const save = this.db.prepare("INSERT OR REPLACE INTO saved VALUES(?,?,?,?,?,?)");
						this.db.exec("BEGIN");
						try {
							for (const item of update.items) save.run(view.scope, item.file, JSON.stringify(item),
								Date.parse(item.modified), `${item.name ?? ""}\n${item.firstMessage}\n${item.cwd}`.toLowerCase(), id);
							this.db.exec("COMMIT");
						} catch (error) { this.db.exec("ROLLBACK"); throw error; }
						view.revision = randomUUID();
					} else if (update.type === "done") {
						this.finish(view, id);
					} else this.fail(view, id, update.error ?? "Pi could not list sessions.");
				} catch (error) { this.fail(view, id, String(error)); }
			});
			worker.on("error", error => {
				if (current()) this.fail(view, id, error.message.includes("memory")
					? "Pi's session listing exceeded its memory budget. Narrow the project selection." : error.message);
			});
			worker.on("exit", code => {
				if (current() && code !== 0) this.fail(view, id, "Pi's session listing stopped unexpectedly.");
			});
		}
	}
	private finish(view: View, id: string): void {
		// The completed native listing defines scope membership, including changed headers.
		const removed = this.db.prepare("DELETE FROM saved WHERE scope=? AND seen<>?").run(view.scope, id);
		if (removed.changes) view.revision = randomUUID();
		view.progress.state = "ready"; view.scanned = Date.now(); view.readers.clear();
		this.terminate(view); this.startQueued();
	}
	private fail(view: View, id: string, warning: string): void {
		if (this.closed || view.progress.id !== id) return;
		view.warning = warning; view.progress.state = "error"; view.scanned = Date.now(); view.readers.clear();
		this.terminate(view); this.startQueued();
	}
	cancel(id: string, reader = "default"): void {
		for (const view of this.views.values()) {
			if (view.progress.id !== id) continue;
			view.readers.delete(reader);
			for (const [key, seen] of view.readers) if (Date.now() - seen > 10_000) view.readers.delete(key);
			if (view.readers.size || !["loading", "queued"].includes(view.progress.state)) continue;
			view.progress.state = "cancelled"; view.scanned = Date.now();
			this.terminate(view);
		}
		this.startQueued();
	}
	async page({ query = "", offset = 0, revision, refresh = false, cwd, scan, named = false, reader = "default" }: {
		query?: string; offset?: number; revision?: string; refresh?: boolean; cwd?: string; scan?: string; named?: boolean; reader?: string;
	} = {}): Promise<SavedPage> {
		if (this.closed) throw new Error("The session index is closed.");
		if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 200
			|| reader.length > 100 || cwd !== undefined && (!isAbsolute(cwd) || cwd.length > 32768)) throw new Error("Invalid catalogue query.");
		const view = this.view(cwd);
		if (scan && scan !== view.progress.id) throw new CatalogChanged("This session listing was replaced. Reopen the picker.");
		if (refresh || !scan && !revision && view.progress.state !== "loading" && view.progress.state !== "queued"
			&& (view.dirty || ["error", "cancelled"].includes(view.progress.state) || Date.now() - view.scanned > lifetime)) {
			this.terminate(view); view.dirty = false; view.warning = undefined;
			view.readers.clear();
			view.progress = { id: randomUUID(), state: "queued", loaded: 0, total: 0 };
			this.startQueued();
		}
		if (["loading", "queued"].includes(view.progress.state)) view.readers.set(reader, Date.now());
		if (revision !== undefined && revision !== view.revision) throw new CatalogChanged("Saved sessions changed. Refresh this list.");
		const search = query.trim().toLowerCase(), filter = "scope=? AND instr(searchable,?)>0 AND (?=0 OR COALESCE(json_extract(data,'$.name'),'')<>'')";
		const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM saved WHERE scope=?").get(view.scope)!.count);
		const matched = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM saved WHERE ${filter}`).get(view.scope, search, Number(named))!.count);
		const rows = this.db.prepare(`SELECT data FROM saved WHERE ${filter} ORDER BY modified DESC,file LIMIT ? OFFSET ?`)
			.all(view.scope, search, Number(named), SAVED_PAGE_SIZE, offset) as { data: string }[];
		const sessions: SavedSession[] = [];
		let characters = 0;
		for (const row of rows) {
			if (sessions.length && characters + row.data.length > 128_000) break;
			characters += row.data.length; sessions.push(JSON.parse(row.data));
		}
		return { sessions, total, matched, offset, revision: view.revision, scanned: view.scanned, warning: view.warning,
			progress: { ...view.progress }, ...(offset + sessions.length < matched ? { next: offset + sessions.length } : {}) };
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const view of this.views.values()) this.terminate(view);
		await Promise.allSettled([...this.endings]); this.db.close();
	}
}

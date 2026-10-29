import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { SEARCH_ORIGIN, type SearchCoverage, type SearchFilters, type SearchHit, type SearchPassage, type SearchRequest, type SearchResponse, type SearchSource } from "../shared/conversation-search.ts";
import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_MODEL } from "./search-embedder.ts";

export const LOCAL_SEARCH_SCOPE = "local";
const LOCAL = "local";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type SourceRow = SearchSource & { scope: string; computer: string; root: string | null; expires: number | null; warning: string | null };
type PassageRow = { ref: string; scope: string; computer: string; source: string; seq: number; entry: string; parent: string | null; ordinal: number;
	start: number; role: SearchPassage["role"]; tool: string | null; at: number | null; chunk: number; text: string; hash: string };
export interface SearchFileState { file: string; id: string; stamp: string; offset: number; ordinal: number; anchor: string; seen: string }
export interface IndexedEntry { id: string; parent?: string; ordinal: number; passages: Omit<SearchPassage, "sequence" | "entry" | "parent" | "ordinal">[] }
export interface QueryScope { remote?: string; local: boolean; localComputer?: string }

/** One search worker owns this connection. Transactions never suspend or invoke callbacks. */
export class SearchStore {
	private readonly db: DatabaseSync;
	private statements = new Map<string, StatementSync>();
	private vectors = new Map<number, Float32Array>();
	readonly epoch: string;
	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(file);
		try {
			chmodSync(file, 0o600);
			this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
				PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
				CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS files (file TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, stamp TEXT NOT NULL,
					offset INTEGER NOT NULL, ordinal INTEGER NOT NULL, anchor TEXT NOT NULL, seen TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS links (source TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, entry TEXT NOT NULL, nearest TEXT,
					PRIMARY KEY(source,entry));
				CREATE TABLE IF NOT EXISTS sources (scope TEXT NOT NULL, computer TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
					root TEXT, project TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, generation TEXT NOT NULL,
					version INTEGER NOT NULL, cursor INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER, complete INTEGER NOT NULL, warning TEXT,
					PRIMARY KEY(scope,computer,id));
				CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, text TEXT NOT NULL, vector BLOB, model TEXT);
				CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61');
				CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,text) VALUES(new.id,new.text); END;
				CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.id,old.text); END;
				CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, computer TEXT NOT NULL, source TEXT NOT NULL,
					seq INTEGER NOT NULL, ref TEXT NOT NULL, entry TEXT NOT NULL, parent TEXT, ordinal INTEGER NOT NULL, start INTEGER NOT NULL,
					role TEXT NOT NULL, tool TEXT, at INTEGER, chunk INTEGER NOT NULL REFERENCES chunks(id),
					FOREIGN KEY(scope,computer,source) REFERENCES sources(scope,computer,id) ON DELETE CASCADE,
					UNIQUE(scope,computer,source,seq));
				CREATE INDEX IF NOT EXISTS passages_ref ON passages(ref);
				CREATE INDEX IF NOT EXISTS passages_chunk ON passages(chunk);
				CREATE INDEX IF NOT EXISTS passages_entry ON passages(scope,computer,source,entry,start);
				CREATE INDEX IF NOT EXISTS passages_parent ON passages(scope,computer,source,parent);
				CREATE INDEX IF NOT EXISTS passages_time ON passages(at);
				CREATE INDEX IF NOT EXISTS passages_natural ON passages(scope,computer,source,chunk) WHERE role<>'tool';
				CREATE INDEX IF NOT EXISTS chunks_embedded ON chunks(model) WHERE vector IS NOT NULL;
				CREATE TABLE IF NOT EXISTS embed_queue (chunk INTEGER PRIMARY KEY);
				CREATE TABLE IF NOT EXISTS inventories (scope TEXT NOT NULL, computer TEXT NOT NULL, epoch TEXT NOT NULL, snapshot TEXT NOT NULL,
					scanned INTEGER NOT NULL, PRIMARY KEY(scope,computer));
				CREATE TABLE IF NOT EXISTS inventory_sources (scope TEXT NOT NULL, computer TEXT NOT NULL, source TEXT NOT NULL,
					PRIMARY KEY(scope,computer,source), FOREIGN KEY(scope,computer) REFERENCES inventories(scope,computer) ON DELETE CASCADE);`);
			this.epoch = this.get("epoch") ?? randomUUID(); this.set("epoch", this.epoch);
			// Conversation chunks that lack this model's embedding. Finding them in chunks read the whole table (most
			// chunks are tool output, never embedded) each time anything changed; an index made before the queue, or for
			// another model, fills it once.
			if (this.get("embed_queue") !== SEARCH_EMBEDDING_MODEL) this.transaction(() => {
				this.db.exec("DELETE FROM embed_queue");
				this.sql(`INSERT OR IGNORE INTO embed_queue SELECT DISTINCT p.chunk FROM passages p INDEXED BY passages_natural JOIN chunks c ON c.id=p.chunk
					WHERE p.role<>'tool' AND (c.vector IS NULL OR c.model<>?)`).run(SEARCH_EMBEDDING_MODEL);
				this.set("embed_queue", SEARCH_EMBEDDING_MODEL);
			});
		} catch (error) { this.db.close(); throw error; }
	}
	private sql(text: string): StatementSync {
		let statement = this.statements.get(text);
		if (!statement) { if (this.statements.size >= 256) this.statements.clear(); this.statements.set(text, statement = this.db.prepare(text)); }
		return statement;
	}
	private transaction<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = run(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	get(key: string): string | undefined { return (this.sql("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)?.value; }
	set(key: string, value: string): void { this.sql("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(key, value); }
	private nextVersion(): number { const value = Number(this.get("version") ?? 0) + 1; this.set("version", String(value)); return value; }
	file(path: string): SearchFileState | undefined { return this.sql("SELECT * FROM files WHERE file=?").get(path) as unknown as SearchFileState | undefined; }
	files(): SearchFileState[] { return this.sql("SELECT * FROM files").all() as unknown as SearchFileState[]; }
	source(scope: string, computer: string, id: string): SearchSource | undefined {
		const row = this.sql("SELECT * FROM sources WHERE scope=? AND computer=? AND id=?").get(scope, computer, id) as unknown as SourceRow | undefined;
		return row && this.sourceValue(row);
	}
	private sourceValue(row: SourceRow): SearchSource {
		return { id: row.id, session: row.session, ...(row.root ? { root: row.root } : {}), project: row.project, title: row.title, kind: row.kind,
			generation: row.generation, version: row.version, cursor: row.cursor, updated: row.updated, complete: !!row.complete,
			...(row.expires === null ? {} : { expires: row.expires }), ...(row.warning ? { warning: row.warning } : {}) };
	}
	localSources(): SearchSource[] { return (this.sql("SELECT * FROM sources WHERE scope=? AND computer=? AND (expires IS NULL OR expires>?) ORDER BY id").all(LOCAL, LOCAL, Date.now()) as unknown as SourceRow[]).map(row => this.sourceValue(row)); }
	private saveSource(scope: string, computer: string, source: SearchSource): void {
		this.sql(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,computer,id) DO UPDATE SET
			session=excluded.session,root=excluded.root,project=excluded.project,title=excluded.title,kind=excluded.kind,generation=excluded.generation,
			version=excluded.version,cursor=excluded.cursor,updated=excluded.updated,expires=excluded.expires,complete=excluded.complete,warning=excluded.warning`)
			.run(scope, computer, source.id, source.session, source.root ?? null, source.project, source.title, source.kind, source.generation,
				source.version, source.cursor, source.updated, source.expires ?? null, Number(source.complete), source.warning ?? null);
	}
	/** Register an append-only source or discard its old generation after a rewrite. No old passage survives a reset. */
	registerFile(state: SearchFileState, metadata: Omit<SearchSource, "generation" | "version" | "cursor" | "complete">, reset: boolean): SearchSource {
		let discarded = false;
		const source = this.transaction(() => {
			const previous = this.source(LOCAL, LOCAL, state.id); discarded = reset && !!previous;
			if (reset) {
				this.sql("DELETE FROM sources WHERE scope=? AND computer=? AND id=?").run(LOCAL, LOCAL, state.id);
				this.sql("DELETE FROM links WHERE source=?").run(state.id);
			}
			this.sql(`INSERT INTO files VALUES(?,?,?,?,?,?,?) ON CONFLICT(file) DO UPDATE SET
				stamp=excluded.stamp,offset=excluded.offset,ordinal=excluded.ordinal,anchor=excluded.anchor,seen=excluded.seen`)
				.run(state.file, state.id, state.stamp, state.offset, state.ordinal, state.anchor, state.seen);
			const next: SearchSource = { ...metadata, generation: !reset && previous ? previous.generation : randomUUID(),
				version: this.nextVersion(), cursor: !reset && previous ? previous.cursor : 0, complete: false };
			this.saveSource(LOCAL, LOCAL, next); return next;
		});
		if (discarded) this.collect();
		return source;
	}
	seenFile(file: string, scan: string): void { this.sql("UPDATE files SET seen=? WHERE file=?").run(scan, file); }
	/** Drop only files the caller proved missing or excluded, never an inaccessible inventory root. */
	removeFiles(ids: readonly string[]): void {
		if (!ids.length) return;
		this.transaction(() => {
			for (const id of ids) {
				this.sql("DELETE FROM sources WHERE scope=? AND computer=? AND id=?").run(LOCAL, LOCAL, id);
				this.sql("DELETE FROM files WHERE id=?").run(id);
			}
			this.nextVersion();
		});
		this.collect();
	}
	private insert(scope: string, computer: string, source: SearchSource, passage: SearchPassage): void {
		const hash = digest(passage.text);
		this.sql("INSERT OR IGNORE INTO chunks(hash,text) VALUES(?,?)").run(hash, passage.text);
		const chunk = Number(this.sql("SELECT id FROM chunks WHERE hash=?").get(hash)!.id);
		// References identify retained native evidence, not a physical path; moves and retained copies must not break them.
		const reference = digest([source.session, passage.entry, passage.role, passage.at ?? "", passage.start, hash].join("\0"));
		this.sql("INSERT INTO passages(scope,computer,source,seq,ref,entry,parent,ordinal,start,role,tool,at,chunk) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
			.run(scope, computer, source.id, passage.sequence, reference, passage.entry, passage.parent ?? null, passage.ordinal, passage.start,
				passage.role, passage.tool ?? null, passage.at ?? null, chunk);
		if (passage.role !== "tool") this.sql("INSERT OR IGNORE INTO embed_queue SELECT id FROM chunks WHERE id=? AND (vector IS NULL OR model<>?)").run(chunk, SEARCH_EMBEDDING_MODEL);
	}
	/** Atomically persist new complete entries, their searchable ancestry, and the byte cursor that acknowledges them. */
	append(file: SearchFileState, generation: string, entries: IndexedEntry[], update: { title?: string; root?: string; kind?: SearchSource["kind"]; complete: boolean; warning?: string }): SearchSource {
		return this.transaction(() => {
			const source = this.source(LOCAL, LOCAL, file.id);
			if (!source || source.generation !== generation || !this.file(file.file)) throw Error("The indexed source was replaced.");
			for (const entry of entries) {
				const linked = entry.parent ? this.sql("SELECT nearest FROM links WHERE source=? AND entry=?").get(file.id, entry.parent) as { nearest?: string } | undefined : undefined;
				const parent = linked?.nearest;
				for (const passage of entry.passages) this.insert(LOCAL, LOCAL, source, { ...passage, sequence: ++source.cursor,
					entry: entry.id, ...(parent ? { parent } : {}), ordinal: entry.ordinal });
				this.sql("INSERT OR REPLACE INTO links VALUES(?,?,?)").run(file.id, entry.id, entry.passages.length ? entry.id : parent ?? null);
			}
			if (update.title !== undefined) source.title = update.title.slice(0, 300);
			if (update.root !== undefined) source.root = update.root;
			if (update.kind !== undefined) source.kind = update.kind;
			source.complete = update.complete; source.warning = update.warning; source.version = this.nextVersion();
			this.saveSource(LOCAL, LOCAL, source);
			this.sql("UPDATE files SET stamp=?,offset=?,ordinal=?,anchor=?,seen=? WHERE id=?")
				.run(file.stamp, file.offset, file.ordinal, file.anchor, file.seen, file.id);
			return source;
		});
	}
	setSourceWarning(id: string, warning: string): void {
		this.transaction(() => {
			const source = this.source(LOCAL, LOCAL, id); if (!source) return;
			source.warning = warning.slice(0, 500); source.complete = false; source.version = this.nextVersion(); this.saveSource(LOCAL, LOCAL, source);
		});
	}
	/** A completed authoritative inventory removes absent sources; disconnects do not call this method. */
	inventory(scope: string, computer: string, epoch: string, snapshot: string, ids: readonly string[], scanned: number): void {
		this.transaction(() => {
			const previous = this.sql("SELECT epoch FROM inventories WHERE scope=? AND computer=?").get(scope, computer) as { epoch: string } | undefined;
			if (previous && previous.epoch !== epoch) this.sql("DELETE FROM sources WHERE scope=? AND computer=?").run(scope, computer);
			this.sql("INSERT INTO inventories VALUES(?,?,?,?,?) ON CONFLICT(scope,computer) DO UPDATE SET epoch=excluded.epoch,snapshot=excluded.snapshot,scanned=excluded.scanned")
				.run(scope, computer, epoch, snapshot, scanned);
			this.sql("DELETE FROM inventory_sources WHERE scope=? AND computer=?").run(scope, computer);
			for (const id of ids) this.sql("INSERT INTO inventory_sources VALUES(?,?,?)").run(scope, computer, id);
			this.sql("DELETE FROM sources WHERE scope=? AND computer=? AND NOT EXISTS(SELECT 1 FROM inventory_sources i WHERE i.scope=sources.scope AND i.computer=sources.computer AND i.source=sources.id)").run(scope, computer);
		});
		this.collect();
	}
	/** Admit metadata only for an inventory member. Returns the stored passage cursor, or undefined for a stale offer. */
	offer(scope: string, computer: string, source: SearchSource): number | undefined {
		if (!this.sql("SELECT 1 FROM inventory_sources WHERE scope=? AND computer=? AND source=?").get(scope, computer, source.id)) return;
		const previous = this.source(scope, computer, source.id);
		if (previous && source.version < previous.version) return;
		if (source.expires !== undefined && source.expires <= Date.now()) {
			this.saveSource(scope, computer, { ...source, cursor: 0, complete: true }); this.expire(); return;
		}
		const reset = !!previous && previous.generation !== source.generation;
		const cursor = !reset && previous ? previous.cursor : 0;
		if (cursor > source.cursor) throw Error("The remote source cursor moved backwards without a new generation.");
		this.transaction(() => {
			if (reset) this.sql("DELETE FROM sources WHERE scope=? AND computer=? AND id=?").run(scope, computer, source.id);
			this.saveSource(scope, computer, { ...source, cursor, complete: source.complete && cursor === source.cursor });
		});
		if (reset) this.collect();
		return cursor;
	}
	/** Import one contiguous requested range; a duplicate acknowledged range is harmless. */
	import(scope: string, computer: string, metadata: SearchSource, after: number, rows: readonly SearchPassage[]): number {
		return this.transaction(() => {
			const source = this.source(scope, computer, metadata.id);
			if (!source || source.generation !== metadata.generation || source.expires !== undefined && source.expires <= Date.now()
				|| !this.sql("SELECT 1 FROM inventory_sources WHERE scope=? AND computer=? AND source=?").get(scope, computer, source.id))
				throw Error("The remote source is no longer retained.");
			if (after !== source.cursor) { if (after + rows.length <= source.cursor) return source.cursor; throw Error("The search range does not continue its source."); }
			for (const row of rows) {
				if (row.sequence !== source.cursor + 1 || row.sequence > metadata.cursor) throw Error("The search range is not contiguous.");
				this.insert(scope, computer, source, row); source.cursor++;
			}
			source.complete = metadata.complete && source.cursor === metadata.cursor && source.version === metadata.version;
			this.saveSource(scope, computer, source); return source.cursor;
		});
	}
	export(id: string, generation: string, after: number, through: number, maximum: number, bytes: number): SearchPassage[] {
		const source = this.source(LOCAL, LOCAL, id);
		if (!source || source.generation !== generation || through > source.cursor || after > through) throw Error("The requested source was replaced or removed.");
		const result: SearchPassage[] = []; let size = 0;
		const rows = this.sql(`SELECT p.*,c.text FROM passages p JOIN chunks c ON c.id=p.chunk
			WHERE p.scope=? AND p.computer=? AND p.source=? AND p.seq>? AND p.seq<=? ORDER BY p.seq LIMIT ?`).all(LOCAL, LOCAL, id, after, through, maximum) as unknown as PassageRow[];
		for (const row of rows) {
			const passage: SearchPassage = { sequence: row.seq, entry: row.entry, ...(row.parent ? { parent: row.parent } : {}), ordinal: row.ordinal,
				start: row.start, role: row.role, ...(row.tool ? { tool: row.tool } : {}), ...(row.at === null ? {} : { at: row.at }), text: row.text };
			const next = Buffer.byteLength(JSON.stringify(passage));
			if (size + next > bytes) break;
			result.push(passage); size += next;
		}
		return result;
	}
	private scopeWhere(scope: QueryScope, alias = "s"): { sql: string; parameters: SQLInputValue[] } {
		const parts: string[] = [], parameters: SQLInputValue[] = [];
		if (scope.local) { parts.push(`(${alias}.scope=? AND ${alias}.computer=?)`); parameters.push(LOCAL, LOCAL); }
		if (scope.remote) { parts.push(`${alias}.scope=?`); parameters.push(scope.remote); }
		return { sql: `(${parts.join(" OR ") || "0"}) AND (${alias}.expires IS NULL OR ${alias}.expires>?)`, parameters: [...parameters, Date.now()] };
	}
	private filter(scope: QueryScope, filters?: SearchFilters, role?: "conversation" | "tool") {
		const where = this.scopeWhere(scope), parts = [where.sql], parameters = where.parameters;
		if (filters) {
			for (const [column, value] of [["project", filters.project], ["title", filters.agent]] as const) if (value) { parts.push(`instr(lower(s.${column}),lower(?))>0`); parameters.push(value); }
			if (filters.session) { parts.push("s.session=?"); parameters.push(filters.session); }
			if (filters.after !== undefined) { parts.push("p.at>=?"); parameters.push(filters.after); }
			if (filters.before !== undefined) { parts.push("p.at<?"); parameters.push(filters.before); }
			if (!filters.include_tools) parts.push("p.role<>'tool'");
			if (filters.exclude) { parts.push("NOT(s.session=? AND p.entry=?)"); parameters.push(filters.exclude.session, filters.exclude.entry); }
		}
		if (role) parts.push(role === "tool" ? "p.role='tool'" : "p.role<>'tool'");
		return { sql: parts.join(" AND "), parameters };
	}
	private join = "FROM passages p JOIN chunks c ON c.id=p.chunk JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source";
	/** Materialize eligibility once; correlated lookups can rescan an entire source for every chunk. */
	private eligible(where: string): string {
		return `SELECT p.chunk FROM passages p JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source WHERE ${where}`;
	}
	private collect(): void {
		const removed = this.sql("SELECT id FROM chunks c WHERE NOT EXISTS(SELECT 1 FROM passages p WHERE p.chunk=c.id)").all() as { id: number }[];
		this.transaction(() => { for (const { id } of removed) { this.sql("DELETE FROM chunks WHERE id=?").run(id); this.sql("DELETE FROM embed_queue WHERE chunk=?").run(id); } });
		for (const { id } of removed) this.vectors.delete(id);
		this.db.exec("PRAGMA incremental_vacuum(4096)");
	}
	/** Enforce known expiries offline. Empty source metadata prevents expired inventory members appearing as unfinished imports. */
	expire(now = Date.now()): void {
		// One source at a time through passages_entry: a single DELETE over every passage read the whole table each minute.
		const removed = this.transaction(() => {
			let changes = 0;
			for (const source of this.sql("SELECT scope,computer,id FROM sources WHERE expires IS NOT NULL AND expires<=?").all(now) as { scope: string; computer: string; id: string }[])
				changes += Number(this.sql("DELETE FROM passages WHERE scope=? AND computer=? AND source=?").run(source.scope, source.computer, source.id).changes);
			this.sql("UPDATE sources SET cursor=0,complete=1 WHERE expires IS NOT NULL AND expires<=? AND (cursor<>0 OR complete=0)").run(now);
			return changes;
		});
		if (removed) this.collect();
	}
	maintenance(): void { this.expire(); this.db.exec("PRAGMA incremental_vacuum(4096); PRAGMA wal_checkpoint(PASSIVE)"); }
	private cache(id: number, vector: Float32Array): void {
		if (!this.vectors.has(id) && this.vectors.size >= 65_536) this.vectors.delete(this.vectors.keys().next().value!);
		this.vectors.set(id, vector);
	}
	hasSemanticText(scope: QueryScope): boolean {
		const where = this.filter(scope, undefined, "conversation");
		return !!this.sql(`SELECT 1 ${this.join} WHERE ${where.sql} LIMIT 1`).get(...where.parameters);
	}
	pending(scope: QueryScope, limit = 8): { id: number; hash: string; text: string }[] {
		const where = this.filter(scope, undefined, "conversation");
		// Blank text (a passage cut at a NUL, say) cannot be embedded, and one in a batch failed the whole batch every time.
		return this.sql(`SELECT c.id,c.hash,c.text FROM embed_queue q JOIN chunks c ON c.id=q.chunk WHERE (c.vector IS NULL OR c.model<>?) AND trim(c.text)<>''
			AND EXISTS(SELECT 1 FROM passages p INDEXED BY passages_chunk JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source
			WHERE p.chunk=q.chunk AND ${where.sql}) ORDER BY q.chunk DESC LIMIT ?`)
			.all(SEARCH_EMBEDDING_MODEL, ...where.parameters, limit) as unknown as { id: number; hash: string; text: string }[];
	}
	/** SQLite can reuse a deleted row ID; completion must still identify the exact text that was embedded. */
	putVectors(rows: readonly { id: number; hash: string; vector: Float32Array }[]): void {
		this.transaction(() => {
			for (const { id, hash, vector } of rows) {
				if (vector.length !== SEARCH_EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) throw Error("Invalid conversation embedding.");
				const saved = this.sql(`UPDATE chunks SET vector=?,model=? WHERE id=? AND hash=? AND EXISTS(SELECT 1 FROM passages p JOIN sources s
					ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source WHERE p.chunk=chunks.id AND (s.expires IS NULL OR s.expires>?))`)
					.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), SEARCH_EMBEDDING_MODEL, id, hash, Date.now());
				if (saved.changes) { this.cache(id, vector); this.sql("DELETE FROM embed_queue WHERE chunk=?").run(id); }
			}
		});
	}
	/** The oldest completed scan among the computers in scope; undefined before any. */
	lastScan(scope: QueryScope): number | undefined {
		const scanned = [scope.local ? Number(this.get("scanned") ?? 0) : 0, scope.remote ? Number(this.sql("SELECT min(scanned) AS scanned FROM inventories WHERE scope=?").get(scope.remote)?.scanned ?? 0) : 0].filter(Boolean);
		return scanned.length ? Math.min(...scanned) : undefined;
	}
	coverage(scope: QueryScope, semantic: SearchCoverage["semantic"], error?: string): SearchCoverage {
		const where = this.scopeWhere(scope), filter = this.filter(scope, undefined, "conversation");
		const sources = this.sql(`SELECT count(*) AS sources,coalesce(sum(cursor),0) AS passages,coalesce(sum(complete=0),0) AS pending_sources,
			coalesce(sum(warning IS NOT NULL),0) AS warnings FROM sources s WHERE ${where.sql}`).get(...where.parameters)!;
		const vectors = this.sql(`SELECT count(DISTINCT CASE WHEN trim(c.text)<>'' THEN c.id END) AS semantic_passages,count(DISTINCT CASE WHEN c.model=? AND c.vector IS NOT NULL THEN c.id END) AS embedded_passages
			${this.join} WHERE ${filter.sql}`).get(SEARCH_EMBEDDING_MODEL, ...filter.parameters)!;
		const missing = scope.remote ? Number(this.sql(`SELECT count(*) AS count FROM inventory_sources i WHERE i.scope=? AND NOT EXISTS
			(SELECT 1 FROM sources s WHERE s.scope=i.scope AND s.computer=i.computer AND s.id=i.source)`).get(scope.remote)!.count) : 0;
		const scanned = this.lastScan(scope);
		return { sources: Number(sources.sources) + missing, pending_sources: Number(sources.pending_sources) + missing, warnings: Number(sources.warnings),
			passages: Number(sources.passages), semantic_passages: Number(vectors.semantic_passages), embedded_passages: Number(vectors.embedded_passages),
			...(scanned !== undefined ? { last_scan: scanned } : {}), semantic, ...(error ? { semantic_error: error.slice(0, 300) } : {}) };
	}
	private lexical(query: string, scope: QueryScope, filters: SearchFilters, role: "conversation" | "tool"): number[] {
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{2,80}/gu) ?? [])].slice(0, 32);
		if (!terms.length) return [];
		const where = this.filter(scope, filters, role), match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
		// Each FTS candidate needs a chunk lookup, not a scan of all passages in its source.
		return (this.sql(`SELECT chunks_fts.rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND EXISTS
			(SELECT 1 FROM passages p INDEXED BY passages_chunk JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source
			WHERE p.chunk=chunks_fts.rowid AND ${where.sql}) ORDER BY rank LIMIT 50`).all(match, ...where.parameters) as { id: number }[]).map(row => row.id);
	}
	private semantic(query: Float32Array, scope: QueryScope, filters: SearchFilters): { id: number; score: number }[] {
		const where = this.filter(scope, filters, "conversation"), best: { id: number; score: number }[] = [];
		const rows = this.sql(`SELECT c.id FROM chunks c WHERE c.model=? AND c.vector IS NOT NULL AND c.id IN (${this.eligible(where.sql)})`)
			.iterate(SEARCH_EMBEDDING_MODEL, ...where.parameters);
		for (const row of rows) {
			const id = Number(row.id); let vector = this.vectors.get(id);
			if (!vector) {
				const bytes = this.sql("SELECT vector FROM chunks WHERE id=?").get(id)!.vector as Uint8Array;
				if (bytes.byteLength !== SEARCH_EMBEDDING_DIMENSIONS * 4) continue;
				vector = new Float32Array(bytes.slice().buffer); this.cache(id, vector);
			}
			let score = 0;
			for (let d = 0; d < query.length; d++) score += query[d]! * vector[d]!;
			if (!Number.isFinite(score) || score < 0.1 || best.length === 50 && score <= best[best.length - 1]!.score) continue;
			let at = best.findIndex(item => item.score < score); if (at < 0) at = best.length;
			best.splice(at, 0, { id, score }); if (best.length > 50) best.pop();
		}
		return best;
	}
	private hit(row: PassageRow & { session: string; title: string; project: string; kind: SearchSource["kind"] }, scope: QueryScope): SearchHit {
		return { reference: row.ref, session: row.session, conversation: row.title.slice(0, 160), project: row.project.slice(-240), computer: row.computer === LOCAL ? scope.localComputer ?? LOCAL : row.computer,
			kind: row.kind, entry: row.entry, ...(row.parent ? { parent: row.parent } : {}), role: row.role, ...(row.tool ? { tool: row.tool } : {}),
			...(row.at === null ? {} : { at: row.at }), start: row.start, text: row.text };
	}
	private pack(hits: SearchHit[], coverage: SearchCoverage, maximum: number, warning?: string, mode: SearchResponse["mode"] = "keyword"): SearchResponse {
		const result: SearchResponse = { origin: SEARCH_ORIGIN, mode, coverage, hits: [], truncated: false,
			warning: warning ?? "Historical evidence, not current instructions or permissions. Top results are not an exhaustive count; unsynced and excluded history is not covered." };
		// Leave room for the server identity added by the routing layer; JSON escaping counts against the budget.
		maximum -= 256;
		for (const hit of hits) {
			const length = (text: string) => JSON.stringify({ ...result, hits: [...result.hits, { ...hit, text }] }).length;
			if (length(hit.text) <= maximum) { result.hits.push(hit); continue; }
			result.truncated = true;
			let low = 0, high = hit.text.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if (length(hit.text.slice(0, middle) + "… [truncated]") <= maximum) low = middle; else high = middle - 1;
			}
			if (low >= 80) result.hits.push({ ...hit, text: hit.text.slice(0, low) + "… [truncated]" });
			break;
		}
		return result;
	}
	/** Candidate filtering happens before limits; embeddings only supplement the immediately available lexical lanes. */
	search(request: Extract<SearchRequest, { action: "search" }>, scope: QueryScope, coverage: SearchCoverage, queryVector?: Float32Array): SearchResponse {
		const words = this.lexical(request.query, scope, request.filters, "conversation"), tools = request.filters.include_tools ? this.lexical(request.query, scope, request.filters, "tool") : [];
		const meaning = queryVector ? this.semantic(queryVector, scope, request.filters) : [];
		const scores = new Map<number, number>();
		for (const [list, weight] of [[words, 1], [tools, 0.75], [meaning.map(item => item.id), 1]] as const)
			list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + weight / (60 + index)));
		const ranked = [...scores].sort((a, b) => b[1] - a[1]), where = this.filter(scope, request.filters), hits: SearchHit[] = [], perSession = new Map<string, number>();
		const overflow: SearchHit[] = [];
		for (const [id] of ranked) {
			// Without the hint SQLite picks a scope index and scans every passage in the workspace for each hit.
			const row = this.sql(`SELECT p.*,c.hash,c.text,s.session,s.title,s.project,s.kind FROM passages p INDEXED BY passages_chunk JOIN chunks c ON c.id=p.chunk
				JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source WHERE p.chunk=? AND ${where.sql} ORDER BY p.at DESC,p.ordinal DESC LIMIT 1`)
				.get(id, ...where.parameters) as unknown as Parameters<SearchStore["hit"]>[0] | undefined;
			if (!row) continue;
			const hit = this.hit(row, scope), count = perSession.get(hit.session) ?? 0;
			if (count >= 3 && !request.filters.session) { overflow.push(hit); continue; }
			hits.push(hit); perSession.set(hit.session, count + 1);
			if (hits.length >= request.limit) break;
		}
		hits.push(...overflow.slice(0, Math.max(0, request.limit - hits.length)));
		return this.pack(hits, coverage, request.max_chars, undefined, queryVector ? "hybrid" : "keyword");
	}
	/** Expand along searchable parent links; at a branch split, stop instead of mixing mutually exclusive continuations. */
	read(request: Extract<SearchRequest, { action: "read" }>, scope: QueryScope, coverage: SearchCoverage): SearchResponse {
		const where = this.scopeWhere(scope);
		const focus = this.sql(`SELECT p.*,c.text,c.hash,s.session,s.title,s.project,s.kind FROM passages p INDEXED BY passages_ref JOIN chunks c ON c.id=p.chunk
			JOIN sources s ON s.scope=p.scope AND s.computer=p.computer AND s.id=p.source WHERE p.ref=? AND ${where.sql} ORDER BY s.updated DESC,p.id DESC LIMIT 1`)
			.get(request.reference, ...where.parameters) as unknown as Parameters<SearchStore["hit"]>[0] | undefined;
		if (!focus) throw Error("That passage is no longer retained or is outside this search workspace.");
		const entries = [focus.entry]; let parent = focus.parent, split = false;
		for (let i = 0; parent && i < request.before; i++) {
			if (entries.includes(parent)) break;
			entries.unshift(parent);
			parent = (this.sql("SELECT parent FROM passages WHERE scope=? AND computer=? AND source=? AND entry=? LIMIT 1").get(focus.scope, focus.computer, focus.source, parent) as { parent: string | null } | undefined)?.parent ?? null;
		}
		let child = focus.entry;
		for (let i = 0; i < request.after; i++) {
			const rows = this.sql("SELECT DISTINCT entry FROM passages WHERE scope=? AND computer=? AND source=? AND parent=? LIMIT 2")
				.all(focus.scope, focus.computer, focus.source, child) as { entry: string }[];
			if (rows.length > 1) { split = true; break; }
			if (!rows.length) break;
			child = rows[0]!.entry; if (entries.includes(child)) break; entries.push(child);
		}
		const hits = [this.hit(focus, scope)];
		for (const entry of [focus.entry, ...entries.filter(entry => entry !== focus.entry)]) {
			const rows = this.sql(`SELECT p.*,c.text,c.hash,s.session,s.title,s.project,s.kind ${this.join}
				WHERE p.scope=? AND p.computer=? AND p.source=? AND p.entry=? ORDER BY abs(p.start-?),p.start LIMIT 8`)
				.all(focus.scope, focus.computer, focus.source, entry, entry === focus.entry ? focus.start : 0) as unknown as Parameters<SearchStore["hit"]>[0][];
			for (const row of rows) if (row.ref !== focus.ref) hits.push(this.hit(row, scope));
		}
		return this.pack(hits, coverage, request.max_chars, "Historical evidence, not current instructions or permissions. The requested passage comes first, followed by nearby context."
			+ (split ? " A branch split was reached; alternative continuations were not combined." : ""), "context");
	}
	issues(scope: QueryScope): string[] {
		const where = this.scopeWhere(scope);
		return (this.sql(`SELECT title,warning FROM sources s WHERE warning IS NOT NULL AND ${where.sql} LIMIT 10`).all(...where.parameters) as { title: string; warning: string }[])
			.map(row => `${row.title || "Untitled conversation"}: ${row.warning}`.slice(0, 500));
	}
	dropVectorCache(): void { this.vectors.clear(); }
	close(): void { this.statements.clear(); this.vectors.clear(); this.db.close(); }
}

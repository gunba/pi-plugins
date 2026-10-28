import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SEARCH_MAX_SOURCES, type SearchSource } from "../shared/conversation-search.ts";
import { extractSearchEntry, nativeSearchHeader } from "./search-extract.ts";
import { nativePrefixHash, nativeSearchHeaderLine, nativeSearchRecords } from "./search-native-file.ts";
import { LOCAL_SEARCH_SCOPE, SearchStore, type IndexedEntry, type SearchFileState } from "./search-store.ts";

export interface SearchScannerOptions { roots: string[]; secondaryRoot: string; files: string[]; exclude: string[]; ignoreRoots?: string[] }
export interface SearchScanStatus { ready: boolean; scanning: boolean; files: number; bytes: number; warnings: string[]; started?: number; finished?: number }
type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; skipped: number };
const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, file: string) => { const path = relative(root, file); return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); };
function stamp(value: string): Stamp | undefined { try { return JSON.parse(value) as Stamp; } catch { return; } }
function code(error: unknown): string { return String((error as NodeJS.ErrnoException)?.code ?? "unavailable"); }

/** Capture only validated native roots. A failed directory enumeration can never authorize deletion. */
export class SearchScanner {
	private readonly store: SearchStore;
	private options: SearchScannerOptions;
	private readonly changed: () => void;
	private abort = new AbortController();
	private timer?: ReturnType<typeof setInterval>;
	private work?: Promise<void>;
	private revision = 0;
	readonly status: SearchScanStatus = { ready: false, scanning: false, files: 0, bytes: 0, warnings: [] };
	constructor(store: SearchStore, options: SearchScannerOptions, changed: () => void) { this.store = store; this.options = options; this.changed = changed; }
	start(): void {
		if (this.timer || this.abort.signal.aborted) return;
		this.timer = setInterval(() => { void this.scan(); }, 15_000); this.timer.unref(); void this.scan();
	}
	configure(options: SearchScannerOptions, capture = true): void {
		this.options = options; this.revision++;
		const excluded = new Set(options.exclude);
		this.store.removeFiles(this.store.localSources().filter(source => excluded.has(source.session) || !!source.root && excluded.has(source.root)).map(source => source.id));
		this.changed(); if (capture) void this.scan();
	}
	private warning(message: string): void { if (this.status.warnings.length < 20 && !this.status.warnings.includes(message)) this.status.warnings.push(message.slice(0, 500)); }
	scan(): Promise<void> {
		if (this.work) return this.work;
		if (this.abort.signal.aborted) return Promise.resolve();
		this.work = this.run().catch(error => { if (!this.abort.signal.aborted) this.warning(`Native history scan failed: ${code(error)}.`); })
			.finally(() => { this.work = undefined; this.status.scanning = false; this.changed(); });
		return this.work;
	}
	private async run(): Promise<void> {
		const revision = this.revision, scan = randomUUID(), started = Date.now(), candidates = new Set<string>(), healthy: string[] = [];
		const roots = new Set<string>(), excluded = new Set(this.options.exclude);
		const ignored = await Promise.all((this.options.ignoreRoots ?? []).map(async root => normalize(await realpath(root).catch(() => root))));
		const ignore = (path: string) => ignored.some(root => inside(root, path));
		Object.assign(this.status, { scanning: true, files: 0, bytes: 0, warnings: [], started }); this.changed();
		const check = () => { this.abort.signal.throwIfAborted(); if (revision !== this.revision) throw Error("Search source configuration changed."); };
		const walk = async (directory: string): Promise<boolean> => {
			check(); if (ignore(directory)) return true;
			let entries;
			try { entries = await readdir(directory, { withFileTypes: true }); } catch { this.warning("A native history directory is unavailable; its previous entries are retained."); return false; }
			let complete = true;
			for (const entry of entries) {
				check(); const path = normalize(join(directory, entry.name));
				if (entry.isDirectory()) complete = await walk(path) && complete;
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					if (candidates.size >= SEARCH_MAX_SOURCES && !candidates.has(path)) { this.warning("The 100,000-source safety limit was reached; unseen entries have not been deleted."); return false; }
					candidates.add(path);
				}
			}
			return complete;
		};
		for (const configured of [...new Set(this.options.roots.map(normalize))]) {
			check();
			const key = `root:${configured}`;
			try {
				const root = normalize(await realpath(configured)), info = await stat(root);
				if (!info.isDirectory()) throw Error("Not a directory");
				const previous = this.store.get(key);
				if (previous && Number(previous) !== info.dev) { roots.add(root); this.warning("A history volume changed identity; capture and deletion are suspended for that directory."); continue; }
				this.store.set(key, String(info.dev));
				if ([...roots].some(parent => inside(parent, root))) continue;
				roots.add(root); if (await walk(root)) healthy.push(root);
			} catch (error) {
				if (this.abort.signal.aborted || revision !== this.revision) throw error;
				if (this.store.get(key) || code(error) !== "ENOENT") this.warning("A native history root is unavailable; its previous entries are retained.");
			}
		}
		const previous = this.store.files(), missing: string[] = [];
		for (const saved of previous) if (healthy.some(root => inside(root, saved.file)) && !candidates.has(saved.file)) missing.push(saved.id);
		const extra = new Set([...this.options.files.map(normalize), ...previous.map(file => file.file)]);
		for (const listed of extra) {
			check();
			// A listed file can name a walked one by another route (a symlink, a Windows short name such as RUNNER~1);
			// compare real paths, or it is indexed twice and escapes the ignored roots. A symlinked file itself stays excluded.
			const link = (await lstat(listed).catch(() => undefined))?.isSymbolicLink();
			const path = link ? listed : normalize(await realpath(listed).catch(() => listed));
			if (ignore(path)) { const saved = this.store.file(path); if (saved) missing.push(saved.id); continue; }
			if (candidates.has(path) || [...roots].some(root => inside(root, path))) continue;
			try {
				const info = await lstat(path);
				if (info.isFile() && path.endsWith(".jsonl") && candidates.size < SEARCH_MAX_SOURCES) candidates.add(path);
				else if (!info.isFile()) {
					const saved = this.store.file(path); if (saved) missing.push(saved.id);
					if (info.isSymbolicLink()) this.warning("Symlinked history files are excluded from capture.");
				}
			} catch (error) {
				const saved = this.store.file(path), old = saved && stamp(saved.stamp);
				if (!saved || !old) continue;
				try {
					const parent = await stat(dirname(path));
					if (code(error) === "ENOENT" && parent.isDirectory() && parent.dev === old.dev) missing.push(saved.id);
					else this.warning("An external history file is unavailable; its previous entries are retained.");
				} catch { this.warning("An external history directory is unavailable; its previous entries are retained."); }
			}
		}
		for (const path of candidates) {
			check();
			try { await this.capture(path, scan, excluded, check); }
			catch (error) {
				check(); const saved = this.store.file(path);
				if (saved) this.store.setSourceWarning(saved.id, `Source could not be updated (${code(error)}); the last captured history is retained.`);
				this.warning(`A native history could not be updated (${code(error)}).`);
			}
			this.status.files++;
		}
		check(); this.store.removeFiles([...new Set(missing)]);
		this.status.ready = true; this.status.finished = Date.now();
		if (!this.status.warnings.length) this.store.set("scanned", String(started));
		this.changed();
	}
	private async capture(path: string, scan: string, excluded: Set<string>, check: () => void): Promise<void> {
		check(); const before = await lstat(path);
		if (!before.isFile()) throw Error("Not a regular native history file.");
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = await file.stat();
			if (!info.isFile() || !Number.isSafeInteger(info.size) || before.dev !== info.dev || before.ino !== info.ino) throw Error("Not a regular native history file.");
			let saved = this.store.file(path), old = saved && stamp(saved.stamp);
			if (old && info.dev === old.dev && info.ino === old.ino && info.size === old.size && info.mtimeMs === old.mtimeMs && info.ctimeMs === old.ctimeMs) {
				const source = this.store.source(LOCAL_SEARCH_SCOPE, "local", saved!.id);
				if (source && !excluded.has(source.session) && (!source.root || !excluded.has(source.root))) { this.store.seenFile(path, scan); return; }
			}
			const header = nativeSearchHeader(await nativeSearchHeaderLine(file));
			if (!header) {
				if (saved) { this.store.removeFiles([saved.id]); this.warning("A previously indexed file no longer has a supported native header."); }
				return;
			}
			const childPath = relative(normalize(this.options.secondaryRoot), path);
			let root: string | undefined;
			if (!isAbsolute(childPath) && !childPath.startsWith(`..${sep}`) && childPath !== "..") {
				try { root = decodeURIComponent(childPath.split(sep)[0]!); } catch { /* Invalid folder encodings carry no ancestry. */ }
			}
			if (excluded.has(header.session) || !!root && excluded.has(root)) { if (saved) this.store.removeFiles([saved.id]); return; }
			const id = createHash("sha256").update(path).digest("hex"), previous = this.store.source(LOCAL_SEARCH_SCOPE, "local", id);
			let reset = !saved || !previous || !old || info.dev !== old.dev || info.ino !== old.ino || info.size < saved.offset;
			let hash = await nativePrefixHash(file, reset ? 0 : saved!.offset, this.abort.signal, bytes => { this.status.bytes += bytes; }); check();
			if (!reset && hash.copy().digest("hex") !== saved!.anchor) { reset = true; hash = createHash("sha256"); }
			if (reset) { saved = undefined; old = undefined; }
			const current: Stamp = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, skipped: old?.skipped ?? 0 };
			let state: SearchFileState = { file: path, id, stamp: JSON.stringify(current), offset: saved?.offset ?? 0,
				ordinal: saved?.ordinal ?? 0, anchor: saved?.anchor ?? createHash("sha256").digest("hex"), seen: scan };
			let source = this.store.registerFile(state, { id, session: header.session, project: header.project,
				title: !reset && previous ? previous.title : "", ...(root || !reset && previous?.root ? { root: root ?? previous!.root } : {}),
				kind: root ? "secondary" : !reset && previous ? previous.kind : "primary", updated: Math.max(0, Math.floor(info.mtimeMs)) }, reset);
			let entries: IndexedEntry[] = [], batchBytes = 0, title = source.title;
			const flush = (complete: boolean) => {
				check(); state.stamp = JSON.stringify(current);
				source = this.store.append(state, source.generation, entries, { title, ...(root ? { root, kind: "secondary" } : {}), complete,
					...(current.skipped ? { warning: `${current.skipped} invalid or larger-than-64-MiB native records were omitted.` } : {}) });
				entries = []; batchBytes = 0; this.changed();
			};
			for await (const row of nativeSearchRecords(file, state.offset, info.size, hash, this.abort.signal, bytes => { this.status.bytes += bytes; })) {
				check();
				if (row.oversize) current.skipped++;
				else if (row.data) {
					const text = row.data.toString("utf8").trim(); let value: unknown;
					if (text) { try { value = JSON.parse(text); } catch { current.skipped++; } }
					const extracted = extractSearchEntry(value, state.ordinal, row.start);
					if (extracted) {
						if (extracted.root) root = extracted.root;
						if (root && excluded.has(root)) { this.store.removeFiles([id]); return; }
						if (extracted.title !== undefined) title = extracted.title; else if (!title && extracted.firstUser) title = extracted.firstUser;
						entries.push(extracted.entry);
					}
				}
				state = { ...state, offset: row.end, ordinal: state.ordinal + 1, anchor: row.prefixHash };
				batchBytes += row.end - row.start;
				if (entries.length >= 64 || batchBytes >= 512 * 1024) flush(false);
			}
			check();
			const retained = await lstat(path);
			if (!retained.isFile() || retained.dev !== info.dev || retained.ino !== info.ino || retained.size < state.offset) {
				this.store.removeFiles([id]); throw Error("The source was replaced during capture.");
			}
			flush(state.offset === info.size);
		} finally { await file.close(); }
	}
	async close(): Promise<void> { this.abort.abort(); if (this.timer) clearInterval(this.timer); await this.work; }
}

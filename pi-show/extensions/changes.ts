import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FILTERED, filtered, readVersion, type Version } from "./content.ts";
import type { OfficeDocument } from "./documents.ts";
import { lineDiff } from "./sequence-diff.ts";

/**
 * Every file a tool call changed, however it changed it: a script, sed, a build, a background process.
 *
 * Each folder a conversation works in is snapshotted into Desk's own git object store before and after each call
 * (`git add -A` into a private index, then `write-tree`), the way Jujutsu snapshots its working copy. The user's
 * repository, index and branches are never written; its objects are shared read-only through alternates, so a
 * snapshot stores only files that differ from it. Snapshots are chained, so changes made while no call was running
 * are reported with the next call as made meanwhile. Files a call names outside those folders are compared directly.
 *
 * Storage holds one version of each file, never a history: the newest snapshot of each conversation is the only thing
 * kept reachable, and superseded versions are deleted by git's own collection shortly after. Office documents are
 * kept as their content and other binary files as a fingerprint (content.ts, applied by git's clean filter).
 */
export type FileChange = {
	path: string; action: "added" | "updated" | "deleted";
	diff?: string; added?: number; removed?: number; truncated?: boolean;
	/** Why there is no diff: binary or too large. */
	note?: string;
	/** Changed while no tool call was running: a background process, another program or another agent. */
	meanwhile?: true;
};
export type CallChanges = {
	files: FileChange[];
	/** Office files, as their documents for the document diff; before is null for a new file. */
	documents: { path: string; before: OfficeDocument | null; after: OfficeDocument }[];
	/** Files a git pull, checkout, rebase or reset brought, summarised instead of shown. */
	fromGit?: { root: string; count: number; from: string; to: string };
	/** Changed files beyond the shown limit. */
	more?: string[];
};

type Delta = { before: string | null; after: string | null };
type Change = Delta & { root?: Root; loose?: { before: Buffer | null; after: Buffer | null }; meanwhile?: true };
type Seen = Map<string, Change>;
/** opened: when the snapshot before the call was taken. */
type Call = { seen: Seen; heads: Map<Root, string | undefined>; loose: Map<string, Buffer | null>; opened: number };
/**
 * What a conversation's call changed in a folder, as it saw it: who (s), when the call ran (a to b) and each file's
 * version afterwards (f, null when deleted). Kept in the folder's store, shared by every conversation working there.
 */
type Claim = { s: string; a: number; b: number; f: Record<string, string | null> };
const CLAIMS_KEPT = 60 * 60_000;

const MAX_FILES = 40, TEXT_LIMIT = 2 * 1024 * 1024, DIFF_CHARS = 64_000, OFFICE_LIMIT = 64 * 1024 * 1024;
const ROOT_FILES = 20_000, ROOT_BYTES = 256 * 1024 ** 2, BIG_FILE = 32 * 1024 * 1024, ROOTS = 12, LOOSE = 32;
/** Tools that never write files; every other call is watched. */
export const READ_ONLY = new Set(["read", "grep", "find", "ls", "web_search", "read_artifact", "view_image", "get_plan", "inspect_files",
	"agent_discover", "list_agents", "quest_list", "ask_user", "tool_search", "chrome_devtools_load"]);
/** Dependencies, caches, and the lock files Office and LibreOffice keep beside an open document. */
const DEFAULT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", ".cache/", ".pytest_cache/", ".mypy_cache/", ".DS_Store", ".git/", "~$*", ".~lock.*#", "*.tmp"];
/** Change notices for these paths never mean a followed file changed. */
const UNWATCHED = /(^|[\\/])(\.git|node_modules|__pycache__|\.venv)([\\/]|$)|(^|[\\/])~\$[^\\/]*$/;
let launched = 0;
/** Git processes started so far, to keep the cost per call visible. */
export const gitProcesses = () => launched;
/**
 * Superseded versions are deleted once this old. Snapshots this conversation still reads are held explicitly; the
 * margin covers another conversation storing a snapshot in the same folder at that moment.
 */
const GRACE = "1.minute.ago";
/** New versions stored since the last cleanup that make one worthwhile, in bytes. */
const CLEANUP_BYTES = 1024 * 1024;
/** Git runs the content filter with the Node running Pi, quoted for the shell git uses (on Windows too). */
const shellQuote = (path: string) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
const FILTER = `${shellQuote(process.execPath)} --no-warnings ${shellQuote(fileURLToPath(new URL("./content-filter.ts", import.meta.url)))}`;
/** Highest-precedence attributes: no filter of the repository's own (such as Git LFS) runs on Desk's copy. */
const ATTRIBUTES = `* !filter\n${FILTERED.flatMap(pattern => [pattern, pattern.toUpperCase()]).map(pattern => `${pattern} filter=desk`).join("\n")}\n`;
const safeName = (session: string) => session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "session";
const commonDir = (gitDir: string) => { try { return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch { return gitDir; } };
const ZERO = /^0+$/;

const home = homedir();
const expand = (path: string) => path === "~" ? home : /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path.replace(/^\$HOME(?=[\\/]|$)/, home);
const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");
const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const textual = (data: Buffer) => !data.subarray(0, 8192).includes(0);

/** Scratch and system folders: never followed or compared. */
export const SCRATCH = [tmpdir(), "/tmp", "/var/tmp", "/dev", "/proc", "/sys", "/run", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/snap"];
function scratch(path: string, agentDir: string, temporary: string[]): boolean {
	const state = ["sessions", "desk", "tool-output", "changes", "show", "git", "npm", "backups", "party"].map(name => join(agentDir, name));
	return [...temporary, ...state].some(folder => within(path, folder));
}
/** A folder too broad to snapshot as a whole. */
function broad(path: string, agentDir: string, temporary: string[]): boolean {
	return path === home || path === resolve("/") || /^[A-Za-z]:\\?$/.test(path) || within(home, path) || within(path, agentDir) || within(agentDir, path) || scratch(path, agentDir, temporary)
		|| ["/usr", "/etc", "/var", "/opt", "/boot", "/bin", "/lib", "/srv", "/mnt", "/media"].some(folder => within(path, folder));
}
function gitDirOf(top: string): string | undefined {
	const dot = join(top, ".git");
	try {
		if (statSync(dot).isDirectory()) return dot;
		const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
		return match ? resolve(top, match[1]!.trim()) : undefined;
	} catch { return; }
}
function repositoryOf(path: string): string | undefined {
	for (let folder = path; ; folder = dirname(folder)) {
		if (existsSync(join(folder, ".git"))) return folder;
		if (dirname(folder) === folder) return;
	}
}
/**
 * What a command names: the folders it changes into (cd, in order), other folders it points at (git -C, --prefix, paths
 * of directories) and files by absolute or home path.
 */
export function mentioned(text: string, cwd: string): { entered: string[]; folders: string[]; files: string[] } {
	const entered: string[] = [], folders: string[] = [], files: string[] = [];
	let base = cwd;
	for (const match of text.matchAll(/(?:^|[\s;&|(])cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|)]+)/g)) {
		base = resolve(base, expand(unquote(match[1]!))); entered.push(base);
	}
	for (const match of text.matchAll(/(?:git\s+-C|--prefix[= ]|--work-tree[= ]|--cwd[= ])\s*("[^"\n]+"|'[^'\n]+'|[^\s;&|)]+)/g)) folders.push(resolve(cwd, expand(unquote(match[1]!))));
	const paths = [...text.matchAll(/(?:^|[\s"'=(:;|&<>`,])((?:~|\$HOME)?\/[^\s"'`;|&<>(),*?${}\\]+)/g),
		...process.platform === "win32" ? text.matchAll(/(?:^|[\s"'=(;|&<>`,])([A-Za-z]:[\\/][^\s"'`;|&<>(),*?${}]+)/g) : []];
	for (const match of paths) {
		if (match[1]!.startsWith("//")) continue;
		const path = resolve(expand(match[1]!.replace(/[.:]+$/, "")));
		try { if (statSync(path).isDirectory()) folders.push(path); else files.push(path); }
		catch { if (existsSync(dirname(path))) files.push(path); }
	}
	return { entered: [...new Set(entered)], folders: [...new Set(folders)], files: [...new Set(files)].slice(0, LOOSE) };
}
/** A folder under home whose path has a hidden part, such as ~/.config: application state, not a project. */
const hidden = (path: string) => within(path, home) && relative(home, path).split(sep).some(part => part.startsWith("."));
/** Up to `limit` files under a folder, giving up early on folders far too large to snapshot. */
function small(folder: string): boolean {
	let count = 0;
	const deadline = Date.now() + 300, pending = [folder];
	while (pending.length) {
		let entries;
		try { entries = readdirSync(pending.pop()!, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (++count > ROOT_FILES || Date.now() > deadline) return false;
			if (entry.isDirectory() && !DEFAULT_EXCLUDES.includes(`${entry.name}/`)) pending.push(join(entry.parentPath ?? (entry as { path?: string }).path ?? folder, entry.name));
		}
	}
	return true;
}

class Root {
	last?: string;
	broken = false;
	/** Something under the folder may have changed since the last snapshot. Always true without a watcher. */
	dirty = true;
	private watcher?: FSWatcher;
	private queue: Promise<unknown> = Promise.resolve();
	/** Snapshots that stored something new since this conversation started following the folder. */
	writes = 0;
	/** Bytes of versions stored since the last cleanup. */
	pending = 0;
	/** Superseded snapshots running calls may still read from. */
	private held = new Set<string>();
	readonly path: string;
	readonly gitDir: string;
	readonly index: string;
	readonly repository?: string;
	private readonly name: string;
	constructor(path: string, store: string, session: string) {
		this.path = path;
		this.name = safeName(session);
		this.gitDir = join(store, createHash("sha256").update(path).digest("hex").slice(0, 24));
		this.index = join(this.gitDir, `index-${this.name}`);
		this.repository = gitDirOf(path);
	}
	private ref(name: string): string { return join(this.gitDir, "refs", "desk", name); }
	private setRef(name: string, tree: string): void {
		mkdirSync(join(this.gitDir, "refs", "desk"), { recursive: true });
		writeFileSync(`${this.ref(name)}.tmp`, `${tree}\n`);
		renameSync(`${this.ref(name)}.tmp`, this.ref(name));
	}
	/** The newest snapshot is what keeps its versions; anything older is left for collection. */
	pin(tree: string): void { try { this.setRef(this.name, tree); } catch { /* Kept for the grace period only. */ } }
	/** Keeps a superseded snapshot while calls that began before it was replaced may still read from it. */
	hold(tree: string): void { if (!this.held.has(tree)) try { this.setRef(`${this.name}-held-${tree}`, tree); this.held.add(tree); } catch { /* Grace period only. */ } }
	/** No call is running: superseded snapshots are no longer needed. */
	letGo(): void { for (const tree of this.held) rmSync(this.ref(`${this.name}-held-${tree}`), { force: true }); this.held.clear(); }
	/** Counts the bytes of newly stored versions, from git's own files, without starting git. */
	note(ids: (string | null)[]): void {
		for (const id of ids) if (id) try { this.pending += statSync(join(this.gitDir, "objects", id.slice(0, 2), id.slice(2))).size; } catch { /* Not stored here: unchanged or in the repository. */ }
	}
	/** At the end of a conversation its snapshot and index become the starting point for the next one in this folder. */
	release(): void {
		try {
			this.letGo();
			if (this.last && existsSync(this.index)) { this.setRef("last", this.last); renameSync(this.index, join(this.gitDir, "index-last")); }
			rmSync(this.ref(this.name), { force: true }); rmSync(this.index, { force: true });
		} catch { /* Collected as stale later. */ }
	}
	/** Deletes superseded versions, queued with this folder's snapshots. */
	prune(grace = GRACE): Promise<void> {
		this.pending = 0;
		return this.serial(() => this.git(["prune", `--expire=${grace}`], { work: false })).then(() => undefined, () => undefined);
	}
	/**
	 * Deletes versions nothing refers to any more. Queued with this folder's snapshots, so it never races them; the grace
	 * period protects snapshots other conversations are writing at the same moment.
	 */
	collect(grace = GRACE): Promise<void> {
		return this.serial(() => this.git(["-c", "gc.packRefs=false", "-c", "gc.writeCommitGraph=false", "gc", "--quiet", `--prune=${grace}`], { work: false }))
			.then(() => undefined, () => undefined);
	}
	private env(options: { work?: boolean; repository?: boolean }): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
		for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"]) delete env[name];
		if (options.repository) env.GIT_DIR = this.repository;
		else { env.GIT_DIR = this.gitDir; env.GIT_INDEX_FILE = this.index; if (options.work !== false) env.GIT_WORK_TREE = this.path; }
		return env;
	}
	private static readonly CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "advice.addEmbeddedRepo=false",
		"-c", `filter.desk.process=${FILTER}`, "-c", "filter.desk.required=true"];
	git(args: string[], options: { work?: boolean; repository?: boolean } = {}): Promise<Buffer> {
		launched++;
		return new Promise((done, fail) => execFile("git", [...Root.CONFIG, ...args],
			{ env: this.env(options), cwd: this.path, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 60_000, windowsHide: true },
			(error, stdout) => error ? fail(error) : done(stdout)));
	}
	/** Runs git with `input` on standard input, for the batch modes that read many objects in one process. */
	private gitInput(args: string[], input: string): Promise<Buffer> {
		launched++;
		return new Promise((done, fail) => {
			const child = spawn("git", [...Root.CONFIG, ...args], { env: this.env({ work: false }), cwd: this.path, windowsHide: true });
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.on("error", fail);
			child.on("close", code => code === 0 ? done(Buffer.concat(chunks)) : fail(new Error(`git ${args[0]} exited with ${code}`)));
			child.stdin.end(input);
		});
	}
	/** Where the system reports changes under a folder, a call that changed nothing needs no git at all. */
	watch(): void {
		try {
			this.watcher = watch(this.path, { recursive: true, persistent: false }, (_event, name) => {
				if (!name || !UNWATCHED.test(String(name))) this.dirty = true;
			});
			// Never what keeps a process alive, on any platform.
			this.watcher.unref();
			this.watcher.on("error", () => this.close());
		} catch { this.watcher = undefined; }
	}
	get watching(): boolean { return !!this.watcher; }
	close(): void { this.watcher?.close(); this.watcher = undefined; this.dirty = true; }
	/** Runs one git operation on this folder at a time; the private index allows no more. */
	serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}
	/** Creates Desk's store for this folder; false when the folder is too large to follow. */
	async prepare(agentDir: string, temporary: string[]): Promise<boolean> {
		if (!existsSync(join(this.gitDir, "HEAD"))) {
			if (!this.repository && (broad(this.path, agentDir, temporary) || !small(this.path))) return false;
			mkdirSync(dirname(this.gitDir), { recursive: true, mode: 0o700 });
			await new Promise<void>((done, fail) => execFile("git", ["init", "-q", "--bare", this.gitDir], { windowsHide: true }, error => error ? fail(error) : done()));
			await this.git(["config", "core.bare", "false"], { work: false });
			const own = this.repository && /objectformat\s*=\s*sha256/i.test((() => { try { return readFileSync(join(this.repository!, "config"), "utf8"); } catch { return ""; } })()) ? undefined : this.repository;
			if (own) writeFileSync(join(this.gitDir, "objects", "info", "alternates"), `${join(commonDir(own), "objects")}\n`);
			writeFileSync(join(this.gitDir, "root"), this.path);
		}
		if (!existsSync(this.index)) {
			let excludes = DEFAULT_EXCLUDES.join("\n");
			try { if (this.repository) excludes += `\n${readFileSync(join(commonDir(this.repository), "info", "exclude"), "utf8")}`; } catch { /* None. */ }
			writeFileSync(join(this.gitDir, "info", "exclude"), `${excludes}\n`);
			writeFileSync(join(this.gitDir, "info", "attributes"), ATTRIBUTES);
			// A warm stat cache, so only files that differ from it are read: the last conversation's here, else the repository's.
			const previous = join(this.gitDir, "index-last");
			if (existsSync(previous) && existsSync(this.ref("last"))) copyFileSync(previous, this.index);
			else if (this.repository) try { copyFileSync(join(this.repository, "index"), this.index); } catch { /* A repository without commits. */ }
			const untracked = (await this.git(["ls-files", "-o", "-z", "--exclude-standard"])).toString("utf8").split("\0").filter(Boolean);
			if (untracked.length > ROOT_FILES) return false;
			// Office and binary files cost a few bytes each; only files kept as they are count towards the limit.
			let bytes = 0;
			const big: string[] = [];
			for (const name of untracked) {
				try {
					const size = statSync(join(this.path, name)).size;
					if (size > BIG_FILE) big.push(`/${name.replace(/([*?[\\])/g, "\\$1")}`); else if (!filtered(name)) bytes += size;
				} catch { /* Gone. */ }
			}
			if (bytes > ROOT_BYTES) return false;
			if (big.length) writeFileSync(join(this.gitDir, "info", "exclude"), `${readFileSync(join(this.gitDir, "info", "exclude"), "utf8")}${big.join("\n")}\n`);
		}
		return true;
	}
	async snapshot(): Promise<string> {
		try { await this.git(["add", "-A", "--ignore-errors", "--", "."]); } catch { /* Unreadable files are left out; the rest is staged. */ }
		return (await this.git(["write-tree"])).toString().trim();
	}
	async delta(from: string, to: string): Promise<Map<string, Delta>> {
		const result = new Map<string, Delta>();
		if (from === to) return result;
		const parts = (await this.git(["diff-tree", "-r", "-z", "--no-renames", from, to], { work: false })).toString("utf8").split("\0");
		for (let index = 0; index + 1 < parts.length; index += 2) {
			const [oldMode, newMode, before, after] = parts[index]!.slice(1).split(" ");
			if (oldMode === "160000" || newMode === "160000") continue;
			result.set(parts[index + 1]!, { before: ZERO.test(before!) ? null : before!, after: ZERO.test(after!) ? null : after! });
		}
		return result;
	}
	/** Contents of objects, in two git processes however many there are; "large" above the object's limit. */
	async contents(limits: Map<string, number>): Promise<Map<string, Buffer | "large">> {
		const result = new Map<string, Buffer | "large">(), wanted: string[] = [];
		if (!limits.size) return result;
		for (const line of (await this.gitInput(["cat-file", "--batch-check=%(objectname) %(objectsize)"], `${[...limits.keys()].join("\n")}\n`)).toString().split("\n")) {
			const [id, size] = line.split(" ");
			if (!id || !size || !limits.has(id)) continue;
			if (Number(size) > limits.get(id)!) result.set(id, "large"); else wanted.push(id);
		}
		if (!wanted.length) return result;
		const output = await this.gitInput(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
		for (let at = 0; at < output.length;) {
			const end = output.indexOf(10, at);
			if (end < 0) break;
			const [id, , size] = output.subarray(at, end).toString().split(" "), length = Number(size);
			if (!Number.isFinite(length)) break;
			result.set(id!, output.subarray(end + 1, end + 1 + length));
			at = end + 1 + length + 1;
		}
		return result;
	}
	/** The repository's current commit, read from its files rather than a git process. */
	head(): string | undefined {
		if (!this.repository) return;
		try {
			const value = readFileSync(join(this.repository, "HEAD"), "utf8").trim(), ref = /^ref:\s*(.+)$/.exec(value)?.[1];
			if (!ref) return /^[0-9a-f]{40,64}$/.test(value) ? value : undefined;
			const common = commonDir(this.repository);
			for (const folder of [this.repository, common]) try { return readFileSync(join(folder, ref), "utf8").trim(); } catch { /* Packed. */ }
			const line = readFileSync(join(common, "packed-refs"), "utf8").split("\n").find(entry => entry.endsWith(` ${ref}`));
			return line?.split(" ")[0];
		} catch { return; }
	}
}

export class ChangeTracker {
	private roots = new Map<string, Root>();
	private calls = new Map<string, Call>();
	/** Changes found when no call was running, reported with the next call. */
	private meanwhile: Seen = new Map();
	private session = "";
	private readonly store: string;
	private readonly agentDir: string;
	private readonly temporary: string[];
	private readonly watching: boolean;
	private readonly grace: string;
	/**
	 * watch: follow folders with the system's change notices. On by default on Windows and macOS, where they are native
	 * and where starting a process costs most; Linux starts git in a couple of milliseconds.
	 * grace: how long superseded versions survive before collection (git's --prune date).
	 */
	constructor(store: string, agentDir: string, temporary = SCRATCH, options: { watch?: boolean; grace?: string } = {}) {
		this.store = store; this.agentDir = agentDir; this.temporary = temporary;
		this.watching = options.watch ?? (process.platform === "win32" || process.platform === "darwin");
		this.grace = options.grace ?? GRACE;
	}

	/** Stops following folders; an open watch would keep a folder from being deleted on Windows. */
	close(): void {
		for (const root of this.roots.values()) { root.close(); root.release(); }
		this.roots.clear(); this.calls.clear(); this.meanwhile = new Map(); this.session = "";
	}
	/** Deletes superseded versions in every folder followed now and packs the rest; returns when done. */
	async collect(): Promise<void> {
		if (!this.calls.size) for (const root of this.roots.values()) root.letGo();
		await Promise.all([...this.roots.values()].filter(root => !root.broken).map(root => root.collect(this.grace)));
	}
	/**
	 * Removes Desk's stores for folders no conversation has used for a month, and the snapshots of conversations that
	 * ended without closing (a crash) a week ago.
	 */
	prune(): void {
		try {
			for (const name of readdirSync(this.store)) {
				const folder = join(this.store, name);
				const indexes = readdirSync(folder).filter(file => file.startsWith("index-"));
				const used = Math.max(statSync(folder).mtimeMs, ...indexes.map(file => statSync(join(folder, file)).mtimeMs));
				// A store whose setup never finished holds nothing.
				if (!existsSync(join(folder, "root")) && !indexes.length && Date.now() - used > 3_600_000) { rmSync(folder, { recursive: true, force: true }); continue; }
				if (Date.now() - used > 30 * 86_400_000) { rmSync(folder, { recursive: true, force: true }); continue; }
				for (const index of indexes) {
					if (index === "index-last" || Date.now() - statSync(join(folder, index)).mtimeMs < 7 * 86_400_000) continue;
					rmSync(join(folder, index), { force: true }); rmSync(join(folder, "refs", "desk", index.slice(6)), { force: true });
				}
			}
		} catch { /* Nothing kept yet. */ }
	}
	private async root(path: string, explicit: boolean): Promise<Root | undefined> {
		const repository = repositoryOf(path);
		const top = repository ?? (explicit ? path : undefined);
		// A folder that does not exist yet (a command about to create it, or an unexpanded variable) is followed by a
		// later call, once it does; it is not remembered as unusable.
		if (top && !existsSync(top)) return;
		// A folder holding Pi's own state (conversations, caches) is never followed as a whole.
		if (!top || scratch(top, this.agentDir, this.temporary) || within(this.agentDir, top) || (!repository && broad(top, this.agentDir, this.temporary))) return;
		const known = this.roots.get(top);
		if (known) return known.broken ? undefined : known;
		if (this.roots.size >= ROOTS) return;
		const root = new Root(top, this.store, this.session);
		this.roots.set(top, root);
		try { if (!await root.serial(() => root.prepare(this.agentDir, this.temporary))) root.broken = true; } catch { root.broken = true; }
		if (root.broken) return;
		if (this.watching) root.watch();
		return root;
	}
	/** Snapshot every followed folder; whatever changed since the last snapshot goes to the calls running now. */
	private async advance(running: Call[]): Promise<void> {
		await Promise.all([...this.roots.values()].filter(root => !root.broken).map(root => root.serial(async () => {
			// A watched folder that reported nothing is as it was at the last snapshot.
			if (root.watching && !root.dirty && root.last) return;
			root.dirty = false;
			try {
				const tree = await root.snapshot();
				const delta = root.last && tree !== root.last ? await root.delta(root.last, tree) : new Map<string, Delta>();
				for (const [name, change] of delta) {
					const path = join(root.path, name);
					for (const seen of running.length ? running.map(call => call.seen) : [this.meanwhile]) {
						const known = seen.get(path);
						if (known) known.after = change.after;
						else seen.set(path, { ...change, root, ...(running.length ? {} : { meanwhile: true as const }) });
					}
				}
				if (tree !== root.last) {
					// The replaced snapshot holds the earlier versions the calls running now will show.
					if (root.last) root.hold(root.last);
					root.pin(tree);
					root.note([...delta.values()].map(change => change.after));
					// Leftovers from earlier conversations are collected, and stored versions packed, when one starts here.
					if (root.writes++ === 0) void root.collect(this.grace);
				}
				root.last = tree;
			} catch { root.last = undefined; root.dirty = true; }
		})));
	}

	async start(id: string, text: string, cwd: string, session: string, workdir?: string): Promise<void> {
		if (session !== this.session) {
			for (const root of this.roots.values()) { root.close(); root.release(); }
			this.session = session; this.roots.clear(); this.calls.clear(); this.meanwhile = new Map();
		}
		const folder = workdir ? resolve(cwd, workdir) : cwd, named = mentioned(text, folder);
		// Folders a call works in are followed even without git; folders it only names are followed when they are repositories.
		for (const path of [cwd, folder, ...named.entered]) await this.root(path, !hidden(path));
		for (const path of [...named.folders, ...named.files.map(file => dirname(file))]) await this.root(path, false);
		const running = [...this.calls.values()];
		const opened = Date.now();
		await this.advance(running);
		const call: Call = { seen: new Map(), heads: new Map(), loose: new Map(), opened };
		// The changes made meanwhile are reported with this call.
		for (const [path, change] of this.meanwhile) call.seen.set(path, change);
		this.meanwhile = new Map();
		for (const root of this.roots.values()) if (!root.broken && root.repository) call.heads.set(root, await root.head());
		for (const file of named.files) {
			if (scratch(file, this.agentDir, this.temporary) || [...this.roots.values()].some(root => !root.broken && within(file, root.path))) continue;
			try { const stat = statSync(file); if (stat.isFile() && stat.size <= (filtered(file) ? OFFICE_LIMIT : TEXT_LIMIT)) call.loose.set(file, readFileSync(file)); }
			catch { call.loose.set(file, null); }
		}
		this.calls.set(id, call);
	}

	/**
	 * A call that never ran: Pi sends no tool_result for a call blocked before it started (by the command guard, say).
	 * What it collected goes back to the changes made meanwhile, and cleanup resumes once no call is running.
	 */
	abandon(id: string): void {
		const call = this.calls.get(id);
		if (!call) return;
		this.calls.delete(id);
		for (const [path, change] of call.seen) if (!this.meanwhile.has(path)) this.meanwhile.set(path, { ...change, meanwhile: true });
		if (!this.calls.size) for (const root of this.roots.values()) {
			root.letGo();
			if (root.pending > CLEANUP_BYTES) void root.prune(this.grace);
		}
	}

	async finish(id: string, own: string[] = []): Promise<CallChanges | undefined> {
		const call = this.calls.get(id);
		if (!call) return;
		// Change notices arrive a moment after the write; give the last ones time to land.
		if ([...this.roots.values()].some(root => root.watching)) await new Promise(done => setTimeout(done, 40));
		await this.advance([...this.calls.values()]);
		this.calls.delete(id);
		for (const [file, before] of call.loose) {
			let after: Buffer | null = null;
			try { after = readFileSync(file); } catch { /* Deleted or never created. */ }
			if (before === after || before && after && before.equals(after)) continue;
			call.seen.set(file, { before: null, after: null, loose: { before, after } });
		}
		const skip = new Set(own);
		const result: CallChanges = { files: [], documents: [] };
		const entries = [...call.seen].filter(([path, change]) => !skip.has(path) && (change.loose || change.before !== change.after));
		this.attribute(call, entries, Date.now());
		await this.separateGit(call, entries, result);
		const shown = entries.slice(0, MAX_FILES);
		if (entries.length > MAX_FILES) result.more = entries.slice(MAX_FILES).map(([path]) => path);
		// All the versions a call needs from one folder are read together.
		const contents = new Map<string, Buffer | "large">();
		for (const root of new Set(shown.flatMap(([, change]) => change.root ? [change.root] : []))) {
			const limits = new Map<string, number>();
			for (const [path, change] of shown) if (change.root === root) for (const id of [change.before, change.after]) if (id) limits.set(id, filtered(path) ? OFFICE_LIMIT : TEXT_LIMIT);
			try { for (const [id, value] of await root.serial(() => root.contents(limits))) contents.set(id, value); } catch { /* Described as unreadable below. */ }
		}
		for (const [path, change] of shown) {
			try { this.describe(path, change, contents, result); } catch { result.files.push({ path, action: "updated", note: "Changed; its contents could not be read." }); }
		}
		// With no call running, only the newest snapshot is needed: superseded versions go once they amount to something.
		if (!this.calls.size) for (const root of this.roots.values()) {
			root.letGo();
			if (root.pending > CLEANUP_BYTES) void root.prune(this.grace);
		}
		return result.files.length || result.documents.length || result.fromGit || result.more ? result : undefined;
	}

	/**
	 * Leaves out what another conversation working in the same folder changed. Every conversation snapshots around its
	 * own calls, so each change is credited to the narrowest call around it: a quick edit made while another
	 * conversation's long command ran belongs to the edit, not the command. Changes found between calls belong to
	 * whichever conversation claimed them. This call's own changes are then claimed for the others to see.
	 */
	private attribute(call: Call, entries: [string, Change][], closed: number): void {
		const me = safeName(this.session), now = Date.now();
		for (const root of new Set(entries.flatMap(([, change]) => change.root ? [change.root] : []))) {
			const file = join(root.gitDir, "claims"), name = (path: string) => relative(root.path, path).split(sep).join("/");
			let claims: Claim[] = [];
			try {
				claims = readFileSync(file, "utf8").split("\n").flatMap(line => {
					try { const claim = JSON.parse(line) as Claim; return claim?.s !== me && claim.b > now - CLAIMS_KEPT && claim.f ? [claim] : []; } catch { return []; }
				});
			} catch { /* No other conversation has claimed anything here. */ }
			const theirs = (path: string, change: Change) => claims.some(claim => Object.hasOwn(claim.f, name(path)) && claim.f[name(path)] === change.after
				&& (change.meanwhile || claim.a >= call.opened && claim.b <= closed));
			const own: [string, Change][] = [];
			for (let index = entries.length - 1; index >= 0; index--) {
				const [path, change] = entries[index]!;
				if (change.root !== root) continue;
				if (theirs(path, change)) entries.splice(index, 1); else if (!change.meanwhile) own.push([path, change]);
			}
			if (!own.length) continue;
			try {
				// Only the last hour matters; older claims are dropped when the file grows.
				if (existsSync(file) && statSync(file).size > 256 * 1024) {
					const recent = readFileSync(file, "utf8").split("\n").filter(line => { try { return (JSON.parse(line) as Claim).b > now - CLAIMS_KEPT; } catch { return false; } });
					writeFileSync(`${file}.tmp`, recent.map(line => `${line}\n`).join("")); renameSync(`${file}.tmp`, file);
				}
				appendFileSync(file, `${JSON.stringify({ s: me, a: call.opened, b: closed, f: Object.fromEntries(own.map(([path, change]) => [name(path), change.after])) } satisfies Claim)}\n`);
			} catch { /* Other conversations then credit these changes by their own calls only. */ }
		}
	}

	/** Files a pull, checkout, rebase or reset brought match the new commit exactly; they are counted, not shown. */
	private async separateGit(call: Call, entries: [string, Change][], result: CallChanges): Promise<void> {
		for (const [root, start] of call.heads) {
			const end = await root.head();
			if (!start || !end || start === end) continue;
			const local = new Set<string>();
			try {
				const log = (await root.git(["reflog", "-n", "50", "--format=%H%x09%gs"], { repository: true })).toString("utf8").split("\n");
				for (const line of log) {
					const [commit, subject = ""] = line.split("\t");
					if (!commit || commit === start) break;
					if (/^commit\b/.test(subject)) for (const name of (await root.git(["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", commit], { repository: true })).toString("utf8").split("\0"))
						if (name) local.add(join(root.path, name));
				}
			} catch { continue; }
			const names = entries.filter(([path, change]) => change.root === root && !local.has(path) && !change.meanwhile).map(([path]) => relative(root.path, path).split(sep).join("/"));
			if (!names.length) continue;
			const blobs = async (commit: string) => new Map((await root.git(["ls-tree", "-r", "-z", commit, "--", ...names.map(name => `:(literal)${name}`)], { repository: true }))
				.toString("utf8").split("\0").filter(Boolean).map(line => { const [meta, name] = line.split("\t"); return [name!, meta!.split(" ")[2]!] as const; }));
			let before: Map<string, string>, after: Map<string, string>;
			try { [before, after] = await Promise.all([blobs(start), blobs(end)]); } catch { continue; }
			let count = 0;
			for (let index = entries.length - 1; index >= 0; index--) {
				const [path, change] = entries[index]!;
				if (change.root !== root || local.has(path) || change.meanwhile) continue;
				const name = relative(root.path, path).split(sep).join("/");
				if ((before.get(name) ?? null) === change.before && (after.get(name) ?? null) === change.after) { entries.splice(index, 1); count++; }
			}
			if (count) result.fromGit = { root: root.path, count: (result.fromGit?.count ?? 0) + count, from: start.slice(0, 7), to: end.slice(0, 7) };
		}
	}

	private describe(path: string, change: Change, contents: Map<string, Buffer | "large">, result: CallChanges): void {
		const stored = (id: string | null) => { if (!id) return null; const value = contents.get(id); if (value === undefined) throw new Error("Unreadable."); return value; };
		const before = change.loose ? change.loose.before : stored(change.before);
		const after = change.loose ? change.loose.after : stored(change.after);
		const action = before === null ? "added" : after === null ? "deleted" : "updated";
		const base = { path, action, ...(change.meanwhile ? { meanwhile: true as const } : {}) } satisfies Partial<FileChange>;
		if (action === "deleted" && before === "large") { result.files.push({ ...base, note: "Large file deleted." }); return; }
		if (before === "large" || after === "large") { result.files.push({ ...base, note: "Large file changed; too big to compare." }); return; }
		// Stored versions are content or fingerprints; a repository's own versions and named files are the files themselves.
		const old: Version | null = before && readVersion(before, path), now: Version | null = after && readVersion(after, path);
		if (now?.type === "office" && (!old || old.type === "office")) { result.documents.push({ path, before: old?.document ?? null, after: now.document }); return; }
		if (old?.type === "office" && !now) { result.files.push({ ...base, note: "Document deleted." }); return; }
		if (old?.type !== "text" || now?.type !== "text") {
			const hash = (version: Version | null) => version?.type === "file" ? version.hash : version?.type === "text" ? createHash("sha256").update(version.data).digest("hex") : undefined;
			if (old && now && old.type !== "office" && now.type !== "office" && hash(old) === hash(now)) return;
			const size = now?.type === "file" ? now.size : now?.type === "text" ? now.data.length : undefined;
			result.files.push({ ...base, note: `${now?.type === "office" || old?.type === "office" ? "Document" : "Binary file"} ${action === "added" ? "created" : action}${size !== undefined ? ` (${size.toLocaleString("en")} bytes)` : ""}.` });
			return;
		}
		const diff = lineDiff(old?.data.toString("utf8") ?? "", now?.data.toString("utf8") ?? "");
		if (!diff) { if (action !== "updated") result.files.push({ ...base, note: action === "added" ? "Empty file created." : "Empty file deleted." }); return; }
		result.files.push({ ...base, diff: diff.text.slice(0, DIFF_CHARS), added: diff.added, removed: diff.removed,
			...(diff.truncated || diff.text.length > DIFF_CHARS ? { truncated: true } : {}) });
	}
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { officeKind } from "./documents.ts";
import { lineDiff } from "./sequence-diff.ts";

/**
 * Every file a tool call changed, however it changed it: a script, sed, a build, a background process.
 *
 * Each folder a conversation works in is snapshotted into Desk's own git object store before and after each call
 * (`git add -A` into a private index, then `write-tree`), the way Jujutsu snapshots its working copy. The user's
 * repository, index and branches are never written; its objects are shared read-only through alternates, so a
 * snapshot stores only files that differ from it. Snapshots are chained, so changes made while no call was running
 * are reported with the next call as made meanwhile. Files a call names outside those folders are compared directly.
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
	/** Office files, as raw contents for the document diff. */
	documents: { path: string; before: Buffer | null; after: Buffer }[];
	/** Files a git pull, checkout, rebase or reset brought, summarised instead of shown. */
	fromGit?: { root: string; count: number; from: string; to: string };
	/** Changed files beyond the shown limit. */
	more?: string[];
};

type Delta = { before: string | null; after: string | null };
type Change = Delta & { root?: Root; loose?: { before: Buffer | null; after: Buffer | null }; meanwhile?: true };
type Seen = Map<string, Change>;
type Call = { seen: Seen; heads: Map<Root, string | undefined>; loose: Map<string, Buffer | null> };

const MAX_FILES = 40, TEXT_LIMIT = 2 * 1024 * 1024, DIFF_CHARS = 64_000, OFFICE_LIMIT = 64 * 1024 * 1024;
const ROOT_FILES = 20_000, ROOT_BYTES = 1024 ** 3, BIG_FILE = 32 * 1024 * 1024, ROOTS = 12, LOOSE = 32;
/** Tools that never write files; every other call is watched. */
export const READ_ONLY = new Set(["read", "grep", "find", "ls", "web_search", "read_artifact", "view_image", "get_plan", "inspect_files",
	"agent_discover", "list_agents", "quest_list", "ask_user", "tool_search", "chrome_devtools_load"]);
const DEFAULT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", ".cache/", ".pytest_cache/", ".mypy_cache/", ".DS_Store", ".git/"];
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
	private queue: Promise<unknown> = Promise.resolve();
	readonly path: string;
	readonly gitDir: string;
	readonly index: string;
	readonly repository?: string;
	constructor(path: string, store: string, session: string) {
		this.path = path;
		this.gitDir = join(store, createHash("sha256").update(path).digest("hex").slice(0, 24));
		this.index = join(this.gitDir, `index-${session}`);
		this.repository = gitDirOf(path);
	}
	git(args: string[], options: { work?: boolean; repository?: boolean } = {}): Promise<Buffer> {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
		for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"]) delete env[name];
		if (options.repository) env.GIT_DIR = this.repository;
		else { env.GIT_DIR = this.gitDir; env.GIT_INDEX_FILE = this.index; if (options.work !== false) env.GIT_WORK_TREE = this.path; }
		return new Promise((done, fail) => execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "gc.auto=0",
			"-c", "maintenance.auto=false", "-c", "advice.addEmbeddedRepo=false", ...args],
			{ env, cwd: this.path, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 60_000, windowsHide: true },
			(error, stdout) => error ? fail(error) : done(stdout)));
	}
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
			if (own) {
				let objects = join(own, "objects");
				try { objects = join(resolve(own, readFileSync(join(own, "commondir"), "utf8").trim()), "objects"); } catch { /* Not a linked worktree. */ }
				writeFileSync(join(this.gitDir, "objects", "info", "alternates"), `${objects}\n`);
			}
			let excludes = DEFAULT_EXCLUDES.join("\n");
			try { if (this.repository) excludes += `\n${readFileSync(join(this.repository, "info", "exclude"), "utf8")}`; } catch { /* None. */ }
			writeFileSync(join(this.gitDir, "info", "exclude"), `${excludes}\n`);
			writeFileSync(join(this.gitDir, "root"), this.path);
		}
		if (!existsSync(this.index)) {
			// The repository's own index is a warm stat cache: only files that differ from it are hashed.
			if (this.repository) try { copyFileSync(join(this.repository, "index"), this.index); } catch { /* A repository without commits. */ }
			const untracked = (await this.git(["ls-files", "-o", "-z", "--exclude-standard"])).toString("utf8").split("\0").filter(Boolean);
			if (untracked.length > ROOT_FILES) return false;
			let bytes = 0;
			const big: string[] = [];
			for (const name of untracked) {
				try { const size = statSync(join(this.path, name)).size; bytes += size; if (size > BIG_FILE) big.push(`/${name.replace(/([*?[\\])/g, "\\$1")}`); } catch { /* Gone. */ }
			}
			if (bytes - big.length * BIG_FILE > ROOT_BYTES) return false;
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
	async blob(id: string | null, limit: number): Promise<Buffer | null | "large"> {
		if (!id) return null;
		const size = Number((await this.git(["cat-file", "-s", id], { work: false })).toString().trim());
		return size > limit ? "large" : await this.git(["cat-file", "blob", id], { work: false });
	}
	async head(): Promise<string | undefined> {
		if (!this.repository) return;
		try { return (await this.git(["rev-parse", "-q", "--verify", "HEAD"], { repository: true })).toString().trim() || undefined; } catch { return; }
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
	constructor(store: string, agentDir: string, temporary = SCRATCH) {
		this.store = store; this.agentDir = agentDir; this.temporary = temporary;
	}

	/** Removes Desk's stores for folders no conversation has used for a month. */
	prune(): void {
		try {
			for (const name of readdirSync(this.store)) {
				const folder = join(this.store, name);
				const used = Math.max(statSync(folder).mtimeMs, ...readdirSync(folder).filter(file => file.startsWith("index-")).map(file => statSync(join(folder, file)).mtimeMs));
				if (Date.now() - used > 30 * 86_400_000) rmSync(folder, { recursive: true, force: true });
			}
		} catch { /* Nothing kept yet. */ }
	}
	private async root(path: string, explicit: boolean): Promise<Root | undefined> {
		const repository = repositoryOf(path);
		const top = repository ?? (explicit ? path : undefined);
		if (!top || scratch(top, this.agentDir, this.temporary) || (!repository && broad(top, this.agentDir, this.temporary))) return;
		const known = this.roots.get(top);
		if (known) return known.broken ? undefined : known;
		if (this.roots.size >= ROOTS) return;
		const root = new Root(top, this.store, this.session);
		this.roots.set(top, root);
		try { if (!await root.serial(() => root.prepare(this.agentDir, this.temporary))) root.broken = true; } catch { root.broken = true; }
		return root.broken ? undefined : root;
	}
	/** Snapshot every followed folder; whatever changed since the last snapshot goes to the calls running now. */
	private async advance(running: Call[]): Promise<void> {
		await Promise.all([...this.roots.values()].filter(root => !root.broken).map(root => root.serial(async () => {
			try {
				const tree = await root.snapshot();
				if (root.last && tree !== root.last) {
					const delta = await root.delta(root.last, tree);
					for (const [name, change] of delta) {
						const path = join(root.path, name);
						for (const seen of running.length ? running.map(call => call.seen) : [this.meanwhile]) {
							const known = seen.get(path);
							if (known) known.after = change.after;
							else seen.set(path, { ...change, root, ...(running.length ? {} : { meanwhile: true as const }) });
						}
					}
				}
				root.last = tree;
			} catch { root.last = undefined; }
		})));
	}

	async start(id: string, text: string, cwd: string, session: string, workdir?: string): Promise<void> {
		if (session !== this.session) { this.session = session; this.roots.clear(); this.calls.clear(); this.meanwhile = new Map(); }
		const folder = workdir ? resolve(cwd, workdir) : cwd, named = mentioned(text, folder);
		// Folders a call works in are followed even without git; folders it only names are followed when they are repositories.
		for (const path of [cwd, folder, ...named.entered]) await this.root(path, !hidden(path));
		for (const path of [...named.folders, ...named.files.map(file => dirname(file))]) await this.root(path, false);
		const running = [...this.calls.values()];
		await this.advance(running);
		const call: Call = { seen: new Map(), heads: new Map(), loose: new Map() };
		// The changes made meanwhile are reported with this call.
		for (const [path, change] of this.meanwhile) call.seen.set(path, change);
		this.meanwhile = new Map();
		for (const root of this.roots.values()) if (!root.broken && root.repository) call.heads.set(root, await root.head());
		for (const file of named.files) {
			if (scratch(file, this.agentDir, this.temporary) || [...this.roots.values()].some(root => !root.broken && within(file, root.path))) continue;
			try { const stat = statSync(file); if (stat.isFile() && stat.size <= (officeKind(file) ? OFFICE_LIMIT : TEXT_LIMIT)) call.loose.set(file, readFileSync(file)); }
			catch { call.loose.set(file, null); }
		}
		this.calls.set(id, call);
	}

	async finish(id: string, own: string[] = []): Promise<CallChanges | undefined> {
		const call = this.calls.get(id);
		if (!call) return;
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
		await this.separateGit(call, entries, result);
		for (const [path, change] of entries) {
			if (result.files.length + result.documents.length >= MAX_FILES) { (result.more ??= []).push(path); continue; }
			try { await this.describe(path, change, result); } catch { result.files.push({ path, action: "updated", note: "Changed; its contents could not be read." }); }
		}
		return result.files.length || result.documents.length || result.fromGit || result.more ? result : undefined;
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

	private async describe(path: string, change: Change, result: CallChanges): Promise<void> {
		const office = !!officeKind(path), limit = office ? OFFICE_LIMIT : TEXT_LIMIT;
		const before = change.loose ? change.loose.before : await change.root!.blob(change.before, limit);
		const after = change.loose ? change.loose.after : await change.root!.blob(change.after, limit);
		const action = before === null ? "added" : after === null ? "deleted" : "updated";
		const base = { path, action, ...(change.meanwhile ? { meanwhile: true as const } : {}) } satisfies Partial<FileChange>;
		if (action === "deleted" && before === "large") { result.files.push({ ...base, note: "Large file deleted." }); return; }
		if (before === "large" || after === "large") { result.files.push({ ...base, note: "Large file changed; too big to compare." }); return; }
		if (office && after) { result.documents.push({ path, before, after }); return; }
		if (before && !textual(before) || after && !textual(after)) {
			result.files.push({ ...base, note: `Binary file ${action === "added" ? "created" : action}${after ? ` (${after.length.toLocaleString("en")} bytes)` : ""}.` });
			return;
		}
		const diff = lineDiff(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
		if (!diff) { if (action !== "updated") result.files.push({ ...base, note: action === "added" ? "Empty file created." : "Empty file deleted." }); return; }
		result.files.push({ ...base, diff: diff.text.slice(0, DIFF_CHARS), added: diff.added, removed: diff.removed,
			...(diff.truncated || diff.text.length > DIFF_CHARS ? { truncated: true } : {}) });
	}
}

import { readdir, realpath, stat, open } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FOLDER_PAGE_SIZE, type FolderPage, type FolderPlaces, type RecentProject } from "../shared/folders.ts";
import { folderPath, localPath } from "./local-path.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { parseSessionHeader } from "./session-files.ts";

const execute = promisify(execFile);
const location = (path: string) => ({ path, name: basename(path) || path });
const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
async function parallel<T, R>(values: T[], work: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
		while (next < values.length) { const index = next++; results[index] = await work(values[index]!); }
	}));
	return results;
}

/** Read-only, selected-host browsing. Native history is sampled by header, never loaded as conversations. */
export class Folders {
	private discovered?: { until: number; value: Promise<RecentProject[]> };
	private drives?: { until: number; value: Promise<{ roots: string[]; warning?: string }> };
	private options: {
		cwd: string; agentDir: string; sessionDir?: string;
		recent: () => RecentProject[]; directories: () => string[];
	};
	constructor(options: Folders["options"]) { this.options = options; }

	async page({ path = this.options.cwd, query = "", hidden = false, offset = 0 }: {
		path?: string; query?: string; hidden?: boolean; offset?: number;
	}): Promise<FolderPage> {
		if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid folder query.");
		const current = await realpath(folderPath(path, this.options.cwd));
		if (!localPath(current)) throw new Error("Network and device paths cannot be browsed here.");
		const names = await readdir(current, { withFileTypes: true });
		const match = query.toLocaleLowerCase();
		const candidates = names.filter(entry => (hidden || !entry.name.startsWith("."))
			&& entry.name.toLocaleLowerCase().includes(match) && (entry.isDirectory() || entry.isSymbolicLink()));
		const directories = (await parallel(candidates, async entry => {
			const path = join(current, entry.name);
			if (!localPath(path)) return;
			if (entry.isSymbolicLink()) {
				try {
					const target = await realpath(path);
					if (!localPath(target) || !(await stat(target)).isDirectory()) return;
				} catch { return; }
			}
			return { name: entry.name, path, ...(entry.isSymbolicLink() ? { link: true } : {}) };
		})).filter((value): value is NonNullable<typeof value> => !!value)
			.sort((a, b) => order.compare(a.name, b.name) || a.name.localeCompare(b.name));
		const folders: FolderPage["folders"] = [];
		let bytes = 0;
		for (const folder of directories.slice(offset, offset + FOLDER_PAGE_SIZE)) {
			const size = JSON.stringify(folder).length * 2;
			if (folders.length && bytes + size > 64_000) break;
			folders.push(folder); bytes += size;
		}
		const breadcrumbs = [];
		for (let path = current; breadcrumbs.length < 12; path = dirname(path)) {
			breadcrumbs.unshift(location(path));
			if (path === dirname(path)) break;
		}
		const root = parse(current).root;
		if (breadcrumbs[0]!.path !== root) breadcrumbs.unshift(location(root));
		return { path: current, parent: dirname(current) === current ? undefined : dirname(current),
			breadcrumbs, folders, offset, total: directories.length,
			...(offset + folders.length < directories.length ? { next: offset + folders.length } : {}) };
	}

	async places(): Promise<FolderPlaces> {
		if (!this.discovered || this.discovered.until < Date.now()) this.discovered = {
			until: Date.now() + 300_000, value: this.nativeProjects(),
		};
		const native = await this.discovered.value;
		const projects = new Map<string, RecentProject>();
		for (const entry of [...native, ...this.options.recent()]) {
			if (!entry.path || entry.path.length > 4000 || !localPath(entry.path)) continue;
			const key = identity(entry.path), old = projects.get(key);
			if (!old || entry.modified > old.modified) projects.set(key, entry);
		}
		const roots = [...new Set([parse(homedir()).root, parse(this.options.cwd).root])];
		return {
			locations: [{ name: "Home", path: homedir() }, { name: "Default project", path: this.options.cwd },
				...roots.map(path => ({ path, name: process.platform === "win32" ? `Drive ${path.slice(0, 2)}` : "File system" }))],
			projects: [...projects.values()].sort((a, b) => b.modified - a.modified).slice(0, 32).map(value => location(value.path)),
		};
	}

	async volumes(): Promise<Pick<FolderPlaces, "locations" | "warning">> {
		if (!this.drives || this.drives.until < Date.now()) this.drives = {
			until: Date.now() + 300_000, value: this.driveRoots(),
		};
		const { roots, warning } = await this.drives.value;
		return { locations: roots.map(path => ({ path, name: process.platform === "win32" ? `Drive ${path.slice(0, 2)}` : "File system" })), warning };
	}

	private async driveRoots(): Promise<{ roots: string[]; warning?: string }> {
		if (process.platform !== "win32") return { roots: ["/"] };
		try {
			const { stdout } = await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
					`Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2 OR DriveType=3 OR DriveType=5' | ForEach-Object { $_.DeviceID + '\\' } | ConvertTo-Json -Compress`],
				{ windowsHide: true, timeout: 8000, maxBuffer: 16_384 });
			const value: unknown = stdout.trim() ? JSON.parse(stdout) : [];
			return { roots: (Array.isArray(value) ? value : [value]).filter((path): path is string => typeof path === "string" && /^[a-z]:\\$/i.test(path)) };
		} catch { return { roots: [], warning: "The drive list is unavailable. Home and recent projects are still available." }; }
	}

	private async nativeProjects(): Promise<RecentProject[]> {
		const root = join(this.options.agentDir, "sessions");
		const directories = new Map<string, boolean>();
		try {
			// One header per ordinary Pi project directory; no path-name decoding.
			const children = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
			const dated = await parallel(children, async entry => {
				const path = join(root, entry.name);
				return { path, modified: await stat(path).then(value => value.mtimeMs, () => 0) };
			});
			for (const child of dated.sort((a, b) => b.modified - a.modified).slice(0, 64)) directories.set(child.path, false);
		} catch { /* The native session directory may not exist yet. */ }
		const custom = configuredSessionDirectory(this.options.cwd, this.options.agentDir, this.options.sessionDir);
		if (custom) directories.set(custom, true);
		for (const directory of this.options.directories()) if (!directories.has(directory)) directories.set(directory, true);
		const groups = await parallel([...directories].slice(0, 80), async ([directory, mixed]) => {
			try {
				const files = (await readdir(directory, { withFileTypes: true }))
					.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name).sort().reverse();
				const values: RecentProject[] = [];
				// Custom session directories can contain multiple working directories.
				for (const name of files.slice(0, mixed ? 64 : 3)) {
					let file;
					try {
						file = await open(join(directory, name), "r");
						const bytes = Buffer.alloc(65_536), { bytesRead } = await file.read(bytes);
						const header = parseSessionHeader(bytes.subarray(0, bytesRead).toString("utf8"));
						if (!localPath(header.cwd)) continue;
						values.push({ path: header.cwd, modified: (await file.stat()).mtimeMs });
						if (!mixed) break;
					} catch { /* Skip incomplete or unreadable native files. */ }
					finally { await file?.close(); }
				}
				return values;
			} catch { return []; }
		});
		return groups.flat();
	}
}

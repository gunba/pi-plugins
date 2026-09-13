import { execFile } from "node:child_process";
import { lstat, open, readlink, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";

const execute = promisify(execFile);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export interface FileDocument {
	path: string;
	text: string;
	binary: boolean;
	missing: boolean;
}
export interface Change {
	path: string;
	status: string;
	previousPath?: string;
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return join(await canonicalPath(dirname(path)), path.slice(dirname(path).length + 1));
	}
}

export function fileLocation(value: string, cwd: string): { path: string; line: number } {
	const unquoted = value.replace(/^"(.*)"$/, "$1");
	const match = /^(.*?):(\d+)(?::\d+)?$/.exec(unquoted);
	const path = match?.[1] ?? unquoted;
	return {
		path: resolve(
			cwd,
			path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path,
		),
		line: Math.max(1, Number(match?.[2] ?? 1)),
	};
}

export async function readDocument(path: string): Promise<FileDocument> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { path, text: "", missing: true, binary: false };
		throw error;
	}
	if (info.isSymbolicLink())
		return { path, text: `Symbolic link → ${await readlink(path)}`, binary: false, missing: false };
	if (!info.isFile()) throw Error("Choose a file to read.");
	if (info.size > MAX_FILE_BYTES)
		throw Error(`File exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MiB reader limit.`);
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > MAX_FILE_BYTES) throw Error("File grew beyond the reader limit.");
		const data = buffer.subarray(0, size);
		return {
			path,
			text: data.toString("utf8").replace(/\r\n/g, "\n"),
			binary: data.includes(0),
			missing: false,
		};
	} finally {
		await handle.close();
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execute("git", ["--no-optional-locks", "-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 4 * MAX_FILE_BYTES,
		timeout: 15_000,
	});
	return stdout;
}

export class FileRepository {
	readonly cwd: string;
	constructor(cwd: string) {
		this.cwd = cwd;
	}
	async root(): Promise<string | undefined> {
		try {
			return await realpath((await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim());
		} catch (error) {
			if (String((error as { stderr?: string }).stderr).includes("not a git repository")) return;
			throw error;
		}
	}
	async changes(): Promise<Change[]> {
		const root = await this.root();
		if (!root) return [];
		const fields = (
			await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
		).split("\0");
		const result: Change[] = [];
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i]!;
			if (!field) continue;
			const status = field.slice(0, 2);
			const previousPath = /[RC]/.test(status) ? fields[++i] : undefined;
			result.push({
				path: resolve(root, field.slice(3)),
				status,
				...(previousPath ? { previousPath: resolve(root, previousPath) } : {}),
			});
		}
		return result;
	}
	async directory(path = this.cwd): Promise<{ path: string; directory: boolean }[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter((e) => e.name !== ".git")
			.map((e) => ({ path: join(path, e.name), directory: e.isDirectory() }))
			.sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
	}
	async diff(path: string, previousPath?: string): Promise<string> {
		const root = await this.root();
		if (!root) throw Error("This directory is not a Git repository. Use the file reader here.");
		// Canonicalize the directory (including Windows short paths), preserving
		// the final directory entry so Git symlinks are compared as links.
		const name = relative(root, join(await canonicalPath(dirname(path)), basename(path)))
			.split(sep)
			.join("/");
		if (name.startsWith("../") || isAbsolute(name))
			throw Error("The file is outside this Git repository.");
		const oldName = previousPath
			? relative(root, join(await canonicalPath(dirname(previousPath)), basename(previousPath)))
					.split(sep)
					.join("/")
			: name;
		if (oldName.startsWith("../") || isAbsolute(oldName))
			throw Error("The previous file is outside this Git repository.");
		const document = await readDocument(path);
		if (document.binary) return "Binary file — a text diff is unavailable.";
		let before = "";
		let hasHead = true;
		try {
			await git(root, ["rev-parse", "--verify", "HEAD"]);
		} catch (error) {
			if ((error as { code?: number }).code === 128) hasHead = false;
			else throw error;
		}
		if (hasHead) {
			const tracked = await git(root, ["ls-tree", "-z", "--name-only", "HEAD", "--", oldName]);
			if (tracked) before = await git(root, ["show", `HEAD:${oldName}`]);
		}
		if (before.includes("\0")) return "Binary file — a text diff is unavailable.";
		before = before.replace(/\r\n/g, "\n");
		if (!document.missing && (await lstat(path)).isSymbolicLink())
			document.text = await readlink(path);
		if (before === document.text) return "No changes against HEAD.";
		const patch = createTwoFilesPatch(
			oldName,
			name,
			before,
			document.text,
			"HEAD",
			"Working tree",
			{
				context: 4,
				timeout: 1000,
				maxEditLength: 10_000,
			},
		);
		if (patch === undefined)
			throw Error(
				"This diff exceeds the interactive computation budget. Open the file in Read view.",
			);
		return patch;
	}
}

export function toolPaths(name: string, args: Record<string, unknown>, cwd: string): string[] {
	if (["read", "edit", "write"].includes(name) && typeof args.path === "string")
		return [resolve(cwd, args.path)];
	if (name !== "apply_patch") return [];
	const patch =
		typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : "";
	return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
		resolve(cwd, match[1]!.trim()),
	);
}

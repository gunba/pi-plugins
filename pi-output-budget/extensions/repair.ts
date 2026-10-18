import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Suggestions added to a failed tool result, so the next step fixes the call rather than searching for the cause.
 * They are suggestions only: nothing is redirected or retried silently.
 */

export function gitRoot(path: string): string | undefined {
	for (let folder = path; ; folder = dirname(folder)) {
		if (existsSync(join(folder, ".git"))) return folder;
		if (dirname(folder) === folder) return;
	}
}
function nearestExisting(path: string): string {
	let folder = path;
	while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
	return folder;
}
// Asynchronous: a large repository must not stall the conversation's process while git lists it.
const tracked = (root: string, name: string): Promise<string[]> => new Promise(done =>
	execFile("git", ["-C", root, "ls-files", "--", `*/${name}`, name], { encoding: "utf8", timeout: 2000, maxBuffer: 1 << 20 },
		(error, stdout) => done(error ? [] : stdout.split("\n").filter(Boolean).slice(0, 5).map(file => join(root, file)))));

/** "Not found at X; it exists at Y": the same relative path under the folders the conversation uses, or files of that name. */
export async function missingPathHint(path: string, cwd: string, roots: readonly string[]): Promise<string | undefined> {
	if (!path || /[\0\n]/.test(path)) return;
	const wanted = resolve(cwd, path), anchor = gitRoot(nearestExisting(wanted)) ?? cwd;
	const rel = isAbsolute(path) ? relative(anchor, wanted) : path;
	const tails = rel && !rel.startsWith("..") ? [rel] : [];
	const folders = [...new Set([cwd, gitRoot(cwd), ...roots].filter((folder): folder is string => !!folder))];
	for (const tail of tails) for (const folder of folders) {
		const candidate = resolve(folder, tail);
		if (candidate !== wanted && existsSync(candidate)) return `Not found at ${wanted}; it exists at ${candidate}.`;
	}
	const root = gitRoot(cwd) ?? gitRoot(nearestExisting(wanted));
	const named = root && basename(wanted) ? (await tracked(root, basename(wanted))).filter(file => file !== wanted) : [];
	return named.length ? `Not found at ${wanted}. Files named ${basename(wanted)} in ${root}: ${named.map(file => relative(root!, file)).join(", ")}.` : undefined;
}

const numbered = (lines: string[], first: number) => lines.map((line, index) => `${String(first + index + 1).padStart(5)} ${line}`).join("\n");
/** Lines where the text starts, for a match that was not unique. */
export function occurrenceLines(content: string, text: string): number[] {
	const lines: number[] = [];
	for (let at = content.indexOf(text); at >= 0 && lines.length < 20; at = content.indexOf(text, at + 1))
		lines.push(content.slice(0, at).split("\n").length);
	return lines;
}
/** The region of the file most like the text that was not found, with line numbers. */
export function closestRegion(content: string, text: string): string | undefined {
	const file = content.split("\n"), wanted = text.replace(/\r\n/g, "\n").split("\n");
	const key = (line: string) => line.trim();
	const index = new Map<string, number[]>();
	file.forEach((line, at) => { const value = key(line); if (value.length > 3) index.set(value, [...index.get(value) ?? [], at]); });
	// Each wanted line votes for where the region would start if it is found unchanged.
	const votes = new Map<number, number>();
	wanted.forEach((line, offset) => { for (const at of index.get(key(line)) ?? []) votes.set(at - offset, (votes.get(at - offset) ?? 0) + 1); });
	let start = -1, best = 0;
	for (const [at, count] of votes) if (count > best) { best = count; start = at; }
	if (start < 0 || best < Math.max(1, Math.ceil(wanted.filter(line => key(line).length > 3).length / 4))) return;
	const from = Math.max(0, start), to = Math.min(file.length, start + wanted.length);
	const differing = wanted.findIndex((line, offset) => file[start + offset] !== line);
	return `Closest match, lines ${from + 1}–${to}${differing >= 0 ? ` (first difference at line ${start + differing + 1})` : ""}:\n${numbered(file.slice(from, Math.min(to, from + 40)), from)}`;
}

/** A hint for a failed edit or patch, from the file as it is now. */
export function editHint(error: string, input: Record<string, unknown>, cwd: string): string | undefined {
	const read = (path: string) => { try { const full = resolve(cwd, path); return statSync(full).size <= 4 << 20 ? readFileSync(full, "utf8") : undefined; } catch { return; } };
	const edits = Array.isArray(input.edits) ? input.edits as { oldText?: unknown }[] : typeof input.oldText === "string" ? [{ oldText: input.oldText }] : [];
	const missing = /Could not find (?:edits\[(\d+)\]|the exact text) in (.+?)\. The old ?[tT]ext must match/.exec(error);
	const duplicate = /Found (\d+) occurrences of (?:edits\[(\d+)\]|the text) in (.+?)\. Each oldText must be unique/.exec(error);
	if ((missing || duplicate) && typeof input.path === "string") {
		const content = read(input.path), which = Number((missing ? missing[1] : duplicate![2]) ?? 0), text = edits[which]?.oldText;
		if (content === undefined || typeof text !== "string") return;
		if (duplicate) {
			const lines = occurrenceLines(content, text);
			return lines.length ? `It occurs at lines ${lines.join(", ")}. Include nearby lines to pick one.` : undefined;
		}
		return closestRegion(content, text);
	}
	// apply_patch: "Failed to find expected lines in <path>:\n<lines>"
	const patch = /Failed to find expected lines in (.+?):\n([\s\S]+)$/.exec(error);
	if (patch) {
		const content = read(patch[1]!.trim());
		return content === undefined ? undefined : closestRegion(content, patch[2]!.replace(/\n(?:Wall time|Exit code)[\s\S]*$/, ""));
	}
}

/** The path a failed call could not find, from its error and arguments. */
export function missingPath(toolName: string, error: string, input: Record<string, unknown>): string | undefined {
	const named = /ENOENT: no such file or directory, \w+ '([^']+)'|Path not found: (.+)$|Failed to read file (?:to update )?(.+?)(?::|$)/m.exec(error);
	if (!named) return;
	const path = (named[1] ?? named[2] ?? named[3])?.trim();
	return path || (typeof input.path === "string" ? input.path : undefined);
}


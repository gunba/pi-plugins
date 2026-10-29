import { parentPort, workerData } from "node:worker_threads";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SavedSession } from "../shared/protocol.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { catalogPath } from "./catalog-path.ts";
import { splitDictationNote } from "../shared/dictation-note.ts";

/**
 * Lists saved sessions the way Pi's SessionManager.list and listAll do, but reads only files whose size or
 * modification time changed since the previous listing; the others keep their earlier rows. Pi reads every file in
 * full, which on a computer with gigabytes of history took long enough that the Resume list was closed before a
 * listing finished, leaving dates days old.
 */
export type CatalogItem = SavedSession & { stamp: string };

const options = workerData as { cwd?: string; baseCwd: string; agentDir: string; sessionDir?: string; directories: string[]; previous: string[] };
const custom = configuredSessionDirectory(options.cwd ?? options.baseCwd, options.agentDir, options.sessionDir);
const root = join(options.agentDir, "sessions");
const previous = new Map(options.previous.map(data => { const item = JSON.parse(data) as CatalogItem; return [catalogPath(item.file), item]; }));
const preview = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
/** Pi's default session folder for a project (session-manager getDefaultSessionDirPath). */
const defaultDirectory = (cwd: string) => join(root, `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

async function sessionFiles(directory: string): Promise<string[]> {
	try { return (await readdir(directory)).filter(name => name.endsWith(".jsonl")).map(name => join(directory, name)); } catch { return []; }
}

/** The files a listing covers and whether their sessions must belong to options.cwd, as in Pi's list and listAll. */
async function candidates(directory: string | undefined): Promise<{ files: string[]; filter: boolean }> {
	if (directory === undefined) {
		if (options.cwd) return { files: await sessionFiles(defaultDirectory(options.cwd)), filter: false };
		const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
		const nested = await Promise.all(folders.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
			.map(entry => sessionFiles(join(root, entry.name))));
		return { files: nested.flat(), filter: false };
	}
	return { files: await sessionFiles(directory), filter: !!options.cwd && catalogPath(directory) !== catalogPath(defaultDirectory(options.cwd)) };
}

/** One session's row, read as Pi's buildSessionInfo reads it. */
async function read(file: string, stamp: string, mtime: Date): Promise<CatalogItem | undefined> {
	type Header = { id?: unknown; cwd?: unknown; timestamp?: unknown };
	let header: Header | undefined;
	let name: string | undefined, firstMessage = "", messageCount = 0, last: number | undefined;
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		let entry: { type?: unknown; name?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; timestamp?: unknown } };
		try { entry = JSON.parse(line); } catch { continue; }
		if (!header) {
			if (entry.type !== "session") { lines.close(); return undefined; }
			header = entry as Header; continue;
		}
		if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
		if (entry.type !== "message") continue;
		messageCount++;
		const message = entry.message;
		if (!message || typeof message.role !== "string" || !("content" in message) || (message.role !== "user" && message.role !== "assistant")) continue;
		const time = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp as string).getTime();
		if (!Number.isNaN(time)) last = Math.max(last ?? 0, time);
		if (firstMessage || message.role !== "user") continue;
		const content = message.content;
		firstMessage = typeof content === "string" ? content : Array.isArray(content)
			? content.filter(block => block?.type === "text").map(block => block.text).join(" ") : "";
	}
	if (!header) return undefined;
	const created = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	const modified = last !== undefined && last > 0 ? new Date(last) : !Number.isNaN(created) ? new Date(created) : mtime;
	return {
		id: preview(header.id, 200), file, cwd: preview(header.cwd, 32768), name: preview(name, 300) || undefined,
		firstMessage: preview(splitDictationNote(firstMessage || "(no messages)").text, 200), messageCount,
		modified: Number.isFinite(modified.getTime()) ? modified.toISOString() : new Date(0).toISOString(), stamp,
	};
}

try {
	const directories: (string | undefined)[] = [custom];
	for (const directory of new Map(options.directories.map(value => [catalogPath(value), resolve(value)])).values()) {
		if (custom && catalogPath(directory) === catalogPath(custom)) continue;
		const path = relative(root, directory);
		if (!custom && path && !path.startsWith("..") && !isAbsolute(path)) continue;
		directories.push(directory);
	}
	const listed = new Map<string, { file: string; filter: boolean }>();
	for (const directory of directories) {
		const { files, filter } = await candidates(directory);
		for (const file of files) if (!listed.has(catalogPath(file))) listed.set(catalogPath(file), { file, filter });
	}
	const include = (item: CatalogItem, filter: boolean) => !filter || (!!item.cwd && catalogPath(item.cwd) === catalogPath(options.cwd!));
	const total = listed.size, unchanged: CatalogItem[] = [], changed: { file: string; filter: boolean; stamp: string; mtime: Date }[] = [];
	await Promise.all([...listed].map(async ([key, { file, filter }]) => {
		const stats = await stat(file).catch(() => undefined);
		const stamp = stats ? `${stats.size}:${stats.mtimeMs}` : "";
		const known = previous.get(key);
		if (stats && known?.stamp === stamp) { if (include(known, filter)) unchanged.push(known); }
		else changed.push({ file, filter, stamp, mtime: stats?.mtime ?? new Date(0) });
	}));
	let loaded = total - changed.length;
	parentPort!.postMessage({ type: "progress", loaded, total, items: unchanged });
	// Most recently written first, as Pi lists them.
	changed.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	let next = 0;
	await Promise.all(Array.from({ length: 4 }, async () => {
		while (next < changed.length) {
			const { file, filter, stamp, mtime } = changed[next++];
			const item = await read(file, stamp, mtime).catch(() => undefined);
			loaded++;
			parentPort!.postMessage({ type: "progress", loaded, total, items: item && include(item, filter) ? [item] : [] });
		}
	}));
	parentPort!.postMessage({ type: "done" });
} catch (error) {
	parentPort!.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) });
}

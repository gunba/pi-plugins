import { parentPort, workerData } from "node:worker_threads";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SavedSession } from "../shared/protocol.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { catalogPath } from "./catalog-path.ts";

const options = workerData as { cwd?: string; baseCwd: string; agentDir: string; sessionDir?: string; directories: string[] };
const custom = configuredSessionDirectory(options.cwd ?? options.baseCwd, options.agentDir, options.sessionDir);
const root = join(options.agentDir, "sessions");
const published = new Set<string>();
let completed = 0, total = 0;
const preview = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const project = (info: SessionInfo): SavedSession => ({
	id: preview(info.id, 200), file: info.path, cwd: preview(info.cwd, 32768), name: preview(info.name, 300) || undefined,
	firstMessage: preview(info.firstMessage, 200), messageCount: info.messageCount,
	modified: Number.isFinite(info.modified.getTime()) ? info.modified.toISOString() : new Date(0).toISOString(),
});
const progress = (loaded: number, count: number, partial?: readonly SessionInfo[]) => {
	total = completed + count;
	const items = [];
	for (const info of partial ?? []) {
		const key = catalogPath(info.path);
		if (published.has(key)) continue;
		published.add(key); items.push(project(info));
	}
	// Never transport transcript bodies/allMessagesText to the host or browser.
	parentPort!.postMessage({ type: "progress", loaded: completed + loaded, total, items });
};
try {
	const directories: (string | undefined)[] = [custom];
	for (const directory of new Map(options.directories.map(value => [catalogPath(value), resolve(value)])).values()) {
		if (custom && catalogPath(directory) === catalogPath(custom)) continue;
		const path = relative(root, directory);
		if (!custom && path && !path.startsWith("..") && !isAbsolute(path)) continue;
		directories.push(directory);
	}
	for (const directory of directories) {
		// Pi's custom-store project filter compares cwd text case-sensitively.
		// Keep its native reader, but use Windows path identity for that filter.
		const windowsScope = process.platform === "win32" && options.cwd && directory;
		const include = (info: SessionInfo) => !!info.cwd && catalogPath(info.cwd) === catalogPath(options.cwd!);
		const report = windowsScope ? (loaded: number, count: number, items?: readonly SessionInfo[]) =>
			progress(loaded, count, items?.filter(include)) : progress;
		let sessions = options.cwd && !windowsScope
			? await SessionManager.list(options.cwd, directory, report)
			: await SessionManager.listAll(directory, report);
		if (windowsScope) sessions = sessions.filter(include);
		progress(total - completed, total - completed, sessions);
		completed = total;
	}
	parentPort!.postMessage({ type: "done" });
} catch (error) {
	parentPort!.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) });
}

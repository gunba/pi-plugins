import { parentPort, workerData } from "node:worker_threads";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SessionManager, SettingsManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SavedSession } from "../shared/protocol.ts";

const options = workerData as { cwd?: string; baseCwd: string; agentDir: string; sessionDir?: string; directories: string[] };
const configured = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR
	?? SettingsManager.create(options.cwd ?? options.baseCwd, options.agentDir).getSessionDir();
const custom = configured ? resolve(configured === "~" ? homedir()
	: configured.startsWith("~/") || configured.startsWith("~\\") ? join(homedir(), configured.slice(2)) : configured) : undefined;
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
		if (published.has(info.path)) continue;
		published.add(info.path); items.push(project(info));
	}
	// Never transport transcript bodies/allMessagesText to the host or browser.
	parentPort!.postMessage({ type: "progress", loaded: completed + loaded, total, items });
};
try {
	const directories: (string | undefined)[] = [custom];
	for (const directory of new Set(options.directories.map(value => resolve(value)))) {
		if (directory === custom) continue;
		const path = relative(root, directory);
		if (!custom && path && !path.startsWith("..") && !isAbsolute(path)) continue;
		directories.push(directory);
	}
	for (const directory of directories) {
		const sessions = options.cwd
			? await SessionManager.list(options.cwd, directory, progress)
			: await SessionManager.listAll(directory, progress);
		progress(total - completed, total - completed, sessions);
		completed = total;
	}
	parentPort!.postMessage({ type: "done" });
} catch (error) {
	parentPort!.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) });
}

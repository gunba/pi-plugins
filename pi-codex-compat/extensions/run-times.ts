import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * How long a command usually takes in a project: the same command in the same folder runs in a stable time
 * (median variation 3% across 167 repeated commands). Successful runs only, newest 20 per command.
 */
const KEEP = 20, MAX_KEYS = 3000;
let store: Map<string, number[]> | undefined, path = "";
const file = () => join(getAgentDir(), "run-times.json");
function load(): Map<string, number[]> {
	if (store && path === file()) return store;
	path = file();
	try { store = new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>)); } catch { store = new Map(); }
	return store;
}
/** The folder and the command with its whitespace collapsed. */
export const runKey = (cwd: string, cmd: string) => `${cwd}\0${cmd.trim().replace(/\s+/g, " ")}`;

export function recordRun(cwd: string, cmd: string, seconds: number): void {
	if (!(seconds >= 1) || !cmd.trim()) return;
	// Test runs record only into an agent folder the test chose, never the real one.
	if (process.env.NODE_TEST_CONTEXT && resolve(getAgentDir()) === resolve(homedir(), ".pi", "agent")) return;
	const runs = load(), key = runKey(cwd, cmd), times = [...runs.get(key) ?? [], Math.round(seconds * 10) / 10].slice(-KEEP);
	runs.delete(key); runs.set(key, times);
	while (runs.size > MAX_KEYS) runs.delete(runs.keys().next().value!);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(runs)), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	} catch { /* History is a convenience. */ }
}

/** Median and 95th percentile of past successful runs, once there are at least three. */
export function runHistory(cwd: string, cmd: string): { runs: number; median: number; p95: number } | undefined {
	const times = [...load().get(runKey(cwd, cmd)) ?? []].sort((a, b) => a - b);
	if (times.length < 3) return;
	const at = (share: number) => times[Math.min(times.length - 1, Math.ceil(share * times.length) - 1)]!;
	return { runs: times.length, median: at(0.5), p95: at(0.95) };
}

export const runDuration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600
	? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;

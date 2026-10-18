import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * How long commands like this one took in this folder, for the agent to judge how long to wait.
 *
 * Commands are compared by their words, not their exact text: an agent rarely runs the same command twice (3,194
 * distinct among 3,211 runs in a week) but often one like it, such as the same test runner on another file or the same
 * build with other flags. Script bodies, quoted text, numbers, directories and file stems are left out of the words.
 * Every conversation appends to one log, so none overwrites another's runs.
 */
const FILE = "run-times.jsonl", MAX_BYTES = 1024 * 1024, KEEP_LINES = 4000, PER_FOLDER = 300, MAX_WORDS = 60;
/** Runs this alike or more count as similar; the closest ones found are used. */
const SIMILAR = 0.5, NEAREST = 0.1;
type Run = { k: string[]; t: number };
let cache: { path: string; size: number; mtime: number; folders: Map<string, Run[]> } | undefined;
const file = () => join(getAgentDir(), FILE);

/** The words of a command that say what it does. */
export function commandWords(cmd: string): string[] {
	const text = cmd
		// Heredoc bodies and quoted text are what a command works on, not what it is.
		.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, " <<script ")
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " quoted ");
	const words = new Set<string>();
	for (const raw of text.split(/[\s;&|()<>`]+/)) {
		if (!raw) continue;
		let word = raw.replace(/^\.\//, "");
		if (/^\d+(?:\.\d+)?[a-z]{0,3}$/i.test(word)) word = "#";
		else if (/^[A-Za-z_]\w*=/.test(word)) word = word.slice(0, word.indexOf("=") + 1);
		else {
			if (word.includes("/") || word.includes("\\")) word = word.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "/";
			// A file name: its kind, not its stem (a.test.mjs and b.test.mjs are alike).
			word = word.replace(/^[^.\s]+(?=(?:\.[A-Za-z][\w-]{0,7})+$)/, "*");
		}
		words.add(word.slice(0, 40));
		if (words.size >= MAX_WORDS) break;
	}
	return [...words];
}
function similarity(a: readonly string[], b: ReadonlySet<string>): number {
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.length + b.size - shared || 1);
}

/** The earlier store (one exact command per key) becomes the log once; its runs are still useful as examples. */
function migrate(path: string): void {
	const old = join(getAgentDir(), "run-times.json"), claimed = `${old}.${process.pid}`;
	try {
		// Renaming first: of several conversations starting together, one moves it.
		renameSync(old, claimed);
		const lines = Object.entries(JSON.parse(readFileSync(claimed, "utf8")) as Record<string, number[]>).flatMap(([key, times]) => {
			const at = key.indexOf("\0"), cwd = key.slice(0, at), cmd = key.slice(at + 1);
			return at > 0 && Array.isArray(times) ? times.filter(time => time > 0).map(time => JSON.stringify({ d: cwd, k: commandWords(cmd), t: time })) : [];
		});
		if (lines.length) appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	} catch { /* None, or already moved. */ }
	rmSync(claimed, { force: true });
}

function load(): Map<string, Run[]> {
	const path = file();
	let stat;
	if (!cache) migrate(path);
	try { stat = statSync(path); } catch { return new Map(); }
	if (cache && cache.path === path && cache.size === stat.size && cache.mtime === stat.mtimeMs) return cache.folders;
	const folders = new Map<string, Run[]>();
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line) continue;
			try {
				const { d, k, t } = JSON.parse(line) as { d: string; k: string[]; t: number };
				if (typeof d !== "string" || !Array.isArray(k) || !(t > 0)) continue;
				const runs = folders.get(d) ?? [];
				runs.push({ k, t });
				if (runs.length > PER_FOLDER) runs.shift();
				folders.set(d, runs);
			} catch { /* A torn line. */ }
		}
	} catch { /* Unreadable: no history. */ }
	cache = { path, size: stat.size, mtime: stat.mtimeMs, folders };
	return folders;
}

export function recordRun(cwd: string, cmd: string, seconds: number): void {
	if (!(seconds >= 1) || !cmd.trim()) return;
	// Test runs record only into an agent folder the test chose, never the real one.
	if (process.env.NODE_TEST_CONTEXT && resolve(getAgentDir()) === resolve(homedir(), ".pi", "agent")) return;
	const path = file();
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		// One short line per run: appends from several conversations at once do not interleave.
		appendFileSync(path, `${JSON.stringify({ d: cwd, k: commandWords(cmd), t: Math.round(seconds * 10) / 10 })}\n`, { mode: 0o600 });
		if (statSync(path).size > MAX_BYTES) {
			const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-KEEP_LINES);
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${kept.join("\n")}\n`, { mode: 0o600 });
			renameSync(temporary, path);
		}
	} catch { /* History is a convenience. */ }
}

/** Times of the earlier runs in this folder most like this command, if any are alike enough. */
export function similarRuns(cwd: string, cmd: string): { runs: number; median: number; min: number; max: number } | undefined {
	const runs = load().get(cwd);
	if (!runs?.length) return;
	const words = new Set(commandWords(cmd));
	const scored = runs.map(run => ({ run, score: similarity(run.k, words) }));
	const best = Math.max(...scored.map(item => item.score));
	if (best < SIMILAR) return;
	const times = scored.filter(item => item.score >= Math.max(SIMILAR, best - NEAREST)).map(item => item.run.t).sort((a, b) => a - b);
	return { runs: times.length, median: times[Math.floor((times.length - 1) / 2)]!, min: times[0]!, max: times.at(-1)! };
}

/** "Similar commands here took 20s–41s (median 33s, 6 runs)." */
export function describeRuns(found: NonNullable<ReturnType<typeof similarRuns>>): string {
	return found.runs === 1 ? `A similar command here took ${runDuration(found.median)}.`
		: `Similar commands here took ${found.min === found.max ? runDuration(found.min) : `${runDuration(found.min)}–${runDuration(found.max)}`} (median ${runDuration(found.median)}, ${found.runs} runs).`;
}

export const runDuration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600
	? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;

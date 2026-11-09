import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What watches are and how they read, shared by the two owners that run them: a Pi process on its own (index.ts) and
 * Desk, which runs every watch on its computer (pi-desk/src/host/watches.ts).
 */

/** Command watches each run a process; time watches are only timers, so an agent can schedule many more. */
export const MAX_COMMANDS = 8, MAX_TIMES = 64;
/** Times are checked against the clock this often, so a computer that slept still acts on time. */
export const CLOCK_MS = 60_000;
/** A time watch reached later than this, because its owner wasn't running, says so. */
export const LATE_MS = 5 * 60_000;
export const TAIL_MS = 1_000;
/** Output arriving within this long of the first new line is judged as one event. */
export const SETTLE_MS = 2_000;
/** The most output one wake carries; the log keeps all of it. */
export const EVENT_CHARS = 4_000;
export const RECENT_LINES = 20;
/** After a restart, missed output beyond this is left in the log rather than judged line by line. */
export const CATCH_UP_BYTES = 16_384;
export const KEEP_FILES_MS = 8 * 86_400_000;
export const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");
/**
 * The folder of the process that runs an agent folder's commands (runner.mjs): its lock and its jobs. The name changes
 * with the jobs' format, so a runner process never takes jobs it can't read.
 */
export const RUNNER_FOLDER = "runner-1";
export const runnerFolder = (agentDir: string) => join(agentDir, "watch", RUNNER_FOLDER);
/** How long a command waits for the runner process to take it before it runs under a runner of its own. */
export const TAKE_MS = 10_000;
/** A background bash command's progress command runs this often, and may take this long. */
export const PROGRESS_MS = 60_000, PROGRESS_LIMIT_MS = 15_000;
/** A program watch's run may take this long. */
export const PROGRAM_LIMIT_MS = 120_000;
/** Output kept from one run, as the runner keeps a command's. */
export const RUN_CHARS = 16_000;
export const READINGS = 12;
/** A time watch from a program sooner than this is an attempt to pause the program, which watches can't do. */
export const SHORT_WAIT_MS = 60_000;

export type Mode = "output" | "change" | "time";
export interface WatchSpec {
	/** Its name for the agent: w1, w2 and so on. */
	id: string;
	/** Desk's id for it, unique on the computer running it; Desk's runner files are named after it. */
	key?: string;
	mode: Mode;
	command?: string;
	/** A program a "change" watch re-runs instead of a command, as for codemode (pi-tools runs it). */
	program?: string;
	/** Seconds between runs of a "change" watch. */
	every?: number;
	/** When a "time" watch wakes the agent, in ms since the epoch. */
	at?: number;
	wakeWhen?: string;
	/** A "change" watch goes on after a result wakes the agent, reporting each later one, until stopped or it expires. */
	keep?: boolean;
	cwd: string;
	created: number;
	/** A time watch's time; a command watch's end, when the agent set hours (otherwise it runs until it ends or is stopped). */
	expires?: number;
	/** The computer running it, by host name. */
	computer: string;
	/** Run for an agent on another computer, which can't open its files: events name the computer they are on. */
	remote?: boolean;
	/** What the watch is for, in the words of the description the agent gave its call; shown to the user. */
	label?: string;
	/** The process running a command watch's command: the agent folder's runner process, or a runner of its own. */
	pid?: number;
	/** Its job in the runner process, as a path without its extension: `${run}.stop` stops it. None for a runner of its own. */
	run?: string;
	/** The command's files: an "output" watch's log, a "change" watch's numbered latest change, and the exit status of either. */
	log?: string;
	change?: string;
	exit?: string;
	/**
	 * A bash command that ran past its call's wait (bash.ts). It wakes the agent when it ends, and every `warn` seconds
	 * while it runs with the readings of its `progress` command, rather than with each new output.
	 */
	bash?: { started: number; warn?: number; progress?: string };
}

/** One event of a wake, for hosts to show the user (the agent reads the message text). */
export interface WatchEvent {
	id: string;
	/** What the watch is for: its label, or what it watches. */
	title: string;
	/** What happened, in a few words: "New output", "Ended: it exited with code 1". */
	status: string;
	command?: string;
	output?: string;
	log?: string;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Pi invalidates an extension's context when its session is replaced or disposed, without always saying so first. */
export const isStale = (error: unknown) => /\bstale\b/i.test(errorText(error));
export const clip = (text: string, max = EVENT_CHARS) => text.length <= max ? text : `…${text.slice(-max)}`;
export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const sizeOf = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

/** An interval in the largest unit that states it exactly: "6 hours", "5 minutes", "90 seconds". */
export function interval(seconds: number): string {
	const [count, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** What a command watch runs: its command, or "program" and the program's first line. */
export const subject = (spec: WatchSpec) => spec.command ?? `program ${(spec.program ?? "").split("\n").map(line => line.trim()).find(line => line && !line.startsWith("// @options")) ?? ""}`;

/**
 * A watch as its agent reads it in results and events: its label, or the start of its command. The agent wrote the
 * command and the wake condition, so they are not repeated in full (commands run to hundreds of characters).
 */
export function briefWatch(spec: WatchSpec): string {
	if (spec.mode === "time") return spec.label ?? `at ${when(spec.at!)}`;
	const command = subject(spec).length > 80 ? `${subject(spec).slice(0, 79)}…` : subject(spec);
	return spec.label ?? `\`${command}\``;
}

export function describeWatch(spec: WatchSpec): string {
	const what = spec.mode === "time" ? `at ${when(spec.at!)}` : spec.mode === "change" ? `\`${subject(spec)}\` every ${interval(spec.every!)}` : `\`${subject(spec)}\``;
	return spec.wakeWhen ? `${what}, waking you when ${spec.wakeWhen}` : what;
}

const UNIT: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Milliseconds since the epoch for a delay from now ("90s", "5m", "1.5h", "in 2 hours"), "HH:MM" (its next occurrence
 * here) or an ISO date and time. Agents don't know the time, so a delay is the easy way to wake shortly.
 */
export function parseTime(text: string, now = Date.now()): number {
	const delay = /^(?:in\s+|\+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(text.trim());
	if (delay) return now + Math.max(1_000, Number(delay[1]) * UNIT[delay[2]![0]!.toLowerCase()]!);
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	let at: number;
	if (clock) {
		const hours = Number(clock[1]), minutes = Number(clock[2]);
		if (hours > 23 || minutes > 59) throw new Error(`${text} is not a time of day.`);
		const next = new Date(now);
		next.setHours(hours, minutes, 0, 0);
		if (next.getTime() <= now) next.setDate(next.getDate() + 1);
		at = next.getTime();
	// Date.parse also reads loose text ("output != '0'" is a date in 2000), so only ISO dates are taken.
	} else at = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(text.trim()) ? Date.parse(text.trim()) : NaN;
	if (!Number.isFinite(at)) throw new Error(`${text} is not a time: give a delay such as 5m, HH:MM or an ISO date and time.`);
	if (at <= now) throw new Error(`${text} has passed.`);
	return at;
}

export function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Stops a process tree: on Windows by ending the tree, elsewhere by asking the runner, which ends its command's group. */
export function stopTree(pid: number): void {
	if (process.platform === "win32") {
		spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
			{ stdio: "ignore", windowsHide: true }).once("error", () => {});
	} else {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	}
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const clockTime = clock;
/** A command's progress over its last readings: "14:02 80/500 · 14:03 120/500". */
export const progressLine = (readings: { at: number; value: string }[]) => readings.length
	? `Progress: ${readings.slice(-5).map(reading => `${clock(reading.at)} ${reading.value}`).join(" · ")}` : "";
/** A change watch's latest change that did not meet its condition: "11:41 output 1 did not meet the condition". */
export const declinedText = (declined: { at: number; output: string }) =>
	`${clock(declined.at)} output ${JSON.stringify(declined.output.length > 60 ? `${declined.output.slice(0, 60)}…` : declined.output)} did not meet the condition`;
/** How long a command has run: "45 s", "12 min", "2 h 5 min". */
export function elapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	return minutes < 1 ? `${Math.round(ms / 1000)} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** The shell the bash tool uses: the configured shellPath, else Pi's default (on Windows, Git Bash or bash on PATH). */
export interface Shell { shell: string; args: string[]; commandTransport?: string; prefix?: string }
export function shellFor(cwd: string, agentDir: string, projectTrusted: boolean): Shell {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return { ...getShellConfig(settings.getShellPath()), prefix: settings.getShellCommandPrefix() };
}

/** The classifier that judges wake_when among those signed in: Jev when available. */
export function pickClassifier<T extends { provider: string; id: string }>(models: readonly T[]): T | undefined {
	return models.find(model => model.provider === "typesafe" && model.id === "jev-latest") ?? models.find(model => /jev/i.test(model.id)) ?? models[0];
}

/**
 * What a classifier is asked to judge an event against wake_when. A change watch's output is a reading, often a bare
 * count or flag that means nothing on its own, so the condition is put beside it, with the reading before when known,
 * and the question is whether the condition is true of it now: asked of "1" whether it shows "output != '0'", Jev gave
 * about 0.3; asked this way, about 0.97.
 */
export function judgement(spec: WatchSpec, condition: string, output: string, previous?: string): ClassifierContext {
	if (spec.mode === "change") return {
		state: { [spec.program !== undefined ? "program" : "command"]: subject(spec), condition,
			...(previous !== undefined ? { "previous output": clip(previous) } : {}), "output now": clip(output) },
		questions: { wake: { type: "bool", instructions: "The agent is waiting for the condition to be true of this output. Is it true of the output now?",
			criteria: { true: "The condition holds for the output now", false: "The condition does not hold for the output now" } } },
	};
	return {
		state: { watching: `New output of \`${subject(spec)}\``, event: clip(output) },
		questions: { wake: { type: "bool", instructions: `An agent asked to be woken when: ${condition}. Does this event show that?`,
			criteria: { true: "The event shows it", false: "The event does not show it" } } },
	};
}

/** Whether a classifier's answer wakes the agent; throws when it gave none. */
export function judged(result: ClassifierResult): boolean {
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `the classifier stopped: ${result.stopReason}`);
	const answer = result.answers.wake;
	return answer?.type === "bool" && answer.probability >= 0.5;
}

/** Runs a short command in the bash tool's shell; its last line of output, or why there is none. */
export function lastLine(shell: Shell, command: string, cwd: string): Promise<string> {
	return new Promise(resolve => {
		const viaStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], { cwd, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		const take = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4_000); };
		child.stdout!.on("data", take); child.stderr!.on("data", take);
		if (viaStdin) child.stdin!.end(command);
		const timer = setTimeout(() => child.kill(), PROGRESS_LIMIT_MS);
		child.once("error", error => { clearTimeout(timer); resolve(`(progress unavailable: ${error.message})`); });
		child.once("close", () => { clearTimeout(timer); resolve((output.trim().split(/\r?\n/).filter(line => line.trim()).at(-1) ?? "(no progress output)").slice(0, 200)); });
	});
}

export interface LaunchOptions {
	/** The runner process's folder: runnerFolder(agent folder). */
	runners: string;
	/** The command's environment; the caller's own when absent. */
	env?: NodeJS.ProcessEnv;
	/** The name of its files in `folder`: the watch's id when absent. */
	file?: string;
	/** How long to wait for the runner process to take it (TAKE_MS). */
	takeMs?: number;
}

/**
 * Starts a command watch's command in `folder`: the agent folder's runner process runs it, and is started if it isn't
 * running. When that process doesn't take it in time, it runs under a runner of its own. A change watch started again
 * keeps its numbered changes. A bash call's command runs the same way, from its own folder and with the bash tool's
 * environment, until it ends or outlives the call's wait and becomes a watch. Sets the spec's files, `pid` and `run`.
 */
export async function launchRunner(spec: WatchSpec, folder: string, shell: Shell, options: LaunchOptions): Promise<void> {
	const file = options.file ?? spec.id;
	mkdirSync(folder, { recursive: true });
	const again = spec.pid !== undefined;
	spec.exit = join(folder, `${file}.exit`);
	if (spec.mode === "change") spec.change = join(folder, `${file}.change`);
	else { spec.log = join(folder, `${file}.log`); writeFileSync(spec.log, ""); }
	rmSync(spec.exit, { force: true });
	if (spec.change && !again) rmSync(spec.change, { force: true });
	const job = { shell: shell.shell, args: shell.args, transport: shell.commandTransport ?? "argv",
		command: spec.command, cwd: spec.cwd, log: spec.log, change: spec.change, every: spec.every, exit: spec.exit, expires: spec.expires };
	const jobs = join(options.runners, "jobs"), run = join(jobs, randomUUID()), wait = options.takeMs ?? TAKE_MS;
	mkdirSync(jobs, { recursive: true, mode: 0o700 });
	// The environment can hold secrets: the file is the user's alone, and the runner deletes it as it takes it.
	writeFileSync(`${run}.tmp`, JSON.stringify({ ...job, env: options.env ?? process.env }), { mode: 0o600 });
	renameSync(`${run}.tmp`, `${run}.json`);
	// The job is written before the runner process is looked for: one leaving after its last look leaves its successor to take it.
	startRunner(options.runners);
	let pid = await taken(run, wait);
	if (pid === undefined) {
		let back = true;
		try { renameSync(`${run}.json`, `${run}.back`); } catch { back = false; }
		if (back) {
			rmSync(`${run}.back`, { force: true });
			const config = join(folder, `${file}.json`);
			writeFileSync(config, JSON.stringify(job));
			const runner = spawn(process.execPath, [RUNNER, config], { cwd: spec.cwd, detached: true, stdio: "ignore", windowsHide: true, ...(options.env ? { env: options.env } : {}) });
			runner.once("error", () => {});
			runner.unref();
			if (!runner.pid) throw new Error("The command could not be started.");
			spec.pid = runner.pid;
			delete spec.run;
			return;
		}
		// Taken as the wait ran out: its answer follows.
		pid = await taken(run, wait);
		if (pid === undefined) throw new Error("The runner process took the command but didn't say it started it.");
	}
	spec.pid = pid;
	spec.run = run;
}

/** Starts the runner process for `folder` unless one is running; of several started at once, one stays. */
function startRunner(folder: string): void {
	try {
		const runner = JSON.parse(readFileSync(join(folder, "service.json"), "utf8")) as { pid?: number; closing?: boolean };
		if (runner.pid && !runner.closing && alive(runner.pid)) return;
	} catch { /* none has run here, or the last one left */ }
	// Its working folder is the home folder: on Windows, a process's working folder can't be removed while it runs.
	const child = spawn(process.execPath, [RUNNER, "--service", folder], { cwd: homedir(), detached: true, stdio: "ignore", windowsHide: true });
	child.once("error", () => {});
	child.unref();
}

/** The runner process's answer to a job: the process ID it runs it in, or undefined after `ms`. */
async function taken(run: string, ms: number): Promise<number | undefined> {
	const until = Date.now() + ms;
	for (let pause = 2; ; pause = Math.min(pause * 2, 50)) {
		try {
			const { pid } = JSON.parse(readFileSync(`${run}.taken`, "utf8")) as { pid: number };
			rmSync(`${run}.taken`, { force: true });
			return pid;
		} catch { /* not taken yet */ }
		if (Date.now() >= until) return undefined;
		await new Promise(resolve => setTimeout(resolve, pause));
	}
}

/** Stops a command watch's command: its job in the runner process, or a runner of its own with its process tree. */
export function stopCommand(spec: WatchSpec): void {
	if (spec.run) { try { writeFileSync(`${spec.run}.stop`, ""); } catch { /* the runner process's folder is gone, and the command with it */ } return; }
	if (spec.pid && alive(spec.pid)) stopTree(spec.pid);
}

export function message(spec: WatchSpec, note: string, output?: string): string {
	return [`Watch ${spec.id} (${briefWatch(spec)}) ${note}`, output?.trim() ? "```\n" + clip(output.trim()) + "\n```" : "",
		spec.log ? `Full output${spec.remote ? ` (on ${spec.computer})` : ""}: ${spec.log}` : ""].filter(Boolean).join("\n");
}

/** A wake's note as the user reads it: "has new output:" is "New output", "changed:" is "Output changed". */
const sentence = (note: string) => {
	const text = note.replace(/[.:]$/, "").replace(/^has new output/, "new output").replace(/^(checked|changed)\b/, "output $1");
	return text.charAt(0).toUpperCase() + text.slice(1);
};
export function watchEvent(spec: WatchSpec, status: string, output?: string): WatchEvent {
	const title = spec.label ?? (spec.mode === "time" ? `Wake ${when(spec.at!)}` : describeWatch(spec));
	return { id: spec.id, title, status: sentence(status), ...(spec.command ? { command: spec.command } : {}),
		...(output?.trim() ? { output: clip(output.trim()) } : {}), ...(spec.log && !spec.remote ? { log: spec.log } : {}) };
}

/** Desk's own runner files, beside each conversation's folder under the watch folder. */
export const DESK_FOLDER = "desk";
/**
 * Why Desk ended an agent's watches without telling it: its conversation went from that computer (Desk watches.ts,
 * endAgent). The agent hears of it when the conversation next runs (desk.ts).
 */
export const REMOVED = "Jordan removed the conversation", MOVED = "the conversation moved to another computer", CLOSED = "the conversation was closed";
export const UNTOLD: ReadonlySet<string> = new Set([REMOVED, MOVED, CLOSED]);

/**
 * Removes watch files under `root` (the agent directory's watch folder) that nothing has written for KEEP_FILES_MS:
 * a conversation's folder all at once, and, for Desk (`desk`), its own files one by one. Folders and files in `inUse`
 * stay, since a re-run command writes its change file only when its output changes.
 */
export function sweep(root: string, options: { inUse?: ReadonlySet<string>; desk?: boolean } = {}): void {
	const old = (path: string) => Date.now() - statSync(path).mtimeMs > KEEP_FILES_MS, inUse = options.inUse ?? new Set<string>();
	try {
		for (const name of readdirSync(root)) {
			const path = join(root, name);
			try {
				// The runner process looks after its own folder.
				if (name.startsWith("runner-")) continue;
				if (name === DESK_FOLDER) {
					if (options.desk) for (const file of readdirSync(path)) if (!inUse.has(join(path, file)) && old(join(path, file))) rmSync(join(path, file), { force: true });
					continue;
				}
				if (inUse.has(path) || inUse.has(join(path, "bash"))) continue;
				const entries = readdirSync(path);
				if (entries.every(entry => old(join(path, entry)))) rmSync(path, { recursive: true, force: true });
			} catch { /* gone meanwhile */ }
		}
	} catch { /* nothing to sweep */ }
}

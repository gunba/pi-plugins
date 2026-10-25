import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getPresentation } from "../pi-ui/index.ts";
import { callDescription } from "../pi-ui/tool-descriptions.ts";

/** Session entries recording each watch: its start, what it last reported, and its end. Watches are rebuilt from them. */
export const WATCH_ENTRY = "pi-watch/v1";
/** The message that wakes the agent. */
export const WATCH_MESSAGE = "pi-watch/event";
/** Emitted on the extension event bus with `{ sessionId, count }` whenever a conversation's watches change. */
export const WATCH_CHANGED = "pi-watch/changed";

const MAX_ACTIVE = 8;
/** Times are checked against the clock this often, so a computer that slept still acts on time. */
const CLOCK_MS = 60_000;
/** A time watch reached later than this, because the conversation wasn't running, says so. */
const LATE_MS = 5 * 60_000;
const TAIL_MS = 1_000;
/** Output arriving within this long of the first new line is judged as one event. */
const SETTLE_MS = 2_000;
/** The most output one wake carries; the log keeps all of it. */
const EVENT_CHARS = 4_000;
const RECENT_LINES = 20;
/** After a restart, missed output beyond this is left in the log rather than judged line by line. */
const CATCH_UP_BYTES = 16_384;
const RUN_LIMIT_MS = 120_000;
/** Undelivered wakes wait this long between attempts while the agent is busy or the host holds the conversation. */
const RETRY_MS = 2_000;
const KEEP_FILES_MS = 8 * 86_400_000;
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");

type Mode = "output" | "change" | "time";
export interface WatchSpec {
	id: string;
	mode: Mode;
	command?: string;
	/** Seconds between runs of a "change" watch. */
	every?: number;
	/** When a "time" watch wakes the agent, in ms since the epoch. */
	at?: number;
	wakeWhen?: string;
	cwd: string;
	created: number;
	/** A time watch's time; a command watch's end, when the agent set hours (otherwise it runs until it ends or is stopped). */
	expires?: number;
	/** Watches run on the computer that started them; a conversation moved elsewhere does not take them along. */
	computer: string;
	/** What the watch is for, in the words of the description the agent gave its call; shown to the user. */
	label?: string;
	/** The runner of an "output" watch, with its log and exit-status files. */
	pid?: number;
	log?: string;
	exit?: string;
}
type WatchRecord =
	| { op: "start"; watch: WatchSpec }
	| { op: "seen"; id: string; offset: number }
	| { op: "end"; id: string; reason: string };

interface Active {
	spec: WatchSpec;
	abort: AbortController;
	timers: NodeJS.Timeout[];
	/** Events are judged one at a time, in order. */
	queue: Promise<unknown>;
	failures: number;
	offset: number;
	decoder: StringDecoder;
	partial: string;
	pending: string[];
	settle?: NodeJS.Timeout;
	recent: string[];
	finishing: boolean;
	/** The next check of the clock, for a time watch or a command watch with an end. */
	clock?: NodeJS.Timeout;
	/** Hash of a "change" watch's latest output. */
	last?: string;
}

const registryKey = Symbol.for("gunba.pi-watch.v1");
const registry = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new Map<string, number>()) as Map<string, number>;
/** Watches active in a conversation. pi-plan holds automatic plan rounds while there are any. */
export const activeWatches = (sessionId: string): number => registry.get(sessionId) ?? 0;

const Parameters = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command, run like bash's. Without every, it runs in the background: its new output wakes you, and so does its end. With every, it is re-run and a change in its output wakes you." })),
	every: Type.Optional(Type.Integer({ minimum: 5, description: "Seconds between runs of command. The watch ends when it wakes you." })),
	until: Type.Optional(Type.String({ description: "Instead of command: wake at this time, HH:MM (its next occurrence, this computer's time) or an ISO date and time. For work on a schedule, set the next time again each time you are woken." })),
	wake_when: Type.Optional(Type.String({ description: "Wake only for output that shows this, in plain words (\"the build fails or finishes\"). A classifier judges each event." })),
	hours: Type.Optional(Type.Number({ minimum: 0.05, description: "How long a command watch may run; by default until it ends or you stop it. A background command still running then is stopped." })),
	stop: Type.Optional(Type.String({ description: "ID of a watch to stop; its background command is stopped too." })),
}, { additionalProperties: false });
type Params = Static<typeof Parameters>;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Pi invalidates an extension's context when its session is replaced or disposed, without always saying so first. */
const isStale = (error: unknown) => /\bstale\b/i.test(errorText(error));
const clip = (text: string, max = EVENT_CHARS) => text.length <= max ? text : `…${text.slice(-max)}`;
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const sizeOf = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

export function describeWatch(spec: WatchSpec): string {
	const what = spec.mode === "time" ? `at ${when(spec.at!)}` : spec.mode === "change" ? `\`${spec.command}\` every ${spec.every} s` : `\`${spec.command}\``;
	return spec.wakeWhen ? `${what}, waking you when ${spec.wakeWhen}` : what;
}

/** Milliseconds since the epoch for "HH:MM" (its next occurrence here) or an ISO date and time. */
export function parseTime(text: string, now = Date.now()): number {
	const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	let at: number;
	if (clock) {
		const hours = Number(clock[1]), minutes = Number(clock[2]);
		if (hours > 23 || minutes > 59) throw new Error(`${text} is not a time of day.`);
		const next = new Date(now);
		next.setHours(hours, minutes, 0, 0);
		if (next.getTime() <= now) next.setDate(next.getDate() + 1);
		at = next.getTime();
	} else at = Date.parse(text);
	if (!Number.isFinite(at)) throw new Error(`${text} is not a time: give HH:MM or an ISO date and time.`);
	if (at <= now) throw new Error(`${text} has passed.`);
	return at;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Stops a process tree: on Windows by ending the tree, elsewhere by asking the runner, which ends its command's group. */
function stopTree(pid: number, group = false): void {
	if (process.platform === "win32") {
		spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
			{ stdio: "ignore", windowsHide: true }).once("error", () => {});
	} else {
		try { process.kill(group ? -pid : pid, group ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
	}
}

/** Runs a command to completion; its output, followed by its exit status when that is not 0. */
function runOnce(command: string, cwd: string, limitMs: number, signal: AbortSignal): Promise<string> {
	const shell = getShellConfig(), viaStdin = shell.commandTransport === "stdin";
	return new Promise(resolve => {
		const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
			cwd, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
		if (viaStdin) child.stdin!.end(command);
		let output = "", late = false;
		const take = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-EVENT_CHARS * 4); };
		child.stdout!.on("data", take);
		child.stderr!.on("data", take);
		const stop = () => { if (child.pid) stopTree(child.pid, true); };
		const timer = setTimeout(() => { late = true; stop(); }, limitMs);
		signal.addEventListener("abort", stop, { once: true });
		const done = (status: string) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			const text = output.trim();
			resolve(status ? `${text}${text ? "\n" : ""}(${status})` : text);
		};
		child.once("error", error => done(`could not run: ${error.message}`));
		child.once("close", code => done(late ? `stopped after ${Math.round(limitMs / 1000)} s` : code === 0 ? "" : `exit code ${code}`));
	});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
		signal.addEventListener("abort", done, { once: true });
	});
}

/** The signed-in classifier that judges wake_when: Jev when available. */
async function classifier(ctx: ExtensionContext) {
	const models = await ctx.modelRegistry.getAvailableOfType("classifier");
	return models.find(model => model.provider === "typesafe" && model.id === "jev-latest") ?? models.find(model => /jev/i.test(model.id)) ?? models[0];
}

function message(spec: WatchSpec, note: string, output?: string): string {
	return [`Watch ${spec.id} (${describeWatch(spec)}) ${note}`, output?.trim() ? "```\n" + clip(output.trim()) + "\n```" : "",
		spec.log ? `Full output: ${spec.log}` : ""].filter(Boolean).join("\n");
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
/** A wake's note as the user reads it: "has new output:" is "New output", "changed:" is "Output changed". */
const sentence = (note: string) => {
	const text = note.replace(/[.:]$/, "").replace(/^has new output/, "new output").replace(/^(checked|changed)\b/, "output $1");
	return text.charAt(0).toUpperCase() + text.slice(1);
};
function watchEvent(spec: WatchSpec, status: string, output?: string): WatchEvent {
	const title = spec.label ?? (spec.mode === "time" ? `Wake ${when(spec.at!)}` : describeWatch(spec));
	return { id: spec.id, title, status: sentence(status), ...(spec.command ? { command: spec.command } : {}),
		...(output?.trim() ? { output: clip(output.trim()) } : {}), ...(spec.log ? { log: spec.log } : {}) };
}

let swept = false;
/** Removes the files of watches that ended more than a week ago. */
function sweep(root: string): void {
	if (swept) return;
	swept = true;
	try {
		for (const folder of readdirSync(root)) {
			const path = join(root, folder), files = readdirSync(path);
			const newest = Math.max(0, ...files.map(file => statSync(join(path, file)).mtimeMs));
			if (Date.now() - newest > KEEP_FILES_MS) rmSync(path, { recursive: true, force: true });
		}
	} catch { /* nothing to sweep */ }
}

class Watches {
	readonly sessionId: string;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly folder: string;
	private readonly active = new Map<string, Active>();
	private outbox: { id: string; text: string; event: WatchEvent }[] = [];
	private retry?: NodeJS.Timeout;
	private closed = false;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
		this.pi = pi;
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.folder = join(getAgentDir(), "watch", this.sessionId);
	}

	/** Rebuilds this branch's watches from its entries and picks each one back up. */
	restore(): void {
		const specs = new Map<string, WatchSpec>(), seen = new Map<string, number>();
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord;
			if (record.op === "start") specs.set(record.watch.id, record.watch);
			else if (record.op === "end") { specs.delete(record.id); seen.delete(record.id); }
			// Older change watches recorded an output hash here rather than an offset; those are skipped.
			else if (typeof record.offset === "number") seen.set(record.id, record.offset);
		}
		for (const spec of specs.values()) this.arm(spec, seen.get(spec.id), true);
		this.publish();
	}

	/** Stops following this conversation's watches. Background commands keep running and are picked up when it resumes. */
	close(): void {
		this.closed = true;
		for (const active of this.active.values()) this.disarm(active);
		this.active.clear();
		if (this.retry) clearTimeout(this.retry);
		registry.delete(this.sessionId);
		try { this.pi.events.emit(WATCH_CHANGED, { sessionId: this.sessionId, count: 0 }); } catch { /* the session is gone */ }
	}

	/**
	 * Runs timer and background work. Nothing here may throw into Node: once the session's context is stale, the
	 * watches stop following (their commands keep running for the session's next start); other errors are logged.
	 */
	private guard(work: () => unknown): void {
		if (this.closed) return;
		try {
			const result = work();
			if (result instanceof Promise) result.catch(error => this.failed(error));
		} catch (error) { this.failed(error); }
	}

	private failed(error: unknown): void {
		if (this.closed) return;
		if (isStale(error)) this.close();
		else console.error(`pi-watch: ${errorText(error)}`);
	}

	/** Queues work behind the events of a watch still being judged. */
	private chain(active: Active, work: () => unknown): Promise<unknown> {
		const next = active.queue.then(() => this.closed ? undefined : work());
		active.queue = next.catch(error => this.failed(error));
		return next;
	}

	async call(params: Params, ctx: ExtensionContext, label?: string): Promise<string> {
		const given = Object.entries(params).filter(([, value]) => value !== undefined).map(([key]) => key);
		if (params.stop !== undefined) {
			if (given.length > 1) throw new Error("stop takes no other parameters.");
			const active = this.active.get(params.stop.trim());
			if (!active) throw new Error(`There is no active watch ${params.stop}. ${this.list()}`);
			this.end(active, "you stopped it", { kill: true, tell: false });
			return `Stopped ${active.spec.id}${active.spec.pid ? " and its command" : ""}. ${this.list()}`;
		}
		if (params.command === undefined && params.until === undefined) {
			if (given.length) throw new Error("Give command or until.");
			return this.list();
		}
		if (params.command !== undefined && params.until !== undefined) throw new Error("Give command or until, not both; hours sets how long a command watch lasts.");
		if (params.until !== undefined && given.length > 1) throw new Error("until takes no other parameters.");
		const command = params.command?.trim(), wakeWhen = params.wake_when?.trim() || undefined;
		if (params.command !== undefined && !command) throw new Error("command is empty.");
		if (this.active.size >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} watches can run at once. ${this.list()}`);
		if (wakeWhen && !(await classifier(ctx)))
			throw new Error("wake_when needs a classifier model, such as System One's Jev (/login typesafe). Leave wake_when out to be woken for every event.");
		const now = Date.now(), at = params.until !== undefined ? parseTime(params.until, now) : undefined;
		const spec: WatchSpec = {
			id: this.nextId(), mode: at !== undefined ? "time" : params.every !== undefined ? "change" : "output",
			...(command ? { command } : {}), ...(params.every !== undefined ? { every: params.every } : {}), ...(at !== undefined ? { at } : {}),
			...(wakeWhen ? { wakeWhen } : {}),
			cwd: ctx.cwd, created: now, ...(at !== undefined ? { expires: at } : params.hours !== undefined ? { expires: now + params.hours * 3_600_000 } : {}),
			computer: hostname(), ...(label ? { label } : {}),
		};
		if (spec.mode === "output") this.launch(spec);
		this.pi.appendEntry(WATCH_ENTRY, { op: "start", watch: spec } satisfies WatchRecord);
		this.arm(spec, undefined, false);
		this.publish();
		const ending = spec.expires ? `It ends ${when(spec.expires)}.` : "It runs until it ends or you stop it.", stop = `watch({stop: "${spec.id}"}) stops it.`;
		const text = spec.mode === "time" ? `Watching as ${spec.id}: you'll be woken ${describeWatch(spec)}.`
			: spec.mode === "change" ? `Watching as ${spec.id}: ${describeWatch(spec)}. You'll be woken when ${wakeWhen ? "a run's output shows that" : "its output changes"}; the watch then ends. ${ending} ${stop}`
			: `Watching as ${spec.id}: ${describeWatch(spec)}, output in ${spec.log}. You'll be woken ${wakeWhen ? "when its output shows that" : "with its new output"}, and when it ends. ${ending} ${stop}`;
		return `${text} End your turn now unless you have other work.`;
	}

	private list(): string {
		if (!this.active.size) return "No active watches.";
		return `Active watches:\n${[...this.active.values()].map(({ spec }) => `- ${spec.id}: ${describeWatch(spec)}${spec.mode !== "time" && spec.expires ? `; ends ${when(spec.expires)}` : ""}`).join("\n")}`;
	}

	private nextId(): string {
		let highest = 0;
		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord;
			if (record.op === "start") highest = Math.max(highest, Number(record.watch.id.slice(1)) || 0);
		}
		return `w${highest + 1}`;
	}

	/** Starts an "output" watch's command under the detached runner. */
	private launch(spec: WatchSpec): void {
		mkdirSync(this.folder, { recursive: true });
		const shell = getShellConfig(), file = join(this.folder, `${spec.id}.json`);
		spec.log = join(this.folder, `${spec.id}.log`);
		spec.exit = join(this.folder, `${spec.id}.exit`);
		writeFileSync(spec.log, "");
		rmSync(spec.exit, { force: true });
		writeFileSync(file, JSON.stringify({ shell: shell.shell, args: shell.args, transport: shell.commandTransport ?? "argv",
			command: spec.command, cwd: spec.cwd, log: spec.log, exit: spec.exit, expires: spec.expires }));
		const runner = spawn(process.execPath, [RUNNER, file], { cwd: spec.cwd, detached: true, stdio: "ignore", windowsHide: true });
		runner.unref();
		if (!runner.pid) throw new Error("The command could not be started.");
		spec.pid = runner.pid;
	}

	private arm(spec: WatchSpec, offset: number | undefined, restored: boolean): void {
		const active: Active = { spec, abort: new AbortController(), timers: [], queue: Promise.resolve(), failures: 0,
			offset: offset ?? 0, decoder: new StringDecoder("utf8"), partial: "", pending: [], recent: [], finishing: false };
		this.active.set(spec.id, active);
		const now = Date.now();
		if (spec.computer !== hostname()) {
			this.end(active, "the conversation moved to another computer, so the watch stopped", { kill: false });
			return;
		}
		if (spec.mode === "time") {
			this.at(active, spec.at!, late => this.end(active, late > LATE_MS ? `it was due ${when(spec.at!)}, while the conversation wasn't running`
				: `it's ${when(spec.at!)}, the time you set`, { kill: false }));
			return;
		}
		if (spec.expires !== undefined) {
			if (spec.expires <= now) {
				this.end(active, "expired while the conversation wasn't running", { kill: true });
				return;
			}
			this.at(active, spec.expires, () => this.end(active, "expired", { kill: true, output: active.recent.join("\n") }));
		}
		if (spec.mode === "change") this.guard(() => this.poll(active));
		else this.follow(active, restored);
	}

	/**
	 * Runs `due` at `time` by the clock, with how late it is. Node's timers stop while a computer sleeps and cannot span
	 * more than 24.8 days, so the clock is checked at least every CLOCK_MS instead.
	 */
	private at(active: Active, time: number, due: (late: number) => void): void {
		const check = () => this.guard(() => {
			const left = time - Date.now();
			if (left > 0) active.clock = setTimeout(check, Math.min(left, CLOCK_MS));
			else due(-left);
		});
		active.clock = setTimeout(check, 0);
	}

	private disarm(active: Active): void {
		active.abort.abort();
		if (active.clock) clearTimeout(active.clock);
		for (const timer of active.timers) clearTimeout(timer);
		if (active.settle) clearTimeout(active.settle);
	}

	private end(active: Active, reason: string, options: { kill: boolean; output?: string; tell?: boolean }): void {
		const { spec } = active;
		if (this.closed || this.active.get(spec.id) !== active) return;
		this.active.delete(spec.id);
		this.disarm(active);
		if (options.kill && spec.pid && alive(spec.pid)) stopTree(spec.pid);
		this.pi.appendEntry(WATCH_ENTRY, { op: "end", id: spec.id, reason } satisfies WatchRecord);
		if (options.tell !== false) this.send(spec, spec.mode === "time" ? `Watch ${spec.id}: ${reason}.` : message(spec, `ended: ${reason}.`, options.output),
			spec.mode === "time" ? reason : `ended: ${reason}`, options.output);
		this.publish();
	}

	/** Follows an "output" watch's log until its runner reports the end. */
	private follow(active: Active, restored: boolean): void {
		if (restored) {
			const size = sizeOf(active.spec.log!);
			if (size - active.offset > CATCH_UP_BYTES) active.offset = size - CATCH_UP_BYTES;
		}
		const tick = () => this.guard(() => {
			try { this.tick(active); } catch (error) {
				if (isStale(error)) throw error;
				this.end(active, `its output could not be read: ${errorText(error)}`, { kill: true });
			}
		});
		active.timers.push(setInterval(tick, TAIL_MS));
		tick();
	}

	private read(active: Active): boolean {
		const size = sizeOf(active.spec.log!);
		if (size <= active.offset) return false;
		const fd = openSync(active.spec.log!, "r");
		try {
			const buffer = Buffer.alloc(Math.min(size - active.offset, 1 << 20));
			const read = readSync(fd, buffer, 0, buffer.length, active.offset);
			active.offset += read;
			this.take(active, active.decoder.write(buffer.subarray(0, read)));
		} finally { closeSync(fd); }
		return active.offset < size;
	}

	private tick(active: Active): void {
		if (active.finishing || this.read(active)) return;
		if (existsSync(active.spec.exit!)) this.finish(active);
		else if (active.spec.pid && !alive(active.spec.pid)) this.finish(active, "it stopped without reporting how it ended");
	}

	private take(active: Active, text: string): void {
		const parts = (active.partial + text).split(/\r\n|\n|\r/);
		active.partial = parts.pop() ?? "";
		if (active.partial.length > EVENT_CHARS) { parts.push(active.partial); active.partial = ""; }
		const lines = parts.filter(line => line.trim());
		if (!lines.length) return;
		active.recent.push(...lines);
		active.recent.splice(0, Math.max(0, active.recent.length - RECENT_LINES));
		active.pending.push(...lines);
		active.pending.splice(0, Math.max(0, active.pending.length - 1_000));
		active.settle ??= setTimeout(() => { active.settle = undefined; this.guard(() => this.report(active)); }, SETTLE_MS);
	}

	/** Judges the output gathered since the last event; a wake records how far the conversation has seen. */
	private report(active: Active): void {
		if (!active.pending.length) return;
		const output = active.pending.join("\n"), offset = active.offset;
		active.pending = [];
		void this.chain(active, async () => {
			if (await this.consider(active, output, "has new output:")) this.pi.appendEntry(WATCH_ENTRY, { op: "seen", id: active.spec.id, offset } satisfies WatchRecord);
		});
	}

	/** Reports the end of an "output" watch, with its last lines: one wake, after any event still being judged. */
	private finish(active: Active, fallback?: string): void {
		if (active.finishing) return;
		active.finishing = true;
		try { while (this.read(active)); } catch { /* report what was read */ }
		const rest = active.partial + active.decoder.end();
		active.partial = "";
		if (rest.trim()) this.take(active, `${rest}\n`);
		if (active.settle) { clearTimeout(active.settle); active.settle = undefined; }
		active.pending = [];
		let how = fallback ?? "it ended";
		if (!fallback) try {
			const status = JSON.parse(readFileSync(active.spec.exit!, "utf8")) as { code?: number | null; signal?: string | null; error?: string; stopped?: string };
			how = status.error ? `it could not start: ${status.error}` : status.stopped ? `it was stopped (${status.stopped})`
				: status.signal ? `it was ended by ${status.signal}` : `it exited with code ${status.code}`;
		} catch { /* the generic reason stands */ }
		void this.chain(active, () => this.end(active, how, { kill: false, output: active.recent.join("\n") }));
	}

	/** Re-runs a "change" watch's command, judging each new output, until it wakes the agent. */
	private async poll(active: Active): Promise<void> {
		const { spec, abort } = active;
		while (!this.closed && this.active.get(spec.id) === active) {
			const output = await runOnce(spec.command!, spec.cwd, Math.min(spec.every! * 1000, RUN_LIMIT_MS), abort.signal);
			if (this.closed || this.active.get(spec.id) !== active) return;
			const hash = createHash("sha256").update(output).digest("hex").slice(0, 16), previous = active.last;
			if (hash !== previous) {
				active.last = hash;
				// The first run only sets the baseline, unless a condition can already be true.
				if (previous !== undefined || spec.wakeWhen) {
					if (await this.chain(active, () => this.consider(active, output, previous === undefined ? "checked:" : "changed:"))) {
						this.end(active, "it woke you", { kill: false, tell: false });
						return;
					}
				}
			}
			await sleep(spec.every! * 1000, abort.signal);
		}
	}

	/** Wakes the agent with an event when it meets the watch's condition. True when it woke the agent. */
	private async consider(active: Active, output: string, note: string): Promise<boolean> {
		if (this.closed || this.active.get(active.spec.id) !== active) return false;
		const condition = active.spec.wakeWhen;
		if (!condition) { this.send(active.spec, message(active.spec, note, output), note, output); return true; }
		try {
			const matched = await this.judge(active.spec, condition, output);
			active.failures = 0;
			if (matched) this.send(active.spec, message(active.spec, note, output), note, output);
			return matched;
		} catch (error) {
			if (isStale(error) || this.closed) throw error;
			// A classifier outage must not hide events: wake anyway, and give up on the watch if it persists.
			if (++active.failures >= 3) this.end(active, `its condition could not be checked: ${errorText(error)}`, { kill: true, output });
			else this.send(active.spec, message(active.spec, `${note} (the condition could not be checked: ${errorText(error)})`, output),
				`${note.replace(/:$/, "")} (the condition could not be checked)`, output);
			return true;
		}
	}

	private async judge(spec: WatchSpec, condition: string, output: string): Promise<boolean> {
		const model = await classifier(this.ctx);
		if (!model) throw new Error("no classifier model is signed in");
		const result = await this.ctx.modelRegistry.classify(model, {
			state: { watching: spec.mode === "change" ? `The output of \`${spec.command}\`` : `New output of \`${spec.command}\``, event: clip(output) },
			questions: { wake: { type: "bool", instructions: `An agent asked to be woken when: ${condition}. Does this event show that?`,
				criteria: { true: "The event shows it", false: "The event does not show it" } } },
		});
		if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `the classifier stopped: ${result.stopReason}`);
		const answer = result.answers.wake;
		return answer?.type === "bool" && answer.probability >= 0.5;
	}

	/** Queues a wake: `text` for the agent, `status` and `output` for the user. */
	private send(spec: WatchSpec, text: string, status: string, output?: string): void {
		this.outbox.push({ id: spec.id, text, event: watchEvent(spec, status, output) });
		this.flush();
	}

	/** Delivers waiting events as one message, starting a turn; while the agent is busy they wait for it to finish. */
	private flush(): void {
		if (this.closed || !this.outbox.length || this.retry) return;
		if (getPresentation(this.pi)?.suspended || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) {
			this.retry = setTimeout(() => { this.retry = undefined; this.guard(() => this.flush()); }, RETRY_MS);
			return;
		}
		const items = this.outbox;
		this.outbox = [];
		this.pi.sendMessage({ customType: WATCH_MESSAGE, content: items.map(item => item.text).join("\n\n"), display: true,
			details: { watches: [...new Set(items.map(item => item.id))], events: items.map(item => item.event) } }, { deliverAs: "followUp", triggerTurn: true });
	}

	private stop(id: string): void {
		const active = this.active.get(id);
		if (active) this.end(active, "Jordan stopped it", { kill: true });
	}

	private publish(): void {
		if (this.closed) return;
		const specs = [...this.active.values()].map(active => active.spec);
		if (specs.length) registry.set(this.sessionId, specs.length); else registry.delete(this.sessionId);
		this.pi.events.emit(WATCH_CHANGED, { sessionId: this.sessionId, count: specs.length });
		if (this.ctx.hasUI) this.ctx.ui.setStatus("pi-watch", specs.length ? `watching ${specs.length}` : undefined);
		const presentation = getPresentation(this.pi);
		if (!presentation || presentation.suspended) return;
		const times = specs.flatMap(spec => spec.mode === "time" ? [spec.at!] : []);
		presentation.publish("pi-watch", specs.length ? {
			kind: "details", title: "Watches", ...(times.length ? { wakes: Math.min(...times) } : {}),
			...(specs.some(spec => spec.mode !== "time") ? { watching: true } : {}),
			data: { items: specs.map(spec => ({ id: spec.id, title: spec.label ?? describeWatch(spec),
				subtitle: [spec.id, ...(spec.label ? [describeWatch(spec)] : []), ...(spec.mode !== "time" && spec.expires ? [`ends ${when(spec.expires)}`] : [])].join(" · "),
				actions: [{ id: `stop:${spec.id}`, label: "Stop", destructive: true }] })) },
			badges: [{ label: "Watching", value: String(specs.length), icon: "eye", compact: true,
				description: specs.map(spec => `${spec.id}: ${spec.label ?? describeWatch(spec)}`).join("\n") }],
		} : undefined, Object.fromEntries(specs.map(spec => [`stop:${spec.id}`, () => this.stop(spec.id)])));
	}
}

export default function watch(pi: ExtensionAPI): void {
	let watches: Watches | undefined;
	const start = (ctx: ExtensionContext) => {
		watches?.close();
		watches = new Watches(pi, ctx);
		watches.restore();
		sweep(join(getAgentDir(), "watch"));
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => { watches?.close(); watches = undefined; labels.clear(); });
	// The description a call carries (pi-ui/tool-descriptions.ts) is removed before the tool runs; it labels the watch.
	const labels = new Map<string, string>();
	pi.on("tool_call", event => {
		const label = event.toolName === "watch" ? callDescription(event.input) : undefined;
		if (label) labels.set(event.toolCallId, label.slice(0, 200));
	});
	pi.registerTool({
		name: "watch",
		label: "Watch",
		description: "Wait without spending turns: start a watch, end your turn, and be woken with what happened. A watch runs a command in the background and wakes you with its output and when it ends; or re-runs a command every so often and wakes you when its output changes; or wakes you at a time. wake_when filters events. Use it instead of sleep loops, repeated checks or waiting on a long command. A time watch lasts: Desk reopens this conversation when it is due, even if it was closed or the computer restarted, so use it for work the user asks to be done later or regularly (every Sunday, say): when woken, do it and set the next time. With no arguments it lists watches; stop ends one.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(id, params: Params, _signal, _update, ctx) {
			const label = labels.get(id);
			labels.delete(id);
			if (!watches || watches.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Watches are not ready in this conversation.");
			const text = await watches.call(params, ctx, label);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

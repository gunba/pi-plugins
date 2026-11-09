import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { alive, CATCH_UP_BYTES, CLOCK_MS, elapsed, errorText, EVENT_CHARS, isStale, LATE_MS, lastLine, launchRunner, message, PROGRESS_MS,
	progressLine, READINGS, RECENT_LINES, RUN_CHARS, SETTLE_MS, sizeOf, stopCommand, TAIL_MS, when, type Shell, type WatchSpec } from "./common.ts";

/** How far a watch has got, kept by its owner so it carries on from there after a restart. */
export interface Progress {
	/** An "output" watch's log judged up to this byte; a "change" watch's last change judged, by number. */
	offset?: number;
	/** A change watch's command, started again: the process running it, and its job there (WatchSpec.run). */
	pid?: number;
	run?: string;
	/** When a program watch last ran. */
	last?: number;
	/** A change watch's latest change that did not meet its condition, so a watch that stays quiet shows why. */
	declined?: { at: number; output: string };
}

/** What an engine needs from whoever owns its watches: a Pi process on its own, or Desk. */
export interface WatchOwner {
	/** Where a watch whose runner has no files yet keeps them, and their name; files a watch has say where they are. */
	place(spec: WatchSpec): { folder: string; file: string };
	/** The runner process's folder, where commands are given to it (common.ts runnerFolder). */
	readonly runners: string;
	shell(cwd: string): Shell;
	/** The environment a runner started again gives its command; its own process's when absent. */
	environment?(): NodeJS.ProcessEnv;
	/** Who wasn't running while a watch could not act, for its late notes: "the conversation", "Desk". */
	readonly absent: string;
	/** Keeps a watch's progress. */
	progress(spec: WatchSpec, progress: Progress): void;
	/** Wakes the agent: `text` for it, `status` and `output` for the user. */
	send(spec: WatchSpec, text: string, status: string, output?: string): void;
	/** The watch ended for `reason`; `wake` is the agent's message saying so, when it is told. */
	ended(spec: WatchSpec, reason: string, wake?: { text: string; status: string; output?: string }): void;
	/** Whether `output` shows `condition`, given a change watch's output before when known; throws when it can't be checked. */
	judge(spec: WatchSpec, condition: string, output: string, previous?: string): Promise<boolean>;
	/** One run of a program watch: its result, or undefined when it can't run yet (it is tried again shortly). */
	program(spec: WatchSpec, signal: AbortSignal): Promise<string | undefined>;
	/** A watch started, ended or has new readings. */
	changed(): void;
	/** Background work failed. */
	failed(error: unknown): void;
}

interface Active {
	spec: WatchSpec;
	declined?: { at: number; output: string };
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
	/** When an "output" watch last recorded how far it has judged. */
	saved: number;
	/** A background bash command's progress readings, newest last. */
	readings: { at: number; value: string }[];
	/** A program watch's next run. */
	run?: NodeJS.Timeout;
	/** When a "change" watch's command was last started again, and whether it is being started now. */
	relaunched?: number;
	launching?: boolean;
}

/** A program watch without a context to run in tries again this often. */
const RESUME_MS = 5_000;
/** A runner that stops again this soon after being started again can't run, and isn't started a third time. */
const RELAUNCH_MS = 60_000;
/** A watch's key in its engine: Desk's id for it, which is unique on the computer, else its name. */
const keyOf = (spec: WatchSpec) => spec.key ?? spec.id;

/**
 * Runs watches: follows their runners' files, runs their programs and times, judges what happens against wake_when, and
 * tells its owner what to keep and whom to wake. Nothing here throws into Node: failures go to the owner.
 */
export class WatchEngine {
	private readonly owner: WatchOwner;
	private readonly active = new Map<string, Active>();
	private closed = false;

	constructor(owner: WatchOwner) { this.owner = owner; }

	get size(): number { return this.active.size; }
	has(key: string): boolean { return this.active.has(key); }
	specs(): WatchSpec[] { return [...this.active.values()].map(active => active.spec); }
	readings(key: string): readonly { at: number; value: string }[] { return this.active.get(key)?.readings ?? []; }
	/** A change watch's latest change that did not meet its condition. */
	declined(key: string): { at: number; output: string } | undefined { return this.active.get(key)?.declined; }

	/** Stops following every watch. Their runners keep running, to be followed again from the owner's records. */
	close(): void {
		this.closed = true;
		for (const active of this.active.values()) this.disarm(active);
		this.active.clear();
	}

	private guard(work: () => unknown): void {
		if (this.closed) return;
		try {
			const result = work();
			if (result instanceof Promise) result.catch(error => this.fail(error));
		} catch (error) { this.fail(error); }
	}

	private fail(error: unknown): void { if (!this.closed) this.owner.failed(error); }

	/** Queues work behind the events of a watch still being judged. */
	private chain(active: Active, work: () => unknown): Promise<unknown> {
		const next = active.queue.then(() => this.closed ? undefined : work());
		active.queue = next.catch(error => this.fail(error));
		return next;
	}

	/** Follows a watch from `progress`; `restored` says it ran before, while its owner was away. */
	arm(spec: WatchSpec, progress: Progress = {}, restored = false): void {
		if (this.closed || this.active.has(keyOf(spec))) return;
		const active: Active = { spec, abort: new AbortController(), timers: [], queue: Promise.resolve(), failures: 0, saved: 0,
			offset: progress.offset ?? 0, decoder: new StringDecoder("utf8"), partial: "", pending: [], recent: [], finishing: false, readings: [] };
		this.active.set(keyOf(spec), active);
		const now = Date.now();
		if (spec.mode === "time") {
			this.at(active, spec.at!, late => this.finishWith(active, late > LATE_MS ? `it was due ${when(spec.at!)}, while ${this.owner.absent} wasn't running`
				: `it's ${when(spec.at!)}, the time you set`, { kill: false }));
			return;
		}
		if (spec.expires !== undefined) {
			if (spec.expires <= now) {
				this.finishWith(active, `expired while ${this.owner.absent} wasn't running`, { kill: true });
				return;
			}
			this.at(active, spec.expires, () => this.finishWith(active, "expired", { kill: true, output: active.recent.join("\n") }));
		}
		if (spec.mode === "change") this.followChanges(active, restored, progress.last);
		else this.follow(active, restored);
		if (spec.bash) this.followBash(active);
	}

	/** Ends a watch: `tell` false leaves the agent untold, as when it stopped the watch itself. */
	end(key: string, reason: string, options: { kill: boolean; output?: string; tell?: boolean }): boolean {
		const active = this.active.get(key);
		if (!active) return false;
		this.finishWith(active, reason, options);
		return true;
	}

	/** Stops re-run commands, which only report to their watch (the owner is going for good). */
	stopRunners(): void {
		for (const { spec } of this.active.values()) if (spec.mode === "change" && spec.command !== undefined) stopCommand(spec);
	}

	private finishWith(active: Active, reason: string, options: { kill: boolean; output?: string; tell?: boolean }): void {
		const { spec } = active;
		if (this.closed || this.active.get(keyOf(spec)) !== active) return;
		this.active.delete(keyOf(spec));
		this.disarm(active);
		if (options.kill) stopCommand(spec);
		this.owner.ended(spec, reason, options.tell === false ? undefined : spec.mode === "time"
			? { text: `Watch ${spec.id}: ${reason}.`, status: reason }
			: { text: message(spec, `ended: ${reason}.`, options.output), status: `ended: ${reason}`, output: options.output });
		this.owner.changed();
	}

	/**
	 * A background bash command reads its progress each minute and wakes the agent every `warn` seconds while it runs,
	 * with the readings, so the agent can judge whether it is getting anywhere.
	 */
	private followBash(active: Active): void {
		const { bash } = active.spec;
		if (bash?.progress) {
			const read = () => this.guard(() => this.readProgress(active));
			active.timers.push(setInterval(read, PROGRESS_MS));
			read();
		}
		if (!bash?.warn) return;
		const step = bash.warn * 1000;
		const next = () => this.at(active, bash.started + Math.ceil((Date.now() + 1 - bash.started) / step) * step, () => {
			void this.chain(active, async () => {
				await this.readProgress(active);
				if (this.active.get(keyOf(active.spec)) !== active || active.finishing) return;
				const status = `is still running after ${elapsed(Date.now() - bash.started)}.`;
				const progress = progressLine(active.readings);
				this.owner.send(active.spec, [message(active.spec, status, active.recent.join("\n")), progress,
					`Stop it with watch({stop: "${active.spec.id}"}); otherwise you're woken when it ends.`].filter(Boolean).join("\n"), status, active.recent.join("\n"));
			});
			next();
		});
		next();
	}

	private async readProgress(active: Active): Promise<void> {
		const command = active.spec.bash?.progress;
		if (!command || active.finishing) return;
		const value = await lastLine(this.owner.shell(active.spec.cwd), command, active.spec.cwd);
		if (this.closed || this.active.get(keyOf(active.spec)) !== active) return;
		active.readings.push({ at: Date.now(), value });
		active.readings.splice(0, Math.max(0, active.readings.length - READINGS));
		this.owner.changed();
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
		if (active.run) clearTimeout(active.run);
		for (const timer of active.timers) clearTimeout(timer);
		if (active.settle) clearTimeout(active.settle);
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
				this.finishWith(active, `its output could not be read: ${errorText(error)}`, { kill: true });
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
		// A background bash command wakes the agent only when it ends or at its warnings.
		if (active.spec.bash) return;
		active.pending.push(...lines);
		active.pending.splice(0, Math.max(0, active.pending.length - 1_000));
		active.settle ??= setTimeout(() => { active.settle = undefined; this.guard(() => this.report(active)); }, SETTLE_MS);
	}

	/** Judges the output gathered since the last event; a wake records how far the agent has seen. */
	private report(active: Active): void {
		if (!active.pending.length) return;
		const output = active.pending.join("\n"), offset = active.offset;
		active.pending = [];
		void this.chain(active, async () => {
			// Output judged is recorded as seen, so it is not judged again after a restart: at once after a wake,
			// otherwise at most once a minute.
			const woke = await this.consider(active, output, "has new output:");
			if (woke || Date.now() - active.saved > 60_000) {
				active.saved = Date.now();
				this.owner.progress(active.spec, { offset });
			}
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
		if (active.spec.bash) how += ` after ${elapsed(Date.now() - active.spec.bash.started)}${active.readings.length ? ` (${progressLine(active.readings)})` : ""}`;
		void this.chain(active, () => this.finishWith(active, how, { kill: false, output: active.recent.join("\n") }));
	}

	/**
	 * Follows a "change" watch's runner, judging each change it records, until one wakes the agent (or, kept, until it
	 * is stopped). Its offset is the number of the last change judged. A runner that is gone without an exit status (the
	 * computer restarted) is started again.
	 */
	private followChanges(active: Active, restored: boolean, last?: number): void {
		const { spec } = active;
		// A restored program watch runs when its next run is due; without a record of its last run, one interval on.
		if (spec.program !== undefined) this.followProgram(active, last !== undefined ? Math.max(0, last + spec.every! * 1000 - Date.now()) : restored ? spec.every! * 1000 : 0);
		// Watches from before change watches had a runner start one now.
		else if (!spec.change || !spec.pid) this.relaunch(active);
		let judging = false;
		const tick = () => this.guard(() => {
			if (judging || this.active.get(keyOf(spec)) !== active) return;
			let change: { number?: number; output?: string; before?: string; first?: boolean } | undefined;
			try { change = JSON.parse(readFileSync(spec.change!, "utf8")); } catch { /* none yet */ }
			if (change && typeof change.number === "number" && change.number > active.offset) {
				const { number, output = "", before, first } = change;
				active.offset = number;
				judging = true;
				void this.chain(active, async () => {
					// The first run only sets the baseline, unless a condition can already be true.
					const woke = (!first || !!spec.wakeWhen) && await this.consider(active, output, first ? "checked:" : "changed:", before);
					if (woke && !spec.keep) this.finishWith(active, "it woke you", { kill: true, tell: false });
					else this.owner.progress(spec, { offset: number });
				}).finally(() => { judging = false; });
				return;
			}
			if (spec.program !== undefined || active.launching) return;
			let status: { stopped?: string; error?: string } | undefined;
			try { status = JSON.parse(readFileSync(spec.exit!, "utf8")); } catch { /* still running, or gone without a word */ }
			if (status && status.stopped !== "stopped") {
				this.finishWith(active, status.stopped === "expired" ? "it expired" : status.error ? `its command could not run: ${status.error}` : "its runner stopped", { kill: false });
			// Stopped when its owner last shut down, or gone with the computer: it starts again.
			} else if (status || !alive(spec.pid!)) {
				if (active.relaunched && Date.now() - active.relaunched < RELAUNCH_MS) this.finishWith(active, "its command's runner stopped as soon as it started", { kill: false });
				else this.relaunch(active);
			}
		});
		active.timers.push(setInterval(tick, TAIL_MS));
		tick();
	}

	private relaunch(active: Active): void {
		const { spec } = active;
		const { folder, file } = spec.change ? { folder: dirname(spec.change), file: basename(spec.change, ".change") } : this.owner.place(spec);
		active.launching = true;
		void launchRunner(spec, folder, this.owner.shell(spec.cwd), { runners: this.owner.runners, env: this.owner.environment?.(), file }).then(() => {
			// Ended while it started: nothing will read it.
			if (this.active.get(keyOf(spec)) !== active) { stopCommand(spec); return; }
			active.relaunched = Date.now();
			this.owner.progress(spec, { pid: spec.pid!, run: spec.run });
		}, error => this.finishWith(active, `its command could not start again: ${errorText(error)}`, { kill: false })).finally(() => { active.launching = false; });
	}

	/**
	 * Runs a program watch's program every `every` seconds, writing a changed result to its change file as the runner
	 * does a command's, so it is judged the same way.
	 */
	private followProgram(active: Active, delay = 0): void {
		const { spec } = active;
		const run = async () => {
			if (this.active.get(keyOf(spec)) !== active) return;
			const started = Date.now();
			const output = await this.owner.program(spec, active.abort.signal);
			if (this.active.get(keyOf(spec)) !== active) return;
			if (output === undefined) { active.run = setTimeout(() => this.guard(run), RESUME_MS); return; }
			this.record(spec, output);
			this.owner.progress(spec, { last: started });
			active.run = setTimeout(() => this.guard(run), Math.max(0, started + spec.every! * 1000 - Date.now()));
		};
		active.run = setTimeout(() => this.guard(run), delay);
	}

	/** A run's result, written as the change file's next change when it differs from the last. */
	private record(spec: WatchSpec, result: string): void {
		const output = result.length > RUN_CHARS ? result.slice(-RUN_CHARS) : result;
		const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
		let previous: { number?: number; hash?: string; output?: string } = {};
		try { previous = JSON.parse(readFileSync(spec.change!, "utf8")); } catch { /* the first run */ }
		if (previous.hash === hash) return;
		writeFileSync(`${spec.change}.tmp`, JSON.stringify({ number: (previous.number ?? 0) + 1, hash, output, before: previous.output, first: previous.hash === undefined, at: Date.now() }));
		renameSync(`${spec.change}.tmp`, spec.change!);
	}

	/** Wakes the agent with an event when it meets the watch's condition. True when it woke the agent. */
	private async consider(active: Active, output: string, note: string, previous?: string): Promise<boolean> {
		if (this.closed || this.active.get(keyOf(active.spec)) !== active) return false;
		const condition = active.spec.wakeWhen;
		if (!condition) { this.owner.send(active.spec, message(active.spec, note, output), note, output); return true; }
		try {
			const matched = await this.owner.judge(active.spec, condition, output, previous);
			active.failures = 0;
			if (matched && this.active.get(keyOf(active.spec)) === active) this.owner.send(active.spec, message(active.spec, note, output), note, output);
			else if (!matched && active.spec.mode === "change") {
				active.declined = { at: Date.now(), output: output.length > 200 ? `${output.slice(0, 200)}…` : output };
				this.owner.progress(active.spec, { declined: active.declined });
			}
			return matched;
		} catch (error) {
			if (isStale(error) || this.closed) throw error;
			// A classifier outage must not hide events: wake anyway, and give up on the watch if it persists.
			if (++active.failures >= 3) this.finishWith(active, `its condition could not be checked: ${errorText(error)}`, { kill: true, output });
			else this.owner.send(active.spec, message(active.spec, `${note} (the condition could not be checked: ${errorText(error)})`, output),
				`${note.replace(/:$/, "")} (the condition could not be checked)`, output);
			return true;
		}
	}
}

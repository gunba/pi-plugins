import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getPresentation, type Presentation } from "../pi-ui/index.ts";
import { callDescription } from "../pi-ui/tool-descriptions.ts";
import { registerBash } from "./bash.ts";
import { RUN_PROGRAM, type ProgramRun } from "../pi-tools/saved.ts";
import { alive, briefWatch, clockTime, describeWatch, elapsed, interval, judged, judgement, launchRunner, message, parseTime, pickClassifier,
	PROGRAM_LIMIT_MS, progressLine, SHORT_WAIT_MS, shellFor, stopTree, sweep, watchEvent, when, type Shell, type WatchEvent, type WatchSpec } from "./common.ts";
import { WatchEngine } from "./engine.ts";
import { DeskClient } from "./desk.ts";
import { WATCH_DB, WatchStore } from "./store.ts";
import { activeWatches, announceWatches, Parameters, plannedWatch, RETRY_MS, startedText, WATCH_CHANGED, WATCH_ENTRY, WATCH_MESSAGE, watchList,
	type Params, type WatchBackend, type WatchRecord } from "./tool.ts";

export { activeWatches, briefWatch, describeWatch, elapsed, interval, parseTime, WATCH_CHANGED, WATCH_ENTRY, WATCH_MESSAGE, watchList,
	type WatchBackend, type WatchEvent, type WatchSpec };

/** A program's result as text, from pi-tools; a failure or a missing pi-tools is the text of what happened. */
function runProgram(pi: ExtensionAPI, ctx: ExtensionToolContext, code: string, signal: AbortSignal): Promise<string> {
	return new Promise(resolve => {
		const controller = new AbortController(), stop = () => controller.abort();
		const timer = setTimeout(stop, PROGRAM_LIMIT_MS);
		signal.addEventListener("abort", stop, { once: true });
		let claimed = false, answered = false;
		const done = (text: string) => {
			if (answered) return;
			answered = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
			resolve(controller.signal.aborted && !signal.aborted ? `${text}\n(stopped after ${PROGRAM_LIMIT_MS / 1000} s)`.trim() : text);
		};
		pi.events.emit(RUN_PROGRAM, { ctx, code, signal: controller.signal, claim: () => { claimed = true; }, done } satisfies ProgramRun);
		if (!claimed) done("(could not run: programs need pi-tools)");
	});
}

/**
 * Watches run in this conversation's process, for Pi without Desk: recorded in its entries, followed while it runs and
 * picked up again when it next starts. With Desk, desk.ts hands them to Desk instead.
 */
export class Watches implements WatchBackend {
	readonly sessionId: string;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly folder: string;
	private readonly engine: WatchEngine;
	private outbox: { id: string; text: string; event: WatchEvent }[] = [];
	private retry?: NodeJS.Timeout;
	private closed = false;
	/** The host's presentation, kept for reading how the conversation closes once it is shutting down. */
	private presentation?: Presentation;
	/** The agent asked for this conversation to close when its turn ends (watch's close). */
	private closing = false;
	/** Between agent_start and agent_end: an event can join the run at its next step. */
	private readonly running: () => boolean;
	/** The context of the agent's latest watch or bash call, which program watches run with. */
	private toolContext?: ExtensionToolContext;
	/** Program watches told they can't run until the agent calls watch or bash. */
	private readonly waiting = new Set<string>();

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, running: () => boolean) {
		this.pi = pi;
		this.ctx = ctx;
		this.running = running;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.folder = join(getAgentDir(), "watch", this.sessionId);
		this.engine = new WatchEngine({
			place: spec => ({ folder: this.folder, file: spec.id }),
			shell: () => this.shell(),
			absent: "the conversation",
			progress: (spec, progress) => {
				if (progress.offset !== undefined) this.pi.appendEntry(WATCH_ENTRY, { op: "seen", id: spec.id, offset: progress.offset } satisfies WatchRecord);
				if (progress.pid !== undefined) this.pi.appendEntry(WATCH_ENTRY, { op: "runner", id: spec.id, pid: progress.pid } satisfies WatchRecord);
			},
			send: (spec, text, status, output) => this.send(spec, text, status, output),
			ended: (spec, reason, wake) => {
				this.waiting.delete(spec.id);
				this.pi.appendEntry(WATCH_ENTRY, { op: "end", id: spec.id, reason } satisfies WatchRecord);
				if (wake) this.send(spec, wake.text, wake.status, wake.output);
			},
			judge: async (spec, condition, output) => {
				const model = pickClassifier(await this.ctx.modelRegistry.getAvailableOfType("classifier"));
				if (!model) throw new Error("no classifier model is signed in");
				return judged(await this.ctx.modelRegistry.classify(model, judgement(spec, condition, output)));
			},
			program: async (spec, signal) => {
				const ctx = this.toolContext;
				if (!ctx) {
					if (!this.waiting.has(spec.id)) {
						this.waiting.add(spec.id);
						this.send(spec, message(spec, "can't run its program: this conversation was restarted, and programs run with your calls. Call watch({}) to resume it."),
							"waiting for the agent to resume it");
					}
					return undefined;
				}
				this.waiting.delete(spec.id);
				return runProgram(this.pi, ctx, spec.program!, signal);
			},
			changed: () => this.publish(),
			failed: error => this.failed(error),
		});
	}

	get bashFolder(): string { return join(this.folder, "bash"); }

	/** Rebuilds this branch's watches from its entries and picks each one back up. */
	restore(): void {
		const specs = new Map<string, WatchSpec>(), seen = new Map<string, number>();
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord;
			if (record.op === "start") specs.set(record.watch.id, { ...record.watch });
			else if (record.op === "end") { specs.delete(record.id); seen.delete(record.id); }
			else if (record.op === "runner") { const spec = specs.get(record.id); if (spec) spec.pid = record.pid; }
			// Older change watches recorded an output hash here rather than an offset; those are skipped.
			else if (record.op === "seen" && typeof record.offset === "number") seen.set(record.id, record.offset);
		}
		for (const spec of specs.values()) {
			if (spec.computer !== hostname()) {
				const reason = "the conversation moved to another computer, so the watch stopped";
				this.pi.appendEntry(WATCH_ENTRY, { op: "end", id: spec.id, reason } satisfies WatchRecord);
				this.send(spec, spec.mode === "time" ? `Watch ${spec.id}: ${reason}.` : message(spec, `ended: ${reason}.`), spec.mode === "time" ? reason : `ended: ${reason}`);
				continue;
			}
			this.engine.arm(spec, { offset: seen.get(spec.id) }, true);
		}
		this.publish();
	}

	/**
	 * Stops following this conversation's watches. Background commands keep running and are picked up when it resumes.
	 * At shutdown, change watches' runners stop too, unless the host keeps the conversation to wake it on their news
	 * (Presentation.closing "sleep"); they start again when it resumes.
	 */
	close(shutdown = false): void {
		if (shutdown && this.presentation?.closing !== "sleep") this.engine.stopRunners();
		this.closed = true;
		this.engine.close();
		if (this.retry) clearTimeout(this.retry);
		announceWatches(this.pi, this.sessionId, undefined);
	}

	private guard(work: () => unknown): void {
		if (this.closed) return;
		try {
			const result = work();
			if (result instanceof Promise) result.catch(error => this.failed(error));
		} catch (error) { this.failed(error); }
	}

	/** Once the session's context is stale, the watches stop following (their commands keep running for its next start). */
	private failed(error: unknown): void {
		if (this.closed) return;
		if (/\bstale\b/i.test(error instanceof Error ? error.message : String(error))) this.close();
		else console.error(`pi-watch: ${error instanceof Error ? error.message : String(error)}`);
	}

	data() { return this.engine.specs().map(spec => ({ ...spec })); }

	/** Program watches run with the context of a call the agent made in this process; a restart leaves them waiting. */
	useContext(ctx: ExtensionToolContext): void { this.toolContext = ctx; }

	async call(input: Params, ctx: ExtensionContext, label?: string): Promise<string> {
		const { close: asked, ...params } = input;
		// A program watch runs in this process, so the conversation can't sleep while one is active.
		const programs = params.program !== undefined || this.engine.specs().some(spec => spec.program !== undefined);
		const close = asked && !programs;
		if (close) {
			this.closing = true;
			this.publish();
		}
		const closing = asked && programs ? " The conversation stays open: program watches run only while it is open."
			: !close ? "" : this.engine.size || params.command !== undefined || params.until !== undefined
			? " This conversation closes when this turn ends; Desk reopens it when a watch has news."
			: " This conversation closes when this turn ends. It has no watches, so it stays closed until the user opens it.";
		if (close && Object.values(params).every(value => value === undefined)) return `${closing.trim()} ${this.list()}`;
		return `${await this.start(params, ctx, label)}${closing}`;
	}

	keepOpen(): void {
		if (!this.closing) return;
		this.closing = false;
		this.publish();
	}

	private async start(params: Omit<Params, "close">, ctx: ExtensionContext, label?: string): Promise<string> {
		const given = Object.entries(params).filter(([, value]) => value !== undefined).map(([key]) => key);
		if (params.stop !== undefined) {
			if (given.length > 1) throw new Error("stop takes no other parameters.");
			const id = params.stop.trim(), spec = this.engine.specs().find(item => item.id === id);
			// Usually it ended on its own before the stop arrived; the goal (it is not running) holds either way.
			if (!spec) return `${params.stop} is not running. ${this.list()}`;
			this.engine.end(id, "you stopped it", { kill: true, tell: false });
			return `Stopped ${spec.id}${spec.pid ? " and its command" : ""}. ${this.list()}`;
		}
		const { stop: _stop, ...asked } = params;
		if (asked.command === undefined && asked.until === undefined && asked.program === undefined) {
			if (given.length) throw new Error("Give command, program or until.");
			return this.list();
		}
		if (asked.computer !== undefined) throw new Error("Watches on other computers need Desk, which isn't running here.");
		const times = this.engine.specs().filter(spec => spec.mode === "time").length;
		const spec = plannedWatch(asked, ctx, label, { times, commands: this.engine.size - times }, () => this.list());
		if (spec.wakeWhen && !pickClassifier(await ctx.modelRegistry.getAvailableOfType("classifier")))
			throw new Error("wake_when needs a classifier model, such as System One's Jev (/login typesafe). Leave wake_when out to be woken for every event.");
		spec.id = this.nextId();
		if (spec.program !== undefined) {
			mkdirSync(this.folder, { recursive: true });
			spec.change = join(this.folder, `${spec.id}.change`);
			rmSync(spec.change, { force: true });
		} else if (spec.mode !== "time") this.launch(spec);
		this.pi.appendEntry(WATCH_ENTRY, { op: "start", watch: spec } satisfies WatchRecord);
		this.engine.arm(spec);
		this.publish();
		const text = startedText(spec);
		return spec.program !== undefined ? text.replace(" End your turn now", " It runs while this conversation is open. End your turn now") : text;
	}

	private list(): string {
		const specs = this.engine.specs();
		if (!specs.length) return "No active watches.";
		return `Active watches:\n${specs.map(spec => {
			const readings = this.engine.readings(spec.id);
			return `- ${spec.id}: ${briefWatch(spec)}${spec.mode !== "time" && spec.expires ? `; ends ${when(spec.expires)}` : ""}${spec.bash ? `; running ${elapsed(Date.now() - spec.bash.started)}${readings.length ? `; ${progressLine([...readings])}` : ""}` : ""}`;
		}).join("\n")}`;
	}

	/**
	 * An id no watch in this session has had, on any branch, since ids name files in this folder. pi-session-memory
	 * releases the data of other branches' entries in a compacted session, so the folder's files count too.
	 */
	private nextId(): string {
		let highest = 0;
		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord | undefined;
			if (record?.op === "start") highest = Math.max(highest, Number(record.watch.id.slice(1)) || 0);
			else if (record?.op === "desk") highest = Math.max(highest, Number(record.id.slice(1)) || 0);
		}
		for (const name of existsSync(this.folder) ? readdirSync(this.folder) : []) highest = Math.max(highest, Number(/^w(\d+)\./.exec(name)?.[1]) || 0);
		return `w${highest + 1}`;
	}

	shell(): Shell { return shellFor(this.ctx.cwd, getAgentDir(), this.ctx.isProjectTrusted()); }

	launch(spec: WatchSpec, folder = this.folder, env?: NodeJS.ProcessEnv): ChildProcess { return launchRunner(spec, folder, this.shell(), env); }

	adopt(spec: WatchSpec): WatchSpec {
		spec.id = this.nextId();
		this.pi.appendEntry(WATCH_ENTRY, { op: "start", watch: spec } satisfies WatchRecord);
		this.engine.arm(spec, { offset: 0 });
		this.publish();
		return spec;
	}

	/** Queues a wake: `text` for the agent, `status` and `output` for the user. */
	private send(spec: WatchSpec, text: string, status: string, output?: string): void {
		this.outbox.push({ id: spec.id, text, event: watchEvent(spec, status, output) });
		this.flush();
	}

	/**
	 * Delivers waiting events as one message. While the agent is working they join its run at the next step, so it knows
	 * before it answers; held until its turn ended, they would start a turn of their own about what it had already seen.
	 * Otherwise, once it is idle with no input waiting, they start a turn.
	 */
	private flush(): void {
		if (this.closed || !this.outbox.length || this.retry) return;
		const suspended = getPresentation(this.pi)?.suspended, running = !suspended && this.running();
		if (!running && (suspended || !this.ctx.isIdle() || this.ctx.hasPendingMessages())) {
			this.retry = setTimeout(() => { this.retry = undefined; this.guard(() => this.flush()); }, RETRY_MS);
			return;
		}
		const items = this.outbox;
		this.outbox = [];
		this.pi.sendMessage({ customType: WATCH_MESSAGE, content: items.map(item => item.text).join("\n\n"), display: true,
			details: { watches: [...new Set(items.map(item => item.id))], events: items.map(item => item.event) } },
			{ deliverAs: running ? "steer" : "followUp", triggerTurn: true });
	}

	private stop(id: string): void { this.engine.end(id, "Jordan stopped it", { kill: true }); }

	stopRun(spec: WatchSpec): void { if (spec.pid && alive(spec.pid)) stopTree(spec.pid); }

	private publish(): void {
		if (this.closed) return;
		const specs = this.engine.specs();
		announceWatches(this.pi, this.sessionId, specs.map(spec => `${spec.id}: ${describeWatch(spec)}`));
		if (this.ctx.hasUI) this.ctx.ui.setStatus("pi-watch", specs.length ? `watching ${specs.length}` : undefined);
		const presentation = getPresentation(this.pi);
		if (presentation) this.presentation = presentation;
		if (!presentation || presentation.suspended) return;
		// A background bash command wakes a sleeping conversation only at its end and its warnings.
		const warning = (bash: NonNullable<WatchSpec["bash"]>) => bash.started + Math.ceil((Date.now() + 1 - bash.started) / (bash.warn! * 1000)) * bash.warn! * 1000;
		const times = specs.flatMap(spec => spec.mode === "time" ? [spec.at!] : spec.bash?.warn ? [warning(spec.bash)] : []);
		// A program watch's change file is written by this process, so it can't wake a sleeping conversation.
		const files = specs.flatMap(spec => spec.program !== undefined ? [] : spec.bash ? [spec.exit!] : spec.mode === "output" ? [spec.log!, spec.exit!]
			: spec.mode === "change" ? [spec.change!, spec.exit!] : []);
		const reading = (id: string) => this.engine.readings(id).at(-1)?.value;
		presentation.publish("pi-watch", specs.length || this.closing ? {
			kind: "details", title: "Watches", ...(times.length ? { wakes: Math.min(...times) } : {}),
			...(specs.some(spec => spec.mode !== "time") ? { watching: true } : {}),
			...(specs.some(spec => spec.mode === "change") ? { watchEvery: Math.min(...specs.flatMap(spec => spec.mode === "change" ? [spec.every!] : [])) } : {}),
			...(files.length ? { wakeFiles: files } : {}), ...(this.closing ? { close: true } : {}),
			data: { items: specs.map(spec => ({ id: spec.id, title: spec.label ?? describeWatch(spec), ...(spec.mode === "time" ? { at: spec.at } : {}),
				subtitle: [spec.id, ...(spec.label ? [describeWatch(spec)] : []), ...(spec.mode !== "time" && spec.expires ? [`ends ${when(spec.expires)}`] : []),
					...(spec.bash ? [`started ${clockTime(spec.bash.started)}`] : []), ...(reading(spec.id) ? [`progress ${reading(spec.id)}`] : [])].join(" · "),
				actions: [{ id: `stop:${spec.id}`, label: "Stop", destructive: true }] })) },
			...(specs.length ? { badges: [{ label: "Watching", value: String(specs.length), icon: "eye" as const, compact: true,
				description: specs.map(spec => `${spec.id}: ${spec.label ?? describeWatch(spec)}`).join("\n") }] } : {}),
		} : undefined, Object.fromEntries(specs.map(spec => [`stop:${spec.id}`, () => this.stop(spec.id)])));
	}
}

/** Whether Desk runs this computer's watches: in a Desk worker, or with Desk's host running for this agent folder. */
function deskStore(pi: ExtensionAPI): WatchStore | undefined {
	const directory = join(getAgentDir(), "party");
	if (getPresentation(pi)) return new WatchStore(directory);
	if (!existsSync(join(directory, WATCH_DB))) return undefined;
	const store = new WatchStore(directory);
	if (store.hostOnline()) return store;
	store.close();
	return undefined;
}

export default function watch(pi: ExtensionAPI): void {
	let watches: WatchBackend | undefined, running = false;
	// Desk's background process for watches' programs (pi-desk program-runner.ts) has no conversation to wake, so its
	// programs can't start watches, and its bash commands run to their end within the program's time.
	const background = !!process.env.PI_DESK_BACKGROUND;
	const start = (ctx: ExtensionContext) => {
		watches?.close();
		const store = background ? undefined : deskStore(pi);
		watches = store ? new DeskClient(pi, ctx, () => running, store) : new Watches(pi, ctx, () => running);
		watches.restore();
		if (!store) sweepOnce(join(getAgentDir(), "watch"));
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => { watches?.close(true); watches = undefined; labels.clear(); });
	// Pi drains a run's steering before agent_end and continues for any queued after; later events wait for idle.
	pi.on("agent_start", () => { running = true; });
	pi.on("agent_end", () => { running = false; });
	// The description a call carries (pi-ui/tool-descriptions.ts) is removed before the tool runs; it labels the watch.
	const labels = new Map<string, string>();
	// A message from the user means they are here: a close the agent asked for earlier no longer applies.
	pi.on("input", event => { if (event.source !== "extension") watches?.keepOpen(); });
	pi.on("tool_call", event => {
		const label = event.toolName === "watch" || event.toolName === "bash" ? callDescription(event.input) : undefined;
		if (label) labels.set(event.toolCallId, label.slice(0, 200));
	});
	registerBash(pi, () => watches, labels, background);
	pi.registerTool({
		name: "watch",
		label: "Watch",
		description: "Wait without spending turns, instead of sleeping or polling: end your turn and be woken by a background command's output, "
			+ "a change in a re-run command or program, or a time. Watches run outside the conversation, which can close: Desk reopens it for their news, "
			+ "and runs them on another of Jordan's computers when asked (computer). For recurring checks, prefer command or program with every "
			+ "(and keep, to go on reporting): it runs without you and wakes you only when its result changes, rather than a time watch that wakes you to check. "
			+ "No arguments lists watches.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(id, params: Params, _signal, _update, ctx) {
			const label = labels.get(id);
			labels.delete(id);
			if (!watches || watches.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Watches are not ready in this conversation.");
			if (background) throw new Error("A watch's program can't start watches: its result is what wakes the agent.");
			// A program's calls have ids "<program call>/<n>". There, a short until reads as a pause, but it only queues a
			// wake for after the turn: a program looping to wait for a page set ten, all arriving together.
			if (id.includes("/") && params.until !== undefined && parseTime(params.until) - Date.now() < SHORT_WAIT_MS)
				throw new Error("watch doesn't pause a program: it returns at once and wakes you after your turn, so this would only "
					+ "queue a wake. To wait for a page, have chrome_devtools_evaluate await it in the page (awaitPromise: true), "
					+ "e.g. new Promise(r => setTimeout(r, 4000)); to wait longer, end your turn with a watch.");
			watches.useContext(ctx);
			const text = await watches.call(params, ctx, label);
			return { content: [{ type: "text", text }], details: {},
				structuredContent: JSON.parse(JSON.stringify({ text, watches: watches.data() })) };
		},
	});
}

let swept = false;
/** Removes, once a process, the files of this computer's watches that ended more than a week ago. */
function sweepOnce(root: string): void {
	if (swept) return;
	swept = true;
	sweep(root);
}

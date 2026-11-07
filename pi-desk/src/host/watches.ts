import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, watch as watchFolder, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { alive, describeWatch, DESK_FOLDER, errorText, interval, judged, judgement, launchRunner, MAX_COMMANDS, message, pickClassifier, shellFor, stopTree, subject,
	sweep, watchEvent, type WatchEvent, type WatchSpec } from "../../../pi-watch/common.ts";
import { WatchEngine } from "../../../pi-watch/engine.ts";
import { WATCH_SIGNAL, WatchStore, type EventRow, type KnownComputer, type WatchRow } from "../../../pi-watch/store.ts";
import { ServiceUsage } from "../../../pi-service-usage/index.ts";
import { trackServiceModels } from "../../../pi-service-usage/models.ts";
import type { WatchSummary } from "../shared/watches.ts";
import { ProgramRunner } from "./program-runner.ts";

/** A stop that the agent is told of; it isn't when it stopped the watch itself or its conversation went. */
export const JORDAN_STOPPED = "Jordan stopped it";
export { CLOSED, MOVED, REMOVED } from "../../../pi-watch/common.ts";
/** What computers announce when they run watches for agents on other computers, and the packets those watches use. */
export const WATCHES = "watches";
export const WATCH_PACKETS = new Set(["watch-requests", "watch-results", "watch-events", "watch-acks"]);
/** Rows and events are checked this often, besides when a Pi process signals a change. */
const SCAN_MS = 5_000;
/** A conversation that could not be reopened for its watch's news is tried again after this long. */
const WAKE_RETRY_MS = 15 * 60_000;
/** Another computer that hasn't answered a request for a watch by now won't: the agent is told. */
const ANSWER_MS = 10 * 60_000;
/** The Pi process waits this long for the other computer's answer (desk.ts); a refusal after it is an event. */
const ASKER_WAITS_MS = 60_000;
/** A classifier that wasn't signed in is looked for again after this long. */
const CLASSIFIER_RETRY_MS = 60_000;
const HOUSEKEEPING_MS = 3_600_000;

export interface WatchHost {
	readonly agentDir: string;
	readonly sessionDir?: string;
	readonly deskDirectory: string;
	closing(): boolean;
	/** Whether the agent's conversation is running here, though its Pi process may not have checked in yet (store.touchAgent). */
	live(agent: string): boolean;
	/** Reopens the agent's conversation for its watches' news: "later" when Desk can't now, "gone" when it isn't here to reopen. */
	wake(agent: string): "waking" | "later" | "gone";
	/** The agent's watches changed: a conversation that isn't running shows them from here. */
	hints(agents: ReadonlySet<string>): void;
	/** Whether an agent on another computer is in that computer's directory here. */
	member(computer: string, agent: string): boolean;
	/** The other computers in the workspace. */
	computers(): KnownComputer[];
	/** This computer's ID in the workspace. */
	self(): string | undefined;
	/** An agent's name as Desk here shows it. */
	label(agent: string, computer?: string): string;
	/** There are packets for other computers. */
	flush(): void;
	/** What the app shows of the watches changed. */
	changed(): void;
}

type Request = { id: string; op: "create" | "stop"; agent: string; name: string; spec?: Partial<WatchSpec>; reason?: string; created: number };
type Result = { id: string; op: "create" | "stop"; state: "running" | "ended"; reason?: string };
type WireEvent = { id: string; watch: string; agent: string; name: string; text: string; event?: WatchEvent; ended?: string; created: number };
export type WatchPacket = { type: "watch-requests"; requests: Request[] } | { type: "watch-results"; results: Result[] }
	| { type: "watch-events"; events: WireEvent[] } | { type: "watch-acks"; ids: string[] };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid watch packet.");
	return value as Record<string, unknown>;
}
const uuid = (value: unknown) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid watch id."); return value; };
const text = (value: unknown, max: number) => { if (typeof value !== "string" || value.length > max) throw new Error("Invalid watch text."); return value; };
const optional = (value: unknown, max: number) => value === undefined || value === null ? undefined : text(value, max);
const whole = (value: unknown, min = 0) => { if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid watch number."); return value as number; };
/** What another computer is sent of a watch: what to run and when, never where its files are. */
const wire = (spec: WatchSpec): Partial<WatchSpec> => ({ mode: spec.mode, ...(spec.command !== undefined ? { command: spec.command } : {}),
	...(spec.program !== undefined ? { program: spec.program } : {}), ...(spec.every ? { every: spec.every } : {}), ...(spec.wakeWhen ? { wakeWhen: spec.wakeWhen } : {}),
	...(spec.keep ? { keep: true } : {}), cwd: spec.cwd, ...(spec.expires ? { expires: spec.expires } : {}), ...(spec.label ? { label: spec.label } : {}) });
/** A watch as Jordan reads it in the app: its label or what it runs, then how it runs and when it wakes its agent. */
function summary(spec: WatchSpec): { title: string; detail: string } {
	const short = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
	const what = spec.mode === "time" ? undefined : short(subject(spec), 160);
	return { title: spec.label ?? what ?? "Wake-up", detail: [...spec.label && what ? [what] : [], ...spec.bash ? ["background command"] : [],
		...spec.mode === "change" && spec.every ? [`every ${interval(spec.every)}`] : [], ...spec.wakeWhen ? [`wakes it when ${short(spec.wakeWhen, 200)}`] : [],
		...spec.keep ? ["keeps reporting"] : []].join(" · ") };
}
function wireEvent(value: unknown): WatchEvent | undefined {
	if (value === undefined || value === null) return undefined;
	const input = record(value);
	return { id: text(input.id, 40), title: text(input.title, 2000), status: text(input.status, 2000), ...(input.command !== undefined ? { command: text(input.command, 100_000) } : {}),
		...(input.output !== undefined ? { output: text(input.output, 20_000) } : {}), ...(input.log !== undefined ? { log: text(input.log, 4096) } : {}) };
}

/**
 * The computer's watches, run by Desk (pi-watch/engine.ts) rather than by the conversations they wake: they go on
 * while those close, restart or move, Desk reopens a conversation for its watch's news, and an agent on another
 * computer can have one here. Pi processes ask for them and receive their events through the store (pi-watch/desk.ts).
 */
export class WatchService {
	private readonly host: WatchHost;
	private readonly store: WatchStore;
	private readonly engine: WatchEngine;
	private readonly folder: string;
	private readonly programs: ProgramRunner;
	/** The watches the engine follows, by id. Their specs are the engine's, which it updates (a runner started again). */
	private readonly armed = new Map<string, WatchRow>();
	private readonly wakeTried = new Map<string, number>();
	/** Requests from other computers being worked on, by watch id; a repeat waits for the first's answer. */
	private readonly handling = new Set<string>();
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private soon?: NodeJS.Timeout;
	private announce?: NodeJS.Timeout;
	private models?: { runtime: Promise<ModelRuntime>; missing?: number };
	private housekept = 0;
	private closed = false;

	constructor(host: WatchHost) {
		this.host = host;
		this.store = new WatchStore(join(host.agentDir, "party"));
		this.folder = join(host.agentDir, "watch", DESK_FOLDER);
		this.programs = new ProgramRunner({ agentDir: host.agentDir, sessionDir: host.sessionDir, deskDirectory: host.deskDirectory });
		this.engine = new WatchEngine({
			place: spec => ({ folder: this.folder, file: spec.key! }),
			shell: cwd => shellFor(cwd, host.agentDir, false),
			environment: () => this.environment(),
			absent: "Desk",
			progress: (spec, progress) => {
				const row = this.armed.get(spec.key!);
				if (!row) return;
				row.progress = { ...row.progress, ...progress };
				this.store.setProgress(row.id, row.progress);
				if (progress.pid !== undefined) this.store.setSpec(row.id, row.spec);
			},
			send: (spec, text, status, output) => {
				const row = this.armed.get(spec.key!);
				if (row) this.emit(row, text, { event: watchEvent(spec, status, output) });
			},
			ended: (spec, reason, wake) => {
				const row = this.armed.get(spec.key!) ?? this.store.get(spec.key!);
				this.armed.delete(spec.key!);
				this.store.setState(spec.key!, "ended", reason);
				if (row) {
					this.emit(row, wake?.text ?? "", { ended: reason, ...(wake ? { event: watchEvent(spec, wake.status, wake.output) } : {}) });
					this.touched(row.agent);
				}
				this.retainPrograms();
			},
			judge: (spec, condition, output) => this.judge(spec, condition, output),
			program: (spec, signal) => this.programs.run(spec.cwd, spec.program!, signal),
			changed: () => this.readings(),
			failed: error => console.error(`Watches: ${errorText(error)}`),
		});
	}

	start(): void {
		mkdirSync(this.folder, { recursive: true });
		this.heartbeat();
		try {
			this.watcher = watchFolder(this.store.directory, (_event, name) => { if (String(name) === WATCH_SIGNAL) this.scanSoon(); });
			this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
		} catch { /* the timer still scans */ }
		this.timer = setInterval(() => this.scan(), SCAN_MS);
		this.timer.unref();
		this.scan();
	}

	/** Tells Pi processes Desk is running here, and which computers they can name. */
	heartbeat(): void {
		if (this.closed) return;
		try {
			this.store.touchHost();
			this.store.setComputers(this.host.computers());
			const self = this.host.self();
			if (self) this.store.setSelf(self);
		} catch (error) { console.error(`Watches: ${errorText(error)}`); }
	}

	/** Stops following the watches; their commands go on, and Desk follows them again when it starts. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.watcher?.close();
		clearInterval(this.timer); clearTimeout(this.soon); clearTimeout(this.announce);
		this.engine.close();
		try { this.store.stopHost(); } catch { /* closing anyway */ }
		await this.programs.close();
		this.store.close();
	}

	private scanSoon(): void {
		if (this.closed || this.soon) return;
		this.soon = setTimeout(() => { this.soon = undefined; this.scan(); }, 30);
	}

	/** Starts new watches, stops those asked to stop, ends unanswered requests, and delivers what is waiting. */
	private scan(): void {
		if (this.closed || this.host.closing()) return;
		try {
			const agents = new Set<string>(), known = new Set(this.host.computers().map(computer => computer.id));
			for (const row of this.store.local()) {
				// One for an agent whose computer left the workspace has no one to tell.
				if (row.home && known.size && !known.has(row.home) && row.state !== "stopping") this.store.setState(row.id, "stopping", "the agent's computer left the workspace");
				else if (row.state === "stopping") { this.stopRow(row); agents.add(row.agent); }
				else if (!this.armed.has(row.id)) { this.arm(row); agents.add(row.agent); }
			}
			for (const row of this.store.mirrors()) {
				// A request no answer came for in time, or for a computer that left the workspace, ends.
				if (row.state === "new" && Date.now() - row.created > ANSWER_MS || known.size && !known.has(row.runs)) {
					const reason = row.state === "new" ? `${row.spec.computer} didn't answer within ${ANSWER_MS / 60_000} minutes` : `${row.spec.computer} left the workspace`;
					this.store.setState(row.id, "ended", reason);
					if (row.state !== "stopping") this.emit(row, `Watch ${row.name} on ${row.spec.computer} ended: ${reason}.`, { ended: reason });
					agents.add(row.agent);
				}
			}
			for (const agent of this.store.waitingAgents()) this.deliver(agent);
			if (this.store.waitingHomes().length || this.store.mirrors().some(row => row.state === "new" || row.state === "stopping")) this.host.flush();
			for (const agent of agents) this.touched(agent);
			if (Date.now() - this.housekept > HOUSEKEEPING_MS) this.housekeeping();
		} catch (error) { console.error(`Watches: ${errorText(error)}`); }
	}

	private housekeeping(): void {
		this.housekept = Date.now();
		this.store.prune();
		// Files the engine follows stay, whenever they last changed (a re-run command writes only on a change).
		const inUse = new Set<string>();
		for (const row of this.armed.values()) {
			for (const file of [row.spec.log, row.spec.exit, row.spec.change]) if (file) { inUse.add(file); inUse.add(resolve(file, "..")); }
			inUse.add(join(this.folder, `${row.id}.json`));
		}
		sweep(join(this.host.agentDir, "watch"), { inUse, desk: true });
	}

	/** Follows a watch: a new one starts here (a runner for a command, a change file for a program); one Desk followed before goes on. */
	private arm(row: WatchRow): void {
		const spec: WatchSpec = { ...row.spec, id: row.name, key: row.id };
		const fresh = row.state === "new" && !spec.pid && !spec.log && !spec.change;
		try {
			if (fresh && spec.program !== undefined) {
				mkdirSync(this.folder, { recursive: true });
				spec.change = join(this.folder, `${row.id}.change`);
				rmSync(spec.change, { force: true });
			} else if (fresh && spec.mode !== "time") launchRunner(spec, this.folder, shellFor(spec.cwd, this.host.agentDir, false), this.environment(), row.id);
		} catch (error) {
			const reason = `it could not start: ${errorText(error)}`;
			this.store.setState(row.id, "ended", reason);
			// The agent asking waits for this (desk.ts); one handed over from its conversation is told.
			if (!fresh) this.emit(row, message(spec, `ended: ${reason}.`), { ended: reason });
			return;
		}
		if (row.state === "new") {
			this.store.setSpec(row.id, spec);
			this.store.setState(row.id, "running", undefined, ["new"]);
		}
		const armed: WatchRow = { ...row, spec, state: "running" };
		this.armed.set(row.id, armed);
		this.engine.arm(spec, row.progress, !fresh);
		this.retainPrograms();
	}

	/** Ends a watch asked to stop; the agent is told when Jordan stopped it, not when it asked itself or its conversation went. */
	private stopRow(row: WatchRow): void {
		const reason = row.reason ?? "it was stopped", tell = reason === JORDAN_STOPPED;
		if (this.engine.end(row.id, reason, { kill: true, tell })) return;
		this.armed.delete(row.id);
		this.store.setState(row.id, "ended", reason);
		if (row.spec.pid && alive(row.spec.pid)) stopTree(row.spec.pid);
		const spec = { ...row.spec, id: row.name };
		this.emit(row, tell ? spec.mode === "time" ? `Watch ${row.name}: ${reason}.` : message(spec, `ended: ${reason}.`) : "", { ended: reason });
	}

	/**
	 * The environment Desk's runners give commands: a conversation's process's, as Desk starts them (worker-registry.ts),
	 * without Desk's own settings, and with Pi's bin folder first on PATH, as the bash tool does.
	 */
	private environment(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("PI_DESK_")));
		const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH", bin = join(this.host.agentDir, "bin");
		const delimiter = process.platform === "win32" ? ";" : ":";
		if (!(env[key] ?? "").split(delimiter).includes(bin)) env[key] = [bin, env[key]].filter(Boolean).join(delimiter);
		for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[name];
		env.PI_CODING_AGENT_DIR = this.host.agentDir;
		env.PI_DESK_DATA_DIR = this.host.deskDirectory;
		return env;
	}

	private retainPrograms(): void {
		this.programs.retain(new Set([...this.armed.values()].flatMap(row => row.spec.program !== undefined ? [row.spec.cwd] : [])));
	}

	/** Keeps background commands' progress readings for the agent's view and the app. */
	private readings(): void {
		for (const row of this.armed.values()) {
			if (!row.spec.bash?.progress) continue;
			const readings = [...this.engine.readings(row.id)];
			if (readings.at(-1)?.at === row.progress.readings?.at(-1)?.at) continue;
			row.progress = { ...row.progress, readings };
			this.store.setProgress(row.id, row.progress);
			this.store.signal();
		}
		this.changed();
	}

	private changed(): void {
		if (this.closed || this.announce) return;
		this.announce = setTimeout(() => { this.announce = undefined; if (!this.closed) this.host.changed(); }, 200);
	}

	private touched(agent: string): void {
		this.host.hints(new Set([agent]));
		this.changed();
	}

	/** Records an event for the agent and sends it on: to its Pi process here, or to its computer. */
	private emit(row: WatchRow, text: string, options: { event?: WatchEvent; ended?: string } = {}): void {
		// An end the agent isn't told of matters only to its computer, when that is another one.
		if (!text && !row.home) { this.store.signal(); return; }
		this.store.addEvent({ id: randomUUID(), watch: row.id, agent: row.agent, home: row.home, name: row.name, text, ...(options.event ? { event: options.event } : {}),
			...(options.ended ? { ended: options.ended } : {}), created: Date.now(), state: "pending" });
		this.store.signal();
		if (row.home) this.host.flush(); else this.deliver(row.agent);
	}

	/** An agent here has news: its Pi process delivers it, or Desk reopens its conversation to. */
	private deliver(agent: string): void {
		if (this.store.agentLive(agent) || this.host.live(agent)) { this.wakeTried.delete(agent); return; }
		const tried = this.wakeTried.get(agent);
		if (tried && Date.now() - tried < WAKE_RETRY_MS) return;
		const outcome = this.host.wake(agent);
		if (outcome === "later") return;
		this.wakeTried.set(agent, Date.now());
		// Removed from Desk, moved away or never here: its news has no conversation to go to.
		if (outcome === "gone") this.store.setEvents(this.store.events(agent, "pending").map(event => event.id), "delivered", "pending");
	}

	private runtime(): Promise<ModelRuntime> {
		if (!this.models) {
			const runtime = ModelRuntime.create({ authPath: join(this.host.agentDir, "auth.json"), modelsPath: join(this.host.agentDir, "models.json") }).then(runtime => {
				trackServiceModels(runtime, new ServiceUsage(this.host.agentDir), warning => console.error(warning));
				return runtime;
			});
			this.models = { runtime };
			runtime.catch(() => { if (this.models?.runtime === runtime) this.models = undefined; });
		}
		return this.models.runtime;
	}

	/** The classifier signed in on this computer, if any; one missing is looked for again a minute later, with logins reread. */
	private async classifier() {
		if (this.models?.missing && Date.now() - this.models.missing > CLASSIFIER_RETRY_MS) this.models = undefined;
		const runtime = await this.runtime();
		const model = pickClassifier(await runtime.getAvailableOfType("classifier"));
		if (!model && this.models && !this.models.missing) this.models.missing = Date.now();
		return model ? { runtime, model } : undefined;
	}

	private async judge(spec: WatchSpec, condition: string, output: string): Promise<boolean> {
		const found = await this.classifier();
		if (!found) throw new Error("no classifier model is signed in on this computer");
		return judged(await found.runtime.classify(found.model, judgement(spec, condition, output)));
	}

	/** Whether the agent has watches, here or (its own) on another computer, that haven't ended. */
	has(agent: string | undefined): boolean { return !!agent && !this.closed && this.store.agentWatches(agent).length > 0; }

	/** What a conversation that isn't running shows of its watches, as the agent's own view does while it runs. */
	hints(agent: string): { wakes?: number; watching?: true; watchEvery?: number; waiting?: { title: string; detail?: string }[] } {
		const rows = this.closed ? [] : this.store.agentWatches(agent);
		if (!rows.length) return {};
		const specs = rows.map(row => ({ ...row.spec, id: row.name }));
		const warning = (bash: NonNullable<WatchSpec["bash"]>) => bash.started + Math.ceil((Date.now() + 1 - bash.started) / (bash.warn! * 1000)) * bash.warn! * 1000;
		const times = specs.flatMap(spec => spec.mode === "time" ? [spec.at!] : spec.bash?.warn ? [warning(spec.bash)] : []);
		const every = specs.flatMap(spec => spec.mode === "change" && spec.every ? [spec.every] : []);
		return { ...(times.length ? { wakes: Math.min(...times) } : {}), ...(specs.some(spec => spec.mode !== "time") ? { watching: true } : {}),
			...(every.length ? { watchEvery: Math.min(...every) } : {}),
			waiting: rows.slice(0, 8).map((row, index) => ({ title: (specs[index]!.label ?? describeWatch(specs[index]!)).slice(0, 200),
				detail: [row.name, ...(row.runs ? [`on ${row.spec.computer}`] : [])].join(" · ") })) };
	}

	/**
	 * Ends an agent's watches, here and those it has on other computers, as when its conversation is removed or moves
	 * away. Nobody is told: the conversation that would hear is gone from here.
	 */
	endAgent(agent: string | undefined, reason: string): void {
		if (!agent || this.closed) return;
		for (const row of this.store.agentWatches(agent)) {
			// One asked for elsewhere may have started there already, so it is stopped there too.
			if (row.runs) { if (row.state !== "ended") this.store.setState(row.id, "stopping", reason); continue; }
			if (!this.engine.end(row.id, reason, { kill: true, tell: false })) {
				this.store.setState(row.id, "ended", reason);
				if (row.spec.pid && alive(row.spec.pid)) stopTree(row.spec.pid);
			}
		}
		this.store.signal();
		this.host.flush();
		this.touched(agent);
	}

	/** Every watch this computer runs, and those its agents have elsewhere, for the app. */
	list(): WatchSummary[] {
		if (this.closed) return [];
		const names = new Map(this.host.computers().map(computer => [computer.id, computer.name]));
		return [...this.store.local(), ...this.store.mirrors()].slice(0, 200).map(row => {
			const spec = { ...row.spec, id: row.name };
			return { id: row.id, name: row.name, agent: this.host.label(row.agent, row.home || undefined), ...(row.home ? { home: names.get(row.home) ?? row.home } : {}),
				...(row.runs ? { runs: names.get(row.runs) ?? row.spec.computer } : {}), ...summary(spec), state: row.state === "ended" ? "stopping" : row.state,
				created: row.created, ...(spec.mode === "time" ? { at: spec.at } : {}) };
		});
	}

	/** Jordan stops a watch from the app: here, or by asking the computer running it. */
	stop(id: string): void {
		const row = this.store.get(id);
		if (!row || row.state === "ended") throw new Error("That watch is not running.");
		if (!this.store.setState(id, "stopping", JORDAN_STOPPED, ["new", "running"])) throw new Error("That watch is already stopping.");
		this.store.signal();
		if (row.runs) this.host.flush(); else this.scan();
	}

	/** Packets for another computer that runs watches: requests for watches there, and news for agents there. */
	outgoing(computer: string): WatchPacket[] {
		if (this.closed) return [];
		const packets: WatchPacket[] = [];
		const requests = this.store.mirrors(computer).filter(row => row.state === "new" || row.state === "stopping").slice(0, 8)
			.map((row): Request => row.state === "new" ? { id: row.id, op: "create", agent: row.agent, name: row.name, spec: wire(row.spec), created: row.created }
				: { id: row.id, op: "stop", agent: row.agent, name: row.name, ...(row.reason ? { reason: row.reason } : {}), created: row.created });
		if (requests.length) packets.push({ type: "watch-requests", requests });
		const events = this.store.outgoing(computer, 16);
		if (events.length) packets.push({ type: "watch-events", events: events.map(event => ({ id: event.id, watch: event.watch, agent: event.agent, name: event.name,
			text: event.text, ...(event.event ? { event: event.event } : {}), ...(event.ended ? { ended: event.ended } : {}), created: event.created })) });
		return packets;
	}

	async receive(computer: string, raw: unknown, reply: (packet: WatchPacket) => Promise<void>): Promise<void> {
		if (this.closed) throw new Error("Watches are closed.");
		const packet = record(raw);
		if (packet.type === "watch-requests") {
			if (!Array.isArray(packet.requests) || packet.requests.length > 8) throw new Error("Invalid watch requests.");
			const results: Result[] = [];
			for (const request of packet.requests) {
				const result = await this.request(computer, request);
				if (result) results.push(result);
			}
			if (results.length) await reply({ type: "watch-results", results });
		} else if (packet.type === "watch-results") {
			if (!Array.isArray(packet.results) || packet.results.length > 8) throw new Error("Invalid watch results.");
			for (const result of packet.results) this.answered(computer, result);
		} else if (packet.type === "watch-events") {
			if (!Array.isArray(packet.events) || packet.events.length > 16) throw new Error("Invalid watch events.");
			const ids = packet.events.map(event => this.accept(computer, event));
			await reply({ type: "watch-acks", ids });
		} else if (packet.type === "watch-acks") {
			if (!Array.isArray(packet.ids) || packet.ids.length > 64) throw new Error("Invalid watch acknowledgements.");
			this.store.deleteEvents(packet.ids.map(uuid));
		} else throw new Error("Unknown watch packet.");
	}

	/** Another computer's agent asks for a watch here, or to stop one; undefined while an earlier copy is being worked on. */
	private async request(computer: string, value: unknown): Promise<Result | undefined> {
		const input = record(value), id = uuid(input.id), agent = uuid(input.agent), op = input.op;
		if (op !== "create" && op !== "stop") throw new Error("Invalid watch request.");
		if (this.handling.has(id)) return undefined;
		const existing = this.store.get(id);
		if (existing && (existing.home !== computer || existing.agent !== agent)) return { id, op, state: "ended", reason: "that watch belongs to another agent" };
		if (op === "stop") {
			if (!existing) return { id, op, state: "ended", reason: "it was not running" };
			if (existing.state !== "ended") {
				const reason = optional(input.reason, 200) ?? "you stopped it";
				if (this.store.setState(id, "stopping", reason, ["new", "running"])) this.scan();
			}
			const now = this.store.get(id);
			return { id, op, state: now?.state === "ended" ? "ended" : "running", ...(now?.reason ? { reason: now.reason } : {}) };
		}
		if (existing) return { id, op, state: existing.state === "ended" ? "ended" : "running", ...(existing.reason ? { reason: existing.reason } : {}) };
		this.handling.add(id);
		try {
			const name = text(input.name, 20);
			if (!/^w\d+$/.test(name)) throw new Error("Invalid watch name.");
			const spec = await this.remoteSpec(computer, agent, name, input.spec);
			if (!this.store.insert({ id, agent, home: computer, runs: "", name, spec: { ...spec, key: id }, state: "new", created: Date.now(), progress: {} }))
				return { id, op, state: "ended", reason: `the agent already has a watch called ${name} here` };
			this.arm(this.store.get(id)!);
			const row = this.store.get(id);
			return { id, op, state: row?.state === "ended" ? "ended" : "running", ...(row?.reason ? { reason: row.reason } : {}) };
		} catch (error) { return { id, op, state: "ended", reason: errorText(error).slice(0, 2000) }; }
		finally { this.handling.delete(id); }
	}

	/** A watch another computer's agent asked for, checked here: what it runs, where, and that this computer can judge it. */
	private async remoteSpec(computer: string, agent: string, name: string, raw: unknown): Promise<WatchSpec> {
		const input = record(raw), here = hostname();
		if (!this.host.member(computer, agent)) throw new Error("the agent asking isn't in its computer's directory here");
		if (input.mode !== "output" && input.mode !== "change") throw new Error("only commands and programs run on another computer; time watches run on the agent's own");
		const command = optional(input.command, 100_000), program = optional(input.program, 400_000);
		if ((command === undefined) === (program === undefined)) throw new Error("give a command or a program");
		const every = input.every === undefined ? undefined : whole(input.every, 1);
		if (input.mode === "change" ? every === undefined : every !== undefined || program !== undefined) throw new Error("every goes with a re-run command or a program");
		const wakeWhen = optional(input.wakeWhen, 4_000)?.trim() || undefined, label = optional(input.label, 200);
		const expires = input.expires === undefined ? undefined : whole(input.expires);
		if (expires !== undefined && expires <= Date.now()) throw new Error("it would already have ended");
		const asked = optional(input.cwd, 4_096)?.trim(), cwd = asked ? resolve(homedir(), asked) : homedir();
		try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { throw new Error(`there is no folder ${cwd} on ${here}`); }
		const running = this.store.local().filter(row => row.agent === agent && row.home === computer && row.spec.mode !== "time" && !row.spec.bash).length;
		if (running >= MAX_COMMANDS) throw new Error(`the agent already has ${MAX_COMMANDS} command watches on ${here}`);
		if (wakeWhen && !(await this.classifier())) throw new Error(`wake_when needs a classifier model on ${here}, such as TypeSafe's Jev: sign in there (/login typesafe), or leave wake_when out`);
		return { id: name, mode: input.mode, ...(command !== undefined ? { command } : { program: program! }), ...(every !== undefined ? { every } : {}),
			...(wakeWhen ? { wakeWhen } : {}), ...(input.keep === true ? { keep: true } : {}), cwd, created: Date.now(), ...(expires !== undefined ? { expires } : {}),
			computer: here, remote: true, ...(label ? { label } : {}) };
	}

	/** The computer running a watch an agent here asked for has answered. */
	private answered(computer: string, value: unknown): void {
		const input = record(value), id = uuid(input.id), row = this.store.get(id);
		if (!row || row.runs !== computer) return;
		if (input.state === "running") {
			if (row.state === "new") this.store.setState(id, "running", undefined, ["new"]);
			// It started after this computer had given up on it: it is stopped there, quietly, as nothing here wants its news.
			else if (row.state === "ended") this.store.setState(id, "stopping", row.reason, ["ended"]);
		} else if (input.state === "ended") {
			const reason = optional(input.reason, 2_000) ?? "it ended";
			if (row.state !== "ended") this.store.setState(id, "ended", reason);
			// The agent stopped waiting for this answer (desk.ts), so a refusal is news for it.
			if (row.state === "new" && Date.now() - row.created > ASKER_WAITS_MS)
				this.emit(row, `Watch ${row.name} didn't start on ${row.spec.computer}: ${reason}.`, { ended: reason });
		} else throw new Error("Invalid watch result.");
		this.store.signal();
		this.touched(row.agent);
	}

	/** An event from the computer running an agent's watch; its id, to acknowledge, whether it is kept or not. */
	private accept(computer: string, value: unknown): string {
		const input = record(value), id = uuid(input.id), watch = uuid(input.watch), agent = uuid(input.agent);
		const row = this.store.get(watch), body = text(input.text, 1_000_000), ended = optional(input.ended, 2_000);
		// Only news of watches agents here asked for, while they want it, and the news that one ended.
		if (!row || row.runs !== computer || row.agent !== agent) return id;
		// News of one this computer had given up on: it is still running there, so it is stopped.
		if (row.state === "ended" && !ended) { this.store.setState(watch, "stopping", row.reason, ["ended"]); this.host.flush(); return id; }
		if (body && (row.state === "running" || row.state === "new" || row.state === "stopping" && ended))
			this.store.addEvent({ id, watch, agent, home: "", name: row.name, text: body, ...(wireEvent(input.event) ? { event: wireEvent(input.event) } : {}),
				...(ended ? { ended } : {}), created: whole(input.created), state: "pending" } satisfies EventRow);
		if (ended && row.state !== "ended") this.store.setState(watch, "ended", ended);
		this.store.signal();
		if (body) this.deliver(agent);
		this.touched(agent);
		return id;
	}
}

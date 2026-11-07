import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, watch as watchFolder, type FSWatcher } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { getPresentation } from "../pi-ui/index.ts";
import { alive, briefWatch, clockTime, describeWatch, elapsed, interval, launchRunner, message, pickClassifier, progressLine, shellFor, stopTree, watchEvent,
	UNTOLD, when, type Shell, type WatchSpec } from "./common.ts";
import { WATCH_SIGNAL, type KnownComputer, type WatchRow, type WatchStore } from "./store.ts";
import { announceWatches, plannedWatch, RETRY_MS, startedText, WATCH_ENTRY, WATCH_MESSAGE, type Params, type WatchBackend, type WatchRecord } from "./tool.ts";

/** Desk is asked to start a watch here, or another computer to start one there, and given this long to say it has. */
const START_WAIT_MS = 15_000, REMOTE_WAIT_MS = 60_000, STOP_WAIT_MS = 10_000;
/** Events and watches are also checked this often, in case a change signal was missed. */
const POLL_MS = 5_000;
/** An event given to Pi that is not in the conversation by now, while it is idle with nothing queued, was dropped. */
const DELIVERY_GRACE_MS = 30_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A computer as the agent named it: by name, case aside, or by ID. */
function findComputer(computers: readonly KnownComputer[], name: string): KnownComputer | undefined {
	const wanted = name.trim().toLowerCase();
	return computers.find(computer => computer.id.toLowerCase() === wanted) ?? computers.find(computer => computer.name.toLowerCase() === wanted);
}

/**
 * pi-watch in a Pi process where Desk runs the computer's watches: the agent's watches are rows in Desk's store, which
 * Desk runs (pi-desk/src/host/watches.ts), here or on another computer; their events wait there until this process has
 * put them in the conversation. The conversation can close; Desk reopens it for their news.
 */
export class DeskClient implements WatchBackend {
	readonly sessionId: string;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly store: WatchStore;
	private readonly folder: string;
	private readonly running: () => boolean;
	private closed = false;
	/** The agent asked for this conversation to close when its turn ends (watch's close). */
	private closing = false;
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private retry?: NodeJS.Timeout;
	/** Events given to Pi and not yet seen in the conversation, with when. */
	private readonly inFlight = new Map<string, number>();
	/** Session entries already read for delivered events. */
	private scanned = 0;
	/** When this process last told Desk it is running. */
	private present = 0;
	private signature = "";

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, running: () => boolean, store: WatchStore) {
		this.pi = pi;
		this.ctx = ctx;
		this.running = running;
		this.store = store;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.folder = join(getAgentDir(), "watch", this.sessionId);
	}

	get bashFolder(): string { return join(this.folder, "bash"); }

	restore(): void {
		this.checkIn();
		this.handOver();
		this.untold();
		// Events given to the conversation's last process: delivered if they are in it, otherwise they go again.
		const delivered = this.deliveredIds(0);
		const sent = this.store.events(this.sessionId, "delivering");
		this.store.setEvents(sent.filter(event => delivered.has(event.id)).map(event => event.id), "delivered");
		this.store.setEvents(sent.filter(event => !delivered.has(event.id)).map(event => event.id), "pending", "delivering");
		try {
			this.watcher = watchFolder(this.store.directory, (_event, name) => { if (String(name) === WATCH_SIGNAL) this.guard(() => this.refresh()); });
			this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
			this.watcher.unref();
		} catch { /* the timer still checks */ }
		this.timer = setInterval(() => this.guard(() => this.refresh()), POLL_MS);
		this.timer.unref();
		this.refresh();
	}

	/**
	 * Watches this conversation ran itself, before Desk ran them, go to Desk: under the same names, with their runners and
	 * files, from where they had got. Their entries end, so the conversation doesn't run them again.
	 */
	private handOver(): void {
		const specs = new Map<string, WatchSpec>(), seen = new Map<string, number>();
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord;
			if (record.op === "start") specs.set(record.watch.id, { ...record.watch });
			else if (record.op === "end") { specs.delete(record.id); seen.delete(record.id); }
			else if (record.op === "runner") { const spec = specs.get(record.id); if (spec) spec.pid = record.pid; }
			else if (record.op === "seen" && typeof record.offset === "number") seen.set(record.id, record.offset);
		}
		let moved = false;
		for (const spec of specs.values()) {
			if (spec.computer !== hostname()) {
				const reason = "the conversation moved to another computer, so the watch stopped";
				this.pi.appendEntry(WATCH_ENTRY, { op: "end", id: spec.id, reason } satisfies WatchRecord);
				this.store.addEvent({ id: randomUUID(), watch: "", agent: this.sessionId, home: "", name: spec.id, created: Date.now(), state: "pending",
					text: spec.mode === "time" ? `Watch ${spec.id}: ${reason}.` : message(spec, `ended: ${reason}.`), event: watchEvent(spec, spec.mode === "time" ? reason : `ended: ${reason}`) });
				continue;
			}
			const id = this.store.named(this.sessionId, spec.id)?.id ?? randomUUID();
			this.store.insert({ id, agent: this.sessionId, home: "", runs: "", name: spec.id, spec: { ...spec, key: id }, state: "new", created: spec.created,
				progress: { ...(seen.has(spec.id) ? { offset: seen.get(spec.id) } : {}) } });
			this.pi.appendEntry(WATCH_ENTRY, { op: "desk", id: spec.id, watch: id, computer: hostname() } satisfies WatchRecord);
			this.pi.appendEntry(WATCH_ENTRY, { op: "end", id: spec.id, reason: "Desk runs it now" } satisfies WatchRecord);
			moved = true;
		}
		if (moved) this.store.signal();
	}

	/**
	 * Watches Desk ended without telling the agent, because its conversation moved or was removed or closed, and those
	 * kept by the Desk of a computer it moved from: the agent hears of each once, when the conversation next runs here.
	 */
	private untold(): void {
		const desk = new Map<string, { name: string; computer?: string }>(), told = new Set<string>();
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord;
			if (record.op === "desk") desk.set(record.watch, { name: record.id, computer: record.computer });
			else if (record.op === "gone") told.add(record.watch);
		}
		let any = false;
		for (const [watch, { name, computer }] of desk) {
			if (told.has(watch)) continue;
			const row = this.store.get(watch);
			// A row this Desk no longer has ended long ago, unless it was another computer's.
			const reason = row ? row.state === "ended" && row.reason && UNTOLD.has(row.reason) ? row.reason : undefined
				: computer && computer !== hostname() ? `the conversation moved here from ${computer}` : undefined;
			if (!reason) continue;
			this.pi.appendEntry(WATCH_ENTRY, { op: "gone", id: name, watch } satisfies WatchRecord);
			this.store.addEvent({ id: randomUUID(), watch: "", agent: this.sessionId, home: "", name, created: Date.now(), state: "pending",
				text: `Watch ${name} ended: ${reason}. Start it again if you still need it.` });
			any = true;
		}
		if (any) this.store.signal();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.watcher?.close();
		if (this.timer) clearInterval(this.timer);
		if (this.retry) clearTimeout(this.retry);
		announceWatches(this.pi, this.sessionId, undefined);
		try { this.store.leaveAgent(this.sessionId); } catch { /* its check-ins lapse */ }
		this.store.close();
	}

	/** Tells Desk this process delivers the agent's events, so it doesn't reopen the conversation for them. */
	private checkIn(): void {
		if (Date.now() - this.present < POLL_MS - 1_000) return;
		this.present = Date.now();
		this.store.touchAgent(this.sessionId);
	}

	private guard(work: () => unknown): void {
		if (this.closed) return;
		try {
			const result = work();
			if (result instanceof Promise) result.catch(error => this.failed(error));
		} catch (error) { this.failed(error); }
	}

	private failed(error: unknown): void {
		if (this.closed) return;
		if (/\bstale\b/i.test(error instanceof Error ? error.message : String(error))) this.close();
		else console.error(`pi-watch: ${error instanceof Error ? error.message : String(error)}`);
	}

	private rows(): WatchRow[] { return this.closed ? [] : this.store.agentWatches(this.sessionId); }

	data(): WatchSpec[] { return this.rows().map(row => ({ ...row.spec, id: row.name })); }

	/** Programs run in Desk, with the tools of their folder, not with this conversation's calls. */
	useContext(_ctx: ExtensionToolContext): void {}

	keepOpen(): void {
		if (!this.closing) return;
		this.closing = false;
		this.publish(true);
	}

	shell(): Shell { return shellFor(this.ctx.cwd, getAgentDir(), this.ctx.isProjectTrusted()); }

	launch(spec: WatchSpec, folder: string, env?: NodeJS.ProcessEnv): ChildProcess { return launchRunner(spec, folder, this.shell(), env); }

	stopRun(spec: WatchSpec): void { if (spec.pid && alive(spec.pid)) stopTree(spec.pid); }

	/** A bash command still running after its call's wait: Desk follows its runner from now on. */
	adopt(spec: WatchSpec): WatchSpec {
		const id = randomUUID();
		spec.id = this.nextName();
		spec.key = id;
		this.store.insert({ id, agent: this.sessionId, home: "", runs: "", name: spec.id, spec, state: "new", created: Date.now(), progress: { offset: 0 } });
		this.pi.appendEntry(WATCH_ENTRY, { op: "desk", id: spec.id, watch: id, computer: hostname() } satisfies WatchRecord);
		this.store.signal();
		this.publish(true);
		return spec;
	}

	async call(input: Params, ctx: ExtensionContext, label?: string): Promise<string> {
		const { close: asked, ...params } = input;
		if (asked) { this.closing = true; this.publish(true); }
		const closing = !asked ? "" : this.rows().length || params.command !== undefined || params.until !== undefined || params.program !== undefined
			? " This conversation closes when this turn ends; Desk reopens it when a watch has news."
			: " This conversation closes when this turn ends. It has no watches, so it stays closed until the user opens it.";
		if (asked && Object.values(params).every(value => value === undefined)) return `${closing.trim()} ${this.list()}`;
		return `${await this.start(params, ctx, label)}${closing}`;
	}

	private async start(params: Omit<Params, "close">, ctx: ExtensionContext, label?: string): Promise<string> {
		const given = Object.entries(params).filter(([, value]) => value !== undefined).map(([key]) => key);
		if (params.stop !== undefined) {
			if (given.length > 1) throw new Error("stop takes no other parameters.");
			return this.stop(params.stop.trim(), "you stopped it");
		}
		const { stop: _stop, ...asked } = params;
		if (asked.command === undefined && asked.until === undefined && asked.program === undefined) {
			if (given.length) throw new Error("Give command, program or until.");
			return this.list();
		}
		// Naming this computer is the same as naming none, though the folder can still be given.
		const here = asked.computer !== undefined && this.isHere(asked.computer);
		const target = asked.computer !== undefined && !here ? this.computer(asked.computer) : undefined;
		if (here) { asked.computer = undefined; }
		const folder = here && asked.cwd?.trim() ? resolve(ctx.cwd, asked.cwd.trim()) : undefined;
		if (here) asked.cwd = undefined;
		if (folder && !(() => { try { return statSync(folder).isDirectory(); } catch { return false; } })()) throw new Error(`There is no folder ${folder} on this computer.`);
		const rows = this.rows().filter(row => row.runs === (target?.id ?? ""));
		const times = rows.filter(row => row.spec.mode === "time").length, commands = rows.filter(row => row.spec.mode !== "time" && !row.spec.bash).length;
		const spec = plannedWatch(asked, ctx, label, { times, commands }, () => this.list());
		if (!target && spec.wakeWhen && !pickClassifier(await ctx.modelRegistry.getAvailableOfType("classifier")))
			throw new Error("wake_when needs a classifier model, such as System One's Jev (/login typesafe). Leave wake_when out to be woken for every event.");
		const id = randomUUID();
		spec.id = this.nextName();
		spec.key = id;
		if (folder) spec.cwd = folder;
		if (target) return this.startThere(spec, target, asked.cwd?.trim() ?? "", ctx);
		this.store.insert({ id, agent: this.sessionId, home: "", runs: "", name: spec.id, spec, state: "new", created: spec.created, progress: {} });
		this.pi.appendEntry(WATCH_ENTRY, { op: "desk", id: spec.id, watch: id, computer: hostname() } satisfies WatchRecord);
		this.store.signal();
		const row = await this.settled(id, START_WAIT_MS, ["new"]);
		this.publish(true);
		if (row?.state === "ended") throw new Error(`The watch could not start: ${row.reason ?? "Desk ended it"}.`);
		if (!row || row.state === "new") return `${startedText(spec)} Desk hasn't started it yet; it does once it is running.`;
		return startedText({ ...row.spec, id: row.name });
	}

	/** Whether an agent's computer name is this computer: its host name or its ID in the workspace. */
	private isHere(name: string): boolean {
		const wanted = name.trim().toLowerCase(), self = this.store.self();
		return wanted === hostname().toLowerCase() && !findComputer(this.store.computers(), name) || !!self && wanted === self.toLowerCase();
	}

	/** The computer an agent named, if Desk here can ask it to run watches. */
	private computer(name: string): KnownComputer {
		const computers = this.store.computers();
		const found = findComputer(computers, name);
		if (!found) throw new Error(`No computer called ${name} is in this workspace${computers.length ? `; the others are ${computers.map(computer => computer.name).join(", ")}` : ""}.`);
		if (!found.online) throw new Error(`${found.name} is offline (not connected to this computer's Desk now). agent_list lists the computers and their state.`);
		if (!found.watches) throw new Error(`${found.name} runs an older Desk that can't run watches for other computers. Update Desk there first.`);
		return found;
	}

	/** Asks Jordan, then asks the other computer to run the watch; its events come back here. */
	private async startThere(spec: WatchSpec, target: KnownComputer, cwd: string, ctx: ExtensionContext): Promise<string> {
		if (!ctx.hasUI) throw new Error(`A watch on ${target.name} needs Jordan's approval, which this conversation can't ask for.`);
		spec.cwd = cwd;
		spec.computer = target.name;
		const what = spec.program !== undefined ? `this program` : `this command`;
		const body = (spec.program ?? spec.command ?? "").trim();
		const schedule = [spec.every ? `every ${interval(spec.every)}` : "once, until it ends",
			spec.keep ? "until stopped" : spec.mode === "change" ? "until a result wakes the agent" : "",
			spec.wakeWhen ? `waking the agent when ${spec.wakeWhen}` : "waking the agent with each result",
			spec.expires ? `ending ${when(spec.expires)}` : ""].filter(Boolean).join(", ");
		const approved = await ctx.ui.confirm(`Run a watch on ${target.name}?`,
			`${this.pi.getSessionName() || "This conversation"} asks to run ${what} on ${target.name}, in ${cwd || "its home folder"}, ${schedule}:\n\n${body.length > 3000 ? `${body.slice(0, 3000)}…` : body}`);
		if (!approved) throw new Error(`Jordan declined the watch on ${target.name}; nothing was started.`);
		const id = spec.key!;
		this.store.insert({ id, agent: this.sessionId, home: "", runs: target.id, name: spec.id, spec, state: "new", created: spec.created, progress: {} });
		this.pi.appendEntry(WATCH_ENTRY, { op: "desk", id: spec.id, watch: id, computer: hostname() } satisfies WatchRecord);
		this.store.signal();
		const row = await this.settled(id, REMOTE_WAIT_MS, ["new"]);
		this.publish(true);
		if (row?.state === "ended") throw new Error(`${target.name} didn't start the watch: ${row.reason ?? "it refused"}.`);
		if (!row || row.state === "new") return `Asked ${target.name} to run it as ${spec.id}; it hasn't confirmed yet. You're told if it can't start it. End your turn now unless you have other work.`;
		return startedText({ ...row.spec, id: row.name }, target.name);
	}

	/** Asks Desk to stop a watch, here or on the computer running it, and waits a little for it to have stopped. */
	private async stop(name: string, reason: string): Promise<string> {
		const row = this.rows().find(item => item.name === name);
		// Usually it ended on its own before the stop arrived; the goal (it is not running) holds either way.
		if (!row) return `${name} is not running. ${this.list()}`;
		this.store.setState(row.id, "stopping", reason, ["new", "running"]);
		this.store.signal();
		const done = await this.settled(row.id, row.runs ? REMOTE_WAIT_MS / 2 : STOP_WAIT_MS, ["new", "running", "stopping"]);
		this.publish(true);
		const where = row.runs ? ` on ${row.spec.computer}` : "";
		if (done?.state !== "ended") return `Asked ${row.runs ? row.spec.computer : "Desk"} to stop ${name}; it hasn't confirmed yet. ${this.list()}`;
		return `Stopped ${name}${where}${row.spec.pid || row.spec.mode === "change" || row.spec.mode === "output" ? " and its command" : ""}. ${this.list()}`;
	}

	/** The watch once it has left `states`, or as it stands after `ms`. */
	private async settled(id: string, ms: number, states: WatchRow["state"][]): Promise<WatchRow | undefined> {
		const until = Date.now() + ms;
		for (;;) {
			const row = this.closed ? undefined : this.store.get(id);
			if (!row || !states.includes(row.state) || Date.now() >= until) return row;
			await sleep(200);
		}
	}

	private list(): string {
		const rows = this.rows();
		if (!rows.length) return "No active watches.";
		return `Active watches:\n${rows.map(row => {
			const spec = row.spec, readings = row.progress.readings ?? [];
			return `- ${row.name}: ${briefWatch({ ...spec, id: row.name })}${row.runs ? ` on ${spec.computer}` : ""}${spec.mode !== "time" && spec.expires ? `; ends ${when(spec.expires)}` : ""}${spec.keep ? "; keeps reporting" : ""}${spec.bash ? `; running ${elapsed(Date.now() - spec.bash.started)}${readings.length ? `; ${progressLine(readings)}` : ""}` : ""}${row.state === "new" ? "; starting" : row.state === "stopping" ? "; stopping" : ""}`;
		}).join("\n")}`;
	}

	/** A name none of this agent's watches has had: in Desk's store, in the conversation, or in its old watch folder. */
	private nextName(): string {
		let highest = 0;
		const count = (name: string) => { highest = Math.max(highest, Number(/^w(\d+)$/.exec(name)?.[1]) || 0); };
		for (const name of this.store.names(this.sessionId)) count(name);
		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
			const record = entry.data as WatchRecord | undefined;
			if (record?.op === "start") count(record.watch.id);
			else if (record?.op === "desk") count(record.id);
		}
		for (const name of existsSync(this.folder) ? readdirSync(this.folder) : []) count(/^(w\d+)\./.exec(name)?.[1] ?? "");
		return `w${highest + 1}`;
	}

	/** Event ids in the conversation's entries from `from` on. */
	private deliveredIds(from: number): Set<string> {
		const ids = new Set<string>(), entries = this.ctx.sessionManager.getEntries();
		for (let index = from; index < entries.length; index++) {
			const entry = entries[index] as { type?: string; customType?: string; details?: { deliveries?: unknown } };
			if (entry.type === "custom_message" && entry.customType === WATCH_MESSAGE && Array.isArray(entry.details?.deliveries))
				for (const id of entry.details.deliveries) if (typeof id === "string") ids.add(id);
		}
		this.scanned = entries.length;
		return ids;
	}

	private refresh(): void {
		if (this.closed) return;
		this.checkIn();
		this.confirm();
		this.pump();
		this.publish();
	}

	/** Events given to Pi that are now in the conversation are delivered; ones Pi dropped go again. */
	private confirm(): void {
		if (!this.inFlight.size) return;
		const ids = this.deliveredIds(Math.min(this.scanned, this.ctx.sessionManager.getEntries().length));
		const found = [...this.inFlight.keys()].filter(id => ids.has(id));
		if (found.length) { this.store.setEvents(found, "delivered"); for (const id of found) this.inFlight.delete(id); }
		if (this.running() || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) return;
		const lost = [...this.inFlight].filter(([, at]) => Date.now() - at > DELIVERY_GRACE_MS).map(([id]) => id);
		if (lost.length) { this.store.setEvents(lost, "pending", "delivering"); for (const id of lost) this.inFlight.delete(id); }
	}

	/**
	 * Gives waiting events to the agent as one message. While it is working they join its run at the next step, so it
	 * knows before it answers; otherwise, once it is idle with no input waiting, they start a turn.
	 */
	private pump(): void {
		if (this.closed || this.retry) return;
		const pending = this.store.events(this.sessionId, "pending");
		if (!pending.length) return;
		// An event with no text only told Desk the watch ended.
		const quiet = pending.filter(event => !event.text);
		if (quiet.length) this.store.setEvents(quiet.map(event => event.id), "delivered", "pending");
		const items = pending.filter(event => event.text);
		if (!items.length) return;
		const suspended = getPresentation(this.pi)?.suspended, running = !suspended && this.running();
		if (!running && (suspended || !this.ctx.isIdle() || this.ctx.hasPendingMessages())) {
			this.retry = setTimeout(() => { this.retry = undefined; this.guard(() => this.pump()); }, RETRY_MS);
			return;
		}
		const ids = items.map(event => event.id);
		this.store.setEvents(ids, "delivering", "pending");
		for (const id of ids) this.inFlight.set(id, Date.now());
		this.pi.sendMessage({ customType: WATCH_MESSAGE, content: items.map(event => event.text).join("\n\n"), display: true,
			details: { watches: [...new Set(items.map(event => event.name))], events: items.flatMap(event => event.event ? [event.event] : []), deliveries: ids } },
			{ deliverAs: running ? "steer" : "followUp", triggerTurn: true });
	}

	private publish(force = false): void {
		if (this.closed) return;
		const rows = this.rows();
		const signature = JSON.stringify([rows.map(row => [row.id, row.state, row.updated, row.progress.readings?.at(-1)]), this.closing]);
		if (!force && signature === this.signature) return;
		this.signature = signature;
		const specs = rows.map(row => ({ ...row.spec, id: row.name }));
		announceWatches(this.pi, this.sessionId, rows.map(row => `${row.name}: ${describeWatch({ ...row.spec, id: row.name })}${row.runs ? ` (on ${row.spec.computer})` : ""}`));
		if (this.ctx.hasUI) this.ctx.ui.setStatus("pi-watch", rows.length ? `watching ${rows.length}` : undefined);
		const presentation = getPresentation(this.pi);
		if (!presentation || presentation.suspended) return;
		const warning = (bash: NonNullable<WatchSpec["bash"]>) => bash.started + Math.ceil((Date.now() + 1 - bash.started) / (bash.warn! * 1000)) * bash.warn! * 1000;
		const times = specs.flatMap(spec => spec.mode === "time" ? [spec.at!] : spec.bash?.warn ? [warning(spec.bash)] : []);
		const reading = (row: WatchRow) => row.progress.readings?.at(-1)?.value;
		// Desk runs these watches and reopens the conversation for their news, so the view names no files to wake it.
		presentation.publish("pi-watch", rows.length || this.closing ? {
			kind: "details", title: "Watches", ...(times.length ? { wakes: Math.min(...times) } : {}),
			...(specs.some(spec => spec.mode !== "time") ? { watching: true } : {}),
			...(specs.some(spec => spec.mode === "change") ? { watchEvery: Math.min(...specs.flatMap(spec => spec.mode === "change" ? [spec.every!] : [])) } : {}),
			...(this.closing ? { close: true } : {}),
			data: { items: rows.map((row, index) => {
				const spec = specs[index]!;
				return { id: row.name, title: spec.label ?? describeWatch(spec), ...(spec.mode === "time" ? { at: spec.at } : {}),
					subtitle: [row.name, ...(row.runs ? [`on ${spec.computer}`] : []), ...(spec.label ? [describeWatch(spec)] : []),
						...(spec.mode !== "time" && spec.expires ? [`ends ${when(spec.expires)}`] : []), ...(spec.keep ? ["keeps reporting"] : []),
						...(spec.bash ? [`started ${clockTime(spec.bash.started)}`] : []), ...(reading(row) ? [`progress ${reading(row)}`] : []),
						...(row.state === "new" ? ["starting"] : row.state === "stopping" ? ["stopping"] : [])].join(" · "),
					actions: [{ id: `stop:${row.name}`, label: "Stop", destructive: true }] };
			}) },
			...(rows.length ? { badges: [{ label: "Watching", value: String(rows.length), icon: "eye" as const, compact: true,
				description: rows.map((row, index) => `${row.name}: ${specs[index]!.label ?? describeWatch(specs[index]!)}`).join("\n") }] } : {}),
		} : undefined, Object.fromEntries(rows.map(row => [`stop:${row.name}`, () => this.stop(row.name, "Jordan stopped it")])));
	}
}

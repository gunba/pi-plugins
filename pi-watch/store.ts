import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WatchEvent, WatchSpec } from "./common.ts";
import type { Progress } from "./engine.ts";

/**
 * Desk's record of the computer's watches, in the agent directory's party folder: Desk runs them, and the Pi processes
 * of the agents they wake ask for them, list them and receive their events here. Either side writes SIGNAL after a
 * change; both also check every few seconds.
 */
export const WATCH_DB = "watches.sqlite", WATCH_SIGNAL = "watches-changed";
/** Desk counts as running while it has checked in within this long (it does every 20 seconds). */
export const HOST_LEASE_MS = 45_000;
/** A Pi process delivering an agent's events counts as running while it has checked in within this long (desk.ts does every 5 seconds). */
export const AGENT_LEASE_MS = 15_000;

/**
 * new: asked for, and not yet started by Desk here, or not yet confirmed by the computer running it. running.
 * stopping: asked to stop. ended: reason says why.
 */
export type WatchState = "new" | "running" | "stopping" | "ended";
export interface WatchRow {
	/** Desk's id for it: a UUID, the same on the agent's computer and the one running it. */
	id: string;
	/** The native session id of the agent it wakes. */
	agent: string;
	/** The agent's computer: "" for this one, otherwise its id in the workspace. */
	home: string;
	/** The computer running it: "" for this one, otherwise its id; a row for a watch running elsewhere is its mirror. */
	runs: string;
	name: string;
	spec: WatchSpec;
	state: WatchState;
	reason?: string;
	created: number;
	updated: number;
	/** How far it has got, and a background command's progress readings, as the computer running it keeps them. */
	progress: Progress & { readings?: { at: number; value: string }[]; next?: number };
}
export interface EventRow {
	id: string;
	watch: string;
	agent: string;
	/** As WatchRow.home: where the agent is, so where the event goes. */
	home: string;
	/** The watch's name. */
	name: string;
	/** What the agent reads; empty when the event only says the watch ended (the agent was told otherwise, or not at all). */
	text: string;
	event?: WatchEvent;
	/** The watch ended with this event, for this reason. */
	ended?: string;
	created: number;
	/**
	 * For an agent here: pending; delivering once given to its Pi process; delivered once in its conversation. For an
	 * agent elsewhere: pending until its computer has it.
	 */
	state: "pending" | "delivering" | "delivered";
}
export interface KnownComputer { id: string; name: string; online: boolean; watches: boolean; platform?: string }

type Row = Record<string, unknown>;
const json = <T>(value: unknown, fallback: T): T => { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const watchRow = (row: Row): WatchRow => ({ id: String(row.id), agent: String(row.agent), home: String(row.home), runs: String(row.runs), name: String(row.name),
	spec: json<WatchSpec>(row.spec, { id: String(row.name), mode: "time", cwd: "", created: 0, computer: "" }), state: String(row.state) as WatchState,
	...(row.reason ? { reason: String(row.reason) } : {}), created: Number(row.created), updated: Number(row.updated), progress: json(row.progress, {}) });
const eventRow = (row: Row): EventRow => ({ id: String(row.id), watch: String(row.watch), agent: String(row.agent), home: String(row.home), name: String(row.name),
	text: String(row.text), ...(row.event ? { event: json<WatchEvent | undefined>(row.event, undefined) } : {}), ...(row.ended ? { ended: String(row.ended) } : {}),
	created: Number(row.created), state: String(row.state) as EventRow["state"] });

export class WatchStore {
	readonly directory: string;
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(directory, WATCH_DB));
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, agent TEXT NOT NULL, home TEXT NOT NULL, runs TEXT NOT NULL, name TEXT NOT NULL,
				spec TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, progress TEXT NOT NULL DEFAULT '{}');
			CREATE UNIQUE INDEX IF NOT EXISTS watch_names ON watches(agent, name);
			CREATE INDEX IF NOT EXISTS watch_states ON watches(state, runs);
			CREATE TABLE IF NOT EXISTS watch_events (id TEXT PRIMARY KEY, watch TEXT NOT NULL, agent TEXT NOT NULL, home TEXT NOT NULL, name TEXT NOT NULL,
				text TEXT NOT NULL, event TEXT, ended TEXT, created INTEGER NOT NULL, state TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS watch_event_agents ON watch_events(home, agent, state);
			CREATE TABLE IF NOT EXISTS watch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS watch_agents (agent TEXT PRIMARY KEY, seen INTEGER NOT NULL);`);
	}

	/** Tells the other side something changed. */
	signal(): void {
		try { writeFileSync(join(this.directory, WATCH_SIGNAL), randomUUID(), { mode: 0o600 }); } catch { /* both sides also check on a timer */ }
	}

	private meta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM watch_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
	}
	private setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO watch_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
	}
	/** Desk checks in, so Pi processes know it is running; stopped, it says so. */
	touchHost(): void { this.setMeta("host_seen", String(Date.now())); }
	stopHost(): void { this.setMeta("host_seen", "0"); }
	hostOnline(): boolean { return Number(this.meta("host_seen")) > Date.now() - HOST_LEASE_MS; }
	/** The other computers in the workspace, as Desk last saw them, for agents naming one. */
	computers(): KnownComputer[] { return json<KnownComputer[]>(this.meta("computers"), []); }
	setComputers(computers: KnownComputer[]): void {
		const value = JSON.stringify(computers);
		if (value !== this.meta("computers")) this.setMeta("computers", value);
	}
	/** This computer's ID in the workspace, as Desk knows it. */
	self(): string | undefined { return this.meta("self") || undefined; }
	setSelf(id: string): void { if (id !== this.meta("self")) this.setMeta("self", id); }
	/** A Pi process that delivers the agent's events is running (desk.ts); without one, Desk reopens the conversation for them. */
	touchAgent(agent: string): void {
		this.db.prepare("INSERT INTO watch_agents VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET seen=excluded.seen").run(agent, Date.now());
	}
	leaveAgent(agent: string): void { this.db.prepare("DELETE FROM watch_agents WHERE agent=?").run(agent); }
	agentLive(agent: string): boolean {
		const row = this.db.prepare("SELECT seen FROM watch_agents WHERE agent=?").get(agent) as { seen: number } | undefined;
		return !!row && row.seen > Date.now() - AGENT_LEASE_MS;
	}

	/** Adds a watch; false when the agent already has one by that name, or the id is taken. */
	insert(row: Omit<WatchRow, "updated">): boolean {
		const result = this.db.prepare("INSERT OR IGNORE INTO watches (id,agent,home,runs,name,spec,state,reason,created,updated,progress) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
			.run(row.id, row.agent, row.home, row.runs, row.name, JSON.stringify(row.spec), row.state, row.reason ?? null, row.created, Date.now(), JSON.stringify(row.progress ?? {}));
		return result.changes > 0;
	}
	get(id: string): WatchRow | undefined {
		const row = this.db.prepare("SELECT * FROM watches WHERE id=?").get(id) as Row | undefined;
		return row ? watchRow(row) : undefined;
	}
	named(agent: string, name: string): WatchRow | undefined {
		const row = this.db.prepare("SELECT * FROM watches WHERE agent=? AND name=?").get(agent, name) as Row | undefined;
		return row ? watchRow(row) : undefined;
	}
	/** An agent's watches that haven't ended, here and elsewhere, oldest first. */
	agentWatches(agent: string): WatchRow[] {
		return (this.db.prepare("SELECT * FROM watches WHERE agent=? AND home='' AND state<>'ended' ORDER BY created,id").all(agent) as Row[]).map(watchRow);
	}
	/** Every name an agent's watches have had here. */
	names(agent: string): string[] {
		return (this.db.prepare("SELECT name FROM watches WHERE agent=?").all(agent) as { name: string }[]).map(row => row.name);
	}
	/** Watches this computer runs that haven't ended. */
	local(): WatchRow[] {
		return (this.db.prepare("SELECT * FROM watches WHERE runs='' AND state<>'ended' ORDER BY created,id").all() as Row[]).map(watchRow);
	}
	/** Watches agents here have on other computers that haven't ended. */
	mirrors(computer?: string): WatchRow[] {
		return (computer === undefined ? this.db.prepare("SELECT * FROM watches WHERE runs<>'' AND state<>'ended' ORDER BY created,id").all()
			: this.db.prepare("SELECT * FROM watches WHERE runs=? AND state<>'ended' ORDER BY created,id").all(computer) as Row[]).map(row => watchRow(row as Row));
	}
	/** Moves a watch on; `from`, when given, is the state it must be in. True when it changed. */
	setState(id: string, state: WatchState, reason?: string, from?: WatchState[]): boolean {
		const result = from ? this.db.prepare(`UPDATE watches SET state=?,reason=?,updated=? WHERE id=? AND state IN (${from.map(() => "?").join(",")})`).run(state, reason ?? null, Date.now(), id, ...from)
			: this.db.prepare("UPDATE watches SET state=?,reason=?,updated=? WHERE id=?").run(state, reason ?? null, Date.now(), id);
		return result.changes > 0;
	}
	setSpec(id: string, spec: WatchSpec): void { this.db.prepare("UPDATE watches SET spec=?,updated=? WHERE id=?").run(JSON.stringify(spec), Date.now(), id); }
	setProgress(id: string, progress: WatchRow["progress"]): void { this.db.prepare("UPDATE watches SET progress=? WHERE id=?").run(JSON.stringify(progress), id); }

	/** Records an event once: false when it is already here. */
	addEvent(event: EventRow): boolean {
		return this.db.prepare("INSERT OR IGNORE INTO watch_events (id,watch,agent,home,name,text,event,ended,created,state) VALUES (?,?,?,?,?,?,?,?,?,?)")
			.run(event.id, event.watch, event.agent, event.home, event.name, event.text, event.event ? JSON.stringify(event.event) : null, event.ended ?? null, event.created, event.state).changes > 0;
	}
	/** Events for an agent here in `state`, oldest first. */
	events(agent: string, state: EventRow["state"]): EventRow[] {
		return (this.db.prepare("SELECT * FROM watch_events WHERE home='' AND agent=? AND state=? ORDER BY created,rowid").all(agent, state) as Row[]).map(eventRow);
	}
	/** Agents here with events not yet given to them. */
	waitingAgents(): string[] {
		return (this.db.prepare("SELECT DISTINCT agent FROM watch_events WHERE home='' AND state='pending'").all() as { agent: string }[]).map(row => row.agent);
	}
	/** Events for agents on another computer, oldest first. */
	outgoing(home: string, limit: number): EventRow[] {
		return (this.db.prepare("SELECT * FROM watch_events WHERE home=? AND state='pending' ORDER BY created,rowid LIMIT ?").all(home, limit) as Row[]).map(eventRow);
	}
	/** Computers with events waiting for them. */
	waitingHomes(): string[] {
		return (this.db.prepare("SELECT DISTINCT home FROM watch_events WHERE home<>'' AND state='pending'").all() as { home: string }[]).map(row => row.home);
	}
	setEvents(ids: readonly string[], state: EventRow["state"], from?: EventRow["state"]): void {
		const update = from ? this.db.prepare("UPDATE watch_events SET state=? WHERE id=? AND state=?") : this.db.prepare("UPDATE watch_events SET state=? WHERE id=?");
		for (const id of ids) from ? update.run(state, id, from) : update.run(state, id);
	}
	deleteEvents(ids: readonly string[]): void {
		const remove = this.db.prepare("DELETE FROM watch_events WHERE id=?");
		for (const id of ids) remove.run(id);
	}
	/**
	 * Forgets delivered events after a day, and any after a week, as for a computer that left the workspace; ended
	 * watches after 30 days (their names are kept in the conversation).
	 */
	prune(): void {
		this.db.prepare("DELETE FROM watch_events WHERE state='delivered' AND created<? OR created<?").run(Date.now() - 86_400_000, Date.now() - 7 * 86_400_000);
		this.db.prepare("DELETE FROM watches WHERE state='ended' AND updated<?").run(Date.now() - 30 * 86_400_000);
		this.db.prepare("DELETE FROM watch_agents WHERE seen<?").run(Date.now() - 86_400_000);
	}
	close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

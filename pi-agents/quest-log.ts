import { randomUUID } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { record } from "./network.ts";
import type { Quest, QuestActor, QuestCommand, QuestEvent, QuestView } from "./quest-model.ts";
import { LEASE_MS } from "./store.ts";
import type { QuestStore } from "./quests.ts";

/**
 * Announced by the computer that keeps Jordan's quest log for every computer of the account: the one that keeps
 * conversation copies (the workspace server), which stays up when the others sleep. Without one, each computer keeps
 * its own log.
 */
export const QUEST_LOG = "quest-log-v1";
/** Announced by every computer that takes notices about its agents' quests from the computer that keeps the log. */
export const QUEST_NOTICES = "quest-notices-v1";
/** How long an agent waits for the computer that keeps the log to answer. */
const CALL_MS = 30_000;
/** Written when a reply arrives, for the processes waiting on one. */
const REPLIES = "quest-replies";

export type QuestCall = { id: string; created: number } & (
	| { method: "view" | "ready" }
	| { method: "get"; quest: string }
	/** Changes by others since this reader last looked; the computer that asks keeps its own mark. */
	| { method: "changes"; reader: string }
	| { method: "apply"; by: QuestActor; command: QuestCommand; notify?: boolean });
export type QuestReply = { id: string; value?: unknown; error?: string };
type CallInput = QuestCall extends infer C ? C extends QuestCall ? Omit<C, "id" | "created"> : never : never;

/** Jordan's quest log as an agent, the Dot connector or Desk uses it, wherever it is kept. */
export interface QuestLog {
	view(): Promise<QuestView>;
	get(id: string): Promise<Quest | undefined>;
	/** Finished quests waiting to be turned in, oldest first. */
	ready(): Promise<Quest[]>;
	/** Changes made by others than this reader's kind since its last look; moves the reader's mark. */
	changesSince(reader: "dot"): Promise<{ changed: boolean; events: QuestEvent[] }>;
	apply(by: QuestActor, command: QuestCommand, options?: { notify?: boolean }): Promise<Quest | undefined>;
}

/** The log this computer keeps. applied: told of each change, for Desk to refresh and tell the agent that added a quest. */
export class LocalQuestLog implements QuestLog {
	readonly store: QuestStore;
	private applied?: (quest: Quest | undefined, by: QuestActor) => void;
	constructor(store: QuestStore, applied?: (quest: Quest | undefined, by: QuestActor) => void) { this.store = store; this.applied = applied; }
	async view(): Promise<QuestView> { return this.store.view(); }
	async get(id: string): Promise<Quest | undefined> { return this.store.get(id); }
	async ready(): Promise<Quest[]> { return this.store.ready(); }
	async changesSince(reader: "dot"): Promise<{ changed: boolean; events: QuestEvent[] }> { return this.store.changesSince(reader, actor => actor.kind !== reader); }
	async apply(by: QuestActor, command: QuestCommand, options?: { notify?: boolean }): Promise<Quest | undefined> {
		const quest = this.store.apply(by, command, options);
		this.applied?.(quest, by);
		return quest;
	}
}

/**
 * Calls to the quest log on another computer. Agents and the Dot connector queue them in the agent database; this
 * computer's Desk sends them over the computer channel and writes back the replies.
 */
export class QuestCalls {
	private db: DatabaseSync;
	private directory: string;
	constructor(directory: string) {
		this.directory = directory;
		this.db = new DatabaseSync(join(directory, "party.sqlite"));
		this.db.exec(`PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS quest_calls (id TEXT PRIMARY KEY, call TEXT NOT NULL, status TEXT NOT NULL, reply TEXT, created INTEGER NOT NULL);`);
	}
	close(): void { this.db.close(); }
	/** The other computer that keeps the quest log, as this computer last heard; kept while it is offline. */
	server(): { id: string; name: string; online: boolean } | undefined {
		let row: { computer: string; name: string | null; connected: number; seen: number } | undefined;
		try {
			row = this.db.prepare("SELECT computer,name,connected,seen FROM network_computers WHERE operations LIKE ? ORDER BY computer LIMIT 1")
				.get(`%"${QUEST_LOG}"%`) as typeof row;
		} catch { return undefined; }
		return row && { id: row.computer, name: row.name ?? row.computer, online: !!row.connected && row.seen > Date.now() - LEASE_MS };
	}
	/** The log on the other computer that keeps it, or undefined when this computer keeps its own. */
	remote(): QuestLog | undefined {
		const server = this.server();
		if (!server) return undefined;
		const call = (input: CallInput) => this.call(input);
		return {
			view: () => call({ method: "view" }) as Promise<QuestView>,
			get: quest => call({ method: "get", quest }) as Promise<Quest | undefined>,
			ready: () => call({ method: "ready" }) as Promise<Quest[]>,
			changesSince: reader => call({ method: "changes", reader }) as Promise<{ changed: boolean; events: QuestEvent[] }>,
			apply: (by, command, options) => call({ method: "apply", by, command, ...(options?.notify !== undefined ? { notify: options.notify } : {}) }) as Promise<Quest | undefined>,
		};
	}
	private hostOnline(): boolean {
		try {
			const row = this.db.prepare("SELECT value FROM party_operation_meta WHERE key='host_seen'").get() as { value: string } | undefined;
			return Number(row?.value) > Date.now() - LEASE_MS;
		} catch { return false; }
	}
	private async call(input: CallInput): Promise<unknown> {
		const server = this.server()!;
		if (!this.hostOnline()) throw Error(`The quest log is kept on ${server.name}, and Desk is not running on this computer to reach it.`);
		if (!server.online) throw Error(`The quest log is kept on ${server.name}, which is offline. Try again when it is back.`);
		const call = { ...input, id: randomUUID(), created: Date.now() } as QuestCall;
		this.db.prepare("INSERT INTO quest_calls VALUES (?,?,'queued',NULL,?)").run(call.id, JSON.stringify(call), call.created);
		try { writeFileSync(join(this.directory, "changed"), randomUUID(), { mode: 0o600 }); } catch { /* Desk also sends queued calls every 10 s. */ }
		const reply = await this.wait(call.id, server.name);
		if (reply.error !== undefined) throw Error(reply.error);
		return reply.value;
	}
	private wait(id: string, name: string): Promise<QuestReply> {
		return new Promise((resolve, reject) => {
			let finished = false;
			const done = (error?: Error, reply?: QuestReply) => {
				if (finished) return; finished = true;
				clearInterval(timer); watcher.close();
				this.db.prepare("DELETE FROM quest_calls WHERE id=?").run(id);
				error ? reject(error) : resolve(reply!);
			};
			const check = () => {
				const row = this.db.prepare("SELECT reply,created FROM quest_calls WHERE id=?").get(id) as { reply: string | null; created: number } | undefined;
				if (row?.reply) done(undefined, JSON.parse(row.reply));
				else if (!row || row.created + CALL_MS <= Date.now()) done(Error(`${name}, which keeps the quest log, did not answer. A change may still have been made; read the log before repeating it.`));
			};
			const watcher = watch(this.directory, (_event, file) => { if (String(file) === REPLIES) check(); });
			watcher.on("error", () => {});
			const timer = setInterval(check, 500);
			check();
		});
	}
	/** Calls waiting to be sent, marked sent; expired ones are dropped (their callers have stopped waiting). */
	outgoing(): QuestCall[] {
		this.db.prepare("DELETE FROM quest_calls WHERE created<?").run(Date.now() - CALL_MS);
		const rows = this.db.prepare("SELECT id,call FROM quest_calls WHERE status='queued' ORDER BY created LIMIT 16").all() as { id: string; call: string }[];
		for (const row of rows) this.db.prepare("UPDATE quest_calls SET status='sent' WHERE id=?").run(row.id);
		return rows.map(row => JSON.parse(row.call));
	}
	settle(raw: unknown): void {
		const input = record(raw);
		if (typeof input.id !== "string") throw Error("Invalid quest reply.");
		const reply: QuestReply = { id: input.id, ...(input.error !== undefined ? { error: String(input.error).slice(0, 2000) } : { value: input.value }) };
		this.db.prepare("UPDATE quest_calls SET reply=?,status='done' WHERE id=?").run(JSON.stringify(reply), reply.id);
		try { writeFileSync(join(this.directory, REPLIES), randomUUID(), { mode: 0o600 }); } catch { /* Waiters also check every 500 ms. */ }
	}
}

/**
 * The quest log's agents are named across computers: on the computer that keeps it, an agent of another computer is
 * session@computer, and its own agents are bare sessions. Each computer is shown them as it names them.
 */
function forComputer<T>(value: T, computer: string, here: string): T {
	const actor = (by: QuestActor): QuestActor => by.kind !== "agent" || !by.id ? by
		: { ...by, id: by.id.endsWith(`@${computer}`) ? by.id.slice(0, -computer.length - 1) : by.id.includes("@") ? by.id : `${by.id}@${here}` };
	const quest = (item: Quest): Quest => ({ ...item, source: actor(item.source) });
	if (Array.isArray(value)) return value.map(item => forComputer(item, computer, here)) as T;
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	if ("source" in input && "title" in input) return quest(input as unknown as Quest) as T;
	if ("by" in input && "action" in input) return { ...input, by: actor(input.by as QuestActor) } as T;
	if ("quests" in input && "upcoming" in input) return { ...input, quests: (input.quests as Quest[]).map(quest), upcoming: (input.upcoming as Quest[]).map(quest) } as T;
	if ("events" in input) return { ...input, events: forComputer(input.events, computer, here) } as T;
	return value;
}

/** Answer another computer's call on the log this computer keeps. here: this computer's id. */
export async function serveQuestCall(log: LocalQuestLog, computer: string, here: string, raw: unknown): Promise<QuestReply> {
	const call = record(raw) as unknown as QuestCall;
	if (typeof call.id !== "string") throw Error("Invalid quest call.");
	try {
		const by = (actor: QuestActor): QuestActor => actor.kind === "agent" && actor.id ? { ...actor, id: `${actor.id}@${computer}` } : actor;
		const value = call.method === "view" ? await log.view()
			: call.method === "get" ? await log.get(String(call.quest))
			: call.method === "ready" ? await log.ready()
			: call.method === "changes" ? log.store.changesSince(`${call.reader}@${computer}`, actor => actor.kind !== call.reader)
			: call.method === "apply" ? await log.apply(by(record(call.by) as unknown as QuestActor), record(call.command) as unknown as QuestCommand,
				call.notify !== undefined ? { notify: call.notify } : {})
			: (() => { throw Error("Unknown quest call."); })();
		return { id: call.id, value: forComputer(value, computer, here) ?? null };
	} catch (error) { return { id: call.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }; }
}

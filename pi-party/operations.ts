import { randomUUID } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentId, operationResult, partyOperation, type OperationResult, type PartyOperation } from "./network.ts";
import { LEASE_MS, type PartyStore } from "./store.ts";

type OperationInput = { kind: "create"; computer?: string; cwd: string; task: string; label: string; model?: string; reasoning?: string }
	| { kind: "fork"; cwd: string; task: string; label: string; call: string };
interface Outgoing { id: string; computer: string; request: string; status: string; response: string | null }
interface Incoming { request: string; status: string; response: string | null }

/** Durable, user-approved agent creation over the computer channel, not general remote commands. */
export class PartyOperations {
	private db: DatabaseSync;
	private directory: string;
	private closed = false;
	private waits = new Set<() => void>();
	constructor(directory: string) {
		this.directory = directory;
		this.db = new DatabaseSync(join(directory, "party.sqlite"));
		this.db.exec(`PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS party_operations (id TEXT PRIMARY KEY, computer TEXT NOT NULL,
				request TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS party_incoming (computer TEXT NOT NULL, id TEXT NOT NULL,
				request TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created INTEGER NOT NULL, controller TEXT NOT NULL, PRIMARY KEY(computer,id));
			CREATE TABLE IF NOT EXISTS party_operation_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
			DROP TABLE IF EXISTS party_driver_hosts; DROP TABLE IF EXISTS party_driver_members; DROP TABLE IF EXISTS party_driver_requests;`);
	}
	private notify(name = "operations-changed"): void {
		try { writeFileSync(join(this.directory, name), randomUUID(), { mode: 0o600 }); }
		catch { /* The host pulse and waiter deadline also check durable state. */ }
	}
	setScope(scope: string): void {
		const old = this.db.prepare("SELECT value FROM party_operation_meta WHERE key='scope'").get() as { value: string } | undefined;
		if (old && old.value !== scope) {
			for (const row of this.db.prepare("SELECT id FROM party_operations WHERE computer<>'local' AND status IN ('queued','sent')").all()) {
				this.settle(undefined, { id: String(row.id), error: "Desk account changed before the outcome was confirmed." });
			}
			this.db.exec("DELETE FROM party_incoming WHERE computer<>'local'");
		}
		this.db.prepare("INSERT INTO party_operation_meta VALUES ('scope',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(scope);
	}
	startHost(): void {
		for (const row of this.db.prepare("SELECT computer,id FROM party_incoming WHERE status='running' AND controller='host'").all()) {
			const response = JSON.stringify({ id: row.id, error: "The host stopped after admission. Inspect the agent before repeating this operation." });
			this.db.prepare("UPDATE party_incoming SET status='done',response=? WHERE computer=? AND id=?").run(response, row.computer, row.id);
			if (row.computer === "local") this.settle("local", JSON.parse(response));
		}
		for (const row of this.db.prepare("SELECT id FROM party_operations WHERE status IN ('queued','sent')").all()) {
			this.settle(undefined, { id: String(row.id), error: "The host restarted before the outcome was confirmed. Inspect the agent; this operation was not replayed." });
		}
		this.touchHost();
	}
	touchHost(): void {
		this.db.prepare("INSERT INTO party_operation_meta VALUES ('host_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));
	}
	stopHost(): void { this.db.prepare("UPDATE party_operation_meta SET value='0' WHERE key='host_seen'").run(); }
	hostOnline(): boolean {
		const row = this.db.prepare("SELECT value FROM party_operation_meta WHERE key='host_seen'").get() as { value: string } | undefined;
		return Number(row?.value) > Date.now() - LEASE_MS;
	}
	queue(store: PartyStore, session: string, owner: string, input: OperationInput): PartyOperation {
		const self = store.member(session);
		if (!self || self.owner !== owner) throw Error("Agent registration is no longer owned by this session process.");
		const computer = input.kind === "create" ? input.computer ?? "local" : "local";
		const now = Date.now(), operation: PartyOperation = { id: randomUUID(), sender: session, sender_epoch: self.agent_epoch,
			kind: input.kind, created: now, expires: now + 300_000, cwd: input.cwd, task: input.task, label: input.label,
			...(input.kind === "fork" ? { call: input.call } : {}),
			...(input.kind === "create" && input.model ? { model: input.model } : {}),
			...(input.kind === "create" && input.reasoning ? { reasoning: input.reasoning } : {}) };
		if (computer === "local" ? !this.hostOnline() : !store.computerOnline(computer)) throw Error("The agent's Desk computer is not connected.");
		const pending = this.db.prepare("SELECT count(*) AS n FROM party_operations WHERE status IN ('queued','sent')").get() as { n: number };
		if (pending.n >= 64) throw Error("Too many agent operations are awaiting an outcome.");
		const request = partyOperation(operation);
		this.db.prepare("INSERT INTO party_operations VALUES (?,?,?,'queued',NULL,?)").run(request.id, computer, JSON.stringify(request), now);
		this.notify("changed"); return request;
	}
	outgoing(computer: string): PartyOperation[] {
		this.db.prepare("DELETE FROM party_operations WHERE status='done' AND created<?").run(Date.now() - 86_400_000);
		this.db.prepare("DELETE FROM party_incoming WHERE status='done' AND created<?").run(Date.now() - 86_400_000);
		const rows = this.db.prepare("SELECT * FROM party_operations WHERE computer=? AND status IN ('queued','sent') ORDER BY created,id LIMIT 8").all(computer) as unknown as Outgoing[];
		const requests: PartyOperation[] = [];
		for (const row of rows) {
			const operation = partyOperation(JSON.parse(row.request));
			if (operation.expires <= Date.now()) {
				this.settle(computer, { id: operation.id, error: row.status === "sent"
					? "The party operation timed out after dispatch. Inspect the agent before repeating it."
					: "The party operation expired before dispatch." });
				continue;
			}
			this.db.prepare("UPDATE party_operations SET status='sent' WHERE id=? AND status='queued'").run(row.id);
			requests.push(operation);
		}
		return requests;
	}
	async receive(computer: string, raw: unknown, handle: (request: PartyOperation) => Promise<OperationResult["result"]>, controller = "host"): Promise<OperationResult | undefined> {
		const operation = partyOperation(raw), request = JSON.stringify(operation);
		const previous = this.db.prepare("SELECT * FROM party_incoming WHERE computer=? AND id=?").get(computer, operation.id) as unknown as Incoming | undefined;
		if (previous) {
			if (previous.request !== request) throw Error("Party operation identity was reused.");
			return previous.response ? operationResult(JSON.parse(previous.response)) : undefined;
		}
		this.db.prepare("INSERT INTO party_incoming VALUES (?,?,?,'running',NULL,?,?)").run(computer, operation.id, request, Date.now(), controller);
		let response: OperationResult;
		try {
			if (operation.expires <= Date.now() || operation.created > Date.now() + 30_000) throw Error("The party operation expired before admission.");
			response = operationResult({ id: operation.id, result: await handle(operation) });
		} catch (error) { response = { id: operation.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }; }
		if (this.closed) return undefined;
		const finished = this.db.prepare("UPDATE party_incoming SET status='done',response=? WHERE computer=? AND id=? AND status='running'")
			.run(JSON.stringify(response), computer, operation.id);
		if (!finished.changes) {
			const settled = this.db.prepare("SELECT response FROM party_incoming WHERE computer=? AND id=?").get(computer, operation.id) as { response: string | null } | undefined;
			return settled?.response ? operationResult(JSON.parse(settled.response)) : undefined;
		}
		return response;
	}
	settle(computer: string | undefined, raw: unknown): void {
		if (this.closed) return;
		const response = operationResult(raw);
		this.db.prepare("UPDATE party_operations SET status='done',response=? WHERE id=? AND (? IS NULL OR computer=?) AND status IN ('queued','sent')")
			.run(JSON.stringify(response), response.id, computer ?? null, computer ?? null);
		this.notify();
	}
	validate(store: PartyStore, computer: string, request: PartyOperation): void {
		const sender = store.member(computer === "local" ? request.sender : agentId(computer, request.sender));
		if (!sender || sender.heartbeat <= Date.now() - LEASE_MS || sender.agent_epoch !== request.sender_epoch
			|| computer !== "local" && (!store.computerOnline(computer) || sender.computer !== computer)) throw Error("The requesting agent is no longer connected.");
		if (request.kind === "fork" && computer !== "local") throw Error("Fork the agent on its source computer.");
	}
	recent(session: string): { id: string; computer: string; status: string; response: OperationResult | null }[] {
		const rows = this.db.prepare("SELECT id,computer,status,response FROM party_operations WHERE json_extract(request,'$.sender')=? ORDER BY created DESC LIMIT 20").all(session) as unknown as Outgoing[];
		return rows.map(row => ({ id: row.id, computer: row.computer, status: row.status, response: row.response ? JSON.parse(row.response) : null }));
	}
	wait(id: string, signal?: AbortSignal): Promise<OperationResult> {
		const table = "party_operations";
		return new Promise((resolve, reject) => {
			let finished = false;
			const done = (error?: unknown, value?: OperationResult) => {
				if (finished) return; finished = true;
				clearInterval(timer); watcher.close(); signal?.removeEventListener("abort", abort); this.waits.delete(closed);
				error ? reject(error) : resolve(value!);
			};
			const check = () => {
				try {
					const row = this.db.prepare(`SELECT status,response,request FROM ${table} WHERE id=?`).get(id) as { status: string; response: string | null; request: string } | undefined;
					if (!row) throw Error("Party operation receipt is unavailable.");
					if (!row.response && JSON.parse(row.request).expires <= Date.now()) {
						const response = { id, error: "The party operation timed out. A dispatched operation may have completed; inspect the agent before retrying." };
						this.settle(undefined, response);
						throw Error(`Party operation timed out. Receipt: ${id}`);
					}
					if (row.response) { const response = operationResult(JSON.parse(row.response)); done(response.error ? Error(`${response.error} Receipt: ${id}`) : undefined, response); }
				} catch (error) { done(error); }
			};
			const abort = () => {
				this.db.prepare(`UPDATE ${table} SET status='done',response=? WHERE id=? AND status='queued'`).run(JSON.stringify({ id, error: "Cancelled before dispatch." }), id);
				done(Error(`Party operation wait cancelled. A dispatched operation may still finish. Receipt: ${id}`));
			};
			const closed = () => done(Error(`Party process stopped before the outcome was confirmed. Receipt: ${id}`));
			const watcher = watch(this.directory, (_event, name) => { if (String(name) === "operations-changed") check(); });
			watcher.on("error", error => done(error));
			const timer = setInterval(check, 1000);
			this.waits.add(closed); signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort(); else check();
		});
	}
	close(): void {
		if (this.closed) return;
		for (const close of [...this.waits]) close();
		this.closed = true; this.db.close();
	}
}

import { randomUUID } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentId, nativeId, operationResult, partyOperation, type OperationResult, type PartyOperation } from "./network.ts";
import { CURRENT_MESSAGE_SQL, LEASE_MS, type PartyStore } from "./store.ts";

type OperationInput = { kind: "remove" | "resume"; target: string } | { kind: "create"; computer?: string; cwd: string; task: string; label: string };
interface Outgoing { id: string; computer: string; request: string; status: string; response: string | null }
interface Incoming { request: string; status: string; response: string | null }
export interface DriverControl {
	id: string; kind: "resume" | "close"; target: string; party: string; target_epoch: string; expires: number;
	peer?: { computer: string; sender: string; epoch: string };
}
export interface DriverReference { root: string; owner: string; file: string; seen: number }

/** Durable, narrow lifecycle requests over the party channel, not general remote commands. */
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
			CREATE TABLE IF NOT EXISTS party_driver_hosts (root TEXT PRIMARY KEY,owner TEXT NOT NULL,file TEXT NOT NULL,seen INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS party_driver_members (session TEXT PRIMARY KEY,root TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS party_driver_requests (id TEXT PRIMARY KEY,root TEXT NOT NULL,owner TEXT NOT NULL,
				request TEXT NOT NULL,status TEXT NOT NULL,response TEXT,created INTEGER NOT NULL);`);
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
		if (!self || self.owner !== owner || !self.room) throw Error("Join a party before managing its agents.");
		let computer = "local";
		const now = Date.now(), operation: PartyOperation = { id: randomUUID(), sender: session, sender_epoch: self.epoch,
			party: self.room, kind: input.kind, created: now, expires: now + 300_000 };
		if (input.kind === "create") {
			computer = input.computer ?? "local";
			Object.assign(operation, { cwd: input.cwd, task: input.task, label: input.label });
		} else {
			const peer = store.partyTarget(session, owner, input.target);
			computer = peer.computer ?? "local";
			operation.target = nativeId(peer.session); operation.target_epoch = peer.epoch;
		}
		if (computer === "local" ? !this.hostOnline() : !store.computerOnline(computer)) throw Error("The agent's Desk computer is not connected.");
		const pending = this.db.prepare("SELECT count(*) AS n FROM party_operations WHERE status IN ('queued','sent')").get() as { n: number };
		if (pending.n >= 64) throw Error("Too many party operations are awaiting an outcome.");
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
	autoWakes(store: PartyStore, targets: string[], controller: string, execute: (computer: string, request: PartyOperation) => Promise<OperationResult["result"]>): void {
		if (this.closed || !targets.length) return;
		const candidates = this.db.prepare(`SELECT m.id,m.sender,m.recipient FROM messages m
			JOIN party_agents sender ON sender.session=m.sender JOIN party_agents recipient ON recipient.session=m.recipient
			LEFT JOIN party_incoming incoming ON incoming.id=m.id AND incoming.computer=COALESCE(sender.computer,'local')
			WHERE incoming.id IS NULL AND m.admitted=0 AND m.wake=1 AND m.kind='message' AND recipient.computer IS NULL
				AND recipient.room<>'' AND sender.room=recipient.room AND recipient.muted=0 AND recipient.wakes<8 AND sender.heartbeat>?
				AND (${CURRENT_MESSAGE_SQL}) AND m.recipient IN (${targets.map(() => "?").join(",")})
			ORDER BY m.created,m.id LIMIT 64`).all(Date.now() - LEASE_MS, ...targets) as { id: string; sender: string; recipient: string }[];
		for (const message of candidates) {
			const sender = store.member(message.sender)!, target = store.member(message.recipient)!, computer = sender.computer ?? "local", now = Date.now();
			if (sender.computer && !store.computerOnline(sender.computer)) continue;
			void this.receive(computer, { id: message.id, kind: "resume", sender: nativeId(sender.session), sender_epoch: sender.epoch,
				target: target.session, target_epoch: target.epoch, party: target.room, created: now, expires: now + 300_000 },
				request => { this.validate(store, computer, request); return execute(computer, request); }, controller)
				.catch(() => { if (!this.closed) console.error("Party automatic wake admission could not be saved."); });
		}
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
		if (!sender || sender.heartbeat <= Date.now() - LEASE_MS || sender.room !== request.party || sender.epoch !== request.sender_epoch
			|| computer !== "local" && (!store.computerOnline(computer) || sender.computer !== computer)) throw Error("The requesting agent's party membership changed.");
		if (request.kind !== "create") {
			const target = store.member(request.target!);
			if (!target || target.computer || target.room !== request.party || target.epoch !== request.target_epoch
				|| target.session === sender.session) throw Error("The target agent's party membership changed.");
		}
	}
	recent(session: string): { id: string; computer: string; status: string; response: OperationResult | null }[] {
		const rows = this.db.prepare("SELECT id,computer,status,response FROM party_operations WHERE json_extract(request,'$.sender')=? ORDER BY created DESC LIMIT 20").all(session) as unknown as Outgoing[];
		return rows.map(row => ({ id: row.id, computer: row.computer, status: row.status, response: row.response ? JSON.parse(row.response) : null }));
	}
	rememberDriver(root: string, file: string, children: string[]): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const inserted = this.db.prepare("INSERT OR IGNORE INTO party_driver_hosts(root,owner,file,seen) VALUES (?,'',?,0)").run(root, file);
			if (inserted.changes) for (const child of children) this.db.prepare("INSERT OR IGNORE INTO party_driver_members(session,root) VALUES (?,?)").run(child, root);
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	driverKnown(root: string): boolean { return !!this.db.prepare("SELECT 1 FROM party_driver_hosts WHERE root=?").get(root); }
	driverChildren(root: string): string[] {
		return (this.db.prepare("SELECT session FROM party_driver_members WHERE root=? ORDER BY session").all(root) as { session: string }[]).map(row => row.session);
	}
	private stopController(controller: string): void {
		this.db.prepare("UPDATE party_incoming SET status='done',response=json_object('id',id,'error',?) WHERE controller=? AND status='running'")
			.run("The owning driver stopped after admission. Inspect the agent; this wake was not replayed.", controller);
	}
	driver(session: string): DriverReference | undefined {
		return this.db.prepare(`SELECT h.* FROM party_driver_members m JOIN party_driver_hosts h ON h.root=m.root WHERE m.session=?`)
			.get(session) as unknown as DriverReference | undefined;
	}
	registerDriver(root: string, owner: string, file: string, children: string[]): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const old = this.db.prepare("SELECT owner FROM party_driver_hosts WHERE root=?").get(root) as { owner: string } | undefined;
			if (old?.owner !== owner) {
				if (old) this.stopController(old.owner);
				for (const row of this.db.prepare("SELECT id FROM party_driver_requests WHERE root=? AND status IN ('queued','running')").all(root)) {
					this.finishDriver(String(row.id), { id: String(row.id), error: "The parent driver restarted; its previous request was not replayed." });
				}
			}
			this.db.prepare("INSERT INTO party_driver_hosts VALUES (?,?,?,?) ON CONFLICT(root) DO UPDATE SET owner=excluded.owner,file=excluded.file,seen=excluded.seen")
				.run(root, owner, file, Date.now());
			this.db.prepare("DELETE FROM party_driver_members WHERE root=?").run(root);
			const insert = this.db.prepare("INSERT INTO party_driver_members VALUES (?,?) ON CONFLICT(session) DO UPDATE SET root=excluded.root");
			for (const session of children) insert.run(session, root);
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	stopDriver(root: string, owner: string): void {
		this.stopController(owner);
		this.db.prepare("UPDATE party_driver_hosts SET seen=0 WHERE root=? AND owner=?").run(root, owner);
		for (const row of this.db.prepare("SELECT id FROM party_driver_requests WHERE root=? AND owner=? AND status IN ('queued','running')").all(root, owner)) {
			this.finishDriver(String(row.id), { id: String(row.id), error: "The parent driver stopped before the outcome was confirmed." });
		}
	}
	queueDriver(reference: DriverReference, control: DriverControl): void {
		const pending = this.db.prepare("SELECT count(*) AS n FROM party_driver_requests WHERE status IN ('queued','running')").get() as { n: number };
		if (pending.n >= 64) throw Error("Too many child controls are awaiting an outcome.");
		this.db.prepare("INSERT OR IGNORE INTO party_driver_requests VALUES (?,?,?,?,'queued',NULL,?)")
			.run(control.id, reference.root, reference.owner, JSON.stringify(control), Date.now());
		this.notify("driver-changed");
	}
	driverRequests(root: string, owner: string): DriverControl[] {
		this.db.prepare("DELETE FROM party_driver_requests WHERE status='done' AND created<?").run(Date.now() - 86_400_000);
		return (this.db.prepare("SELECT request FROM party_driver_requests WHERE root=? AND owner=? AND status='queued' ORDER BY created LIMIT 8")
			.all(root, owner) as { request: string }[]).map(row => JSON.parse(row.request));
	}
	claimDriver(id: string, root: string, owner: string): boolean {
		return !!this.db.prepare("UPDATE party_driver_requests SET status='running' WHERE id=? AND root=? AND owner=? AND status='queued'").run(id, root, owner).changes;
	}
	finishDriver(id: string, response: OperationResult): void {
		if (this.closed) return;
		this.db.prepare("UPDATE party_driver_requests SET status='done',response=? WHERE id=? AND status IN ('queued','running')").run(JSON.stringify(response), id);
		this.notify();
	}
	waitDriver(id: string): Promise<OperationResult> { return this.waitRecord("party_driver_requests", id); }
	wait(id: string, signal?: AbortSignal): Promise<OperationResult> { return this.waitRecord("party_operations", id, signal); }
	private waitRecord(table: "party_operations" | "party_driver_requests", id: string, signal?: AbortSignal): Promise<OperationResult> {
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
						if (table === "party_operations") this.settle(undefined, response); else this.finishDriver(id, response);
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

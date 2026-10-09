import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease, SessionOwnedError } from "../../../pi-session-ownership/lease.ts";
import { atomicJson, readState } from "../../manage/store.ts";
import { InputLedger } from "./inputs.ts";
import type { UpdateCheckpoint } from "../shared/checkpoint.ts";

export interface SupervisorRecord {
	version: 1; instance: string; owner: string; pid: number; node: string; entry: string;
	/** Runtime id this wrapper's code was loaded from; old versions are kept while it lives. */
	runtime?: string;
}
const file = (directory: string) => join(directory, "supervisor.json");
export function liveSupervisor(directory: string): SupervisorRecord | undefined {
	let record: SupervisorRecord;
	try { record = JSON.parse(readFileSync(file(directory), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	if (record.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.instance) || !/^[a-f0-9-]{36}$/.test(record.owner)
		|| !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.node !== "string" || typeof record.entry !== "string")
		throw new Error("Invalid login supervisor record.");
	try { const lease = new SessionLease(join(directory, "supervisor")); lease.close(); return; }
	catch (error) { if (error instanceof SessionOwnedError) return record; throw error; }
}

/** The login wrapper stays alive through host replacement, preserving its OS service/job lifetime. */
export class LoginSupervisor {
	readonly record: SupervisorRecord;
	private lease: SessionLease;
	private directory: string;
	constructor(directory: string, owner: string, node: string, entry: string) {
		this.directory = directory; this.lease = new SessionLease(join(directory, "supervisor"));
		const runtime = basename(process.env.PI_DESK_RUNTIME ?? "");
		this.record = { version: 1, instance: randomUUID(), owner, pid: process.pid, node, entry, ...(runtime ? { runtime } : {}) };
		try { atomicJson(file(directory), this.record); } catch (error) { this.lease.close(); throw error; }
	}
	close(): void {
		try {
			if (JSON.parse(readFileSync(file(this.directory), "utf8")).instance === this.record.instance) unlinkSync(file(this.directory));
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		finally { this.lease.close(); }
	}
}

export function handoffTicket(directory: string, source: string | undefined): UpdateCheckpoint | undefined {
	const ledger = new InputLedger(directory);
	try {
		const ticket = ledger.checkpoint();
		return ticket?.workers && ticket.state === "committed" && ticket.source === source ? ticket : undefined;
	} finally { ledger.close(); }
}

/** Wait only for controller selection; restarting the host never restarts its actors. */
export async function waitHandoffSelection(home: string, directory: string, ticket: UpdateCheckpoint,
	signal: AbortSignal, timeout = 60_000): Promise<string> {
	const until = Date.now() + timeout;
	for (;;) {
		signal.throwIfAborted();
		const state = readState(home);
		if (state?.active === ticket.target) return ticket.target;
		if (state?.active !== ticket.source) throw new Error("Runtime selection changed during the host handoff.");
		const current = handoffTicket(directory, ticket.source);
		if (!current || current.id !== ticket.id) throw new Error("The host handoff changed before selection.");
		if (current.resumeSource) return ticket.source;
		if (Date.now() >= until) throw new Error("Runtime selection is unconfirmed; actors were left running. Inspect the update operation before starting the host.");
		await delay(150, undefined, { signal });
	}
}

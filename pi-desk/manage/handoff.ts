import { join } from "node:path";
import { SessionLease, SessionOwnedError } from "../../pi-session-ownership/lease.ts";
import { InputLedger } from "../src/host/inputs.ts";
import type { UpdateCheckpoint } from "../src/shared/checkpoint.ts";
import { atomicJson, readRelease, readState } from "./store.ts";
import { canonicalPath } from "./installation.ts";

const lease = (path: string): SessionLease | undefined => {
	try { return new SessionLease(path); }
	catch (error) { if (error instanceof SessionOwnedError) return; throw error; }
};

/**
 * Finish a host handoff from durable state alone. A committed checkpoint means the old host has handed its
 * conversations to whichever host starts next and stopped; what remains is choosing that host's runtime. The prepared
 * update goes ahead while it is still the armed one: it was verified before the old host stopped. Otherwise the
 * previous runtime resumes the conversations. Either way the saved actors keep their identities and the input ledger
 * is untouched, so accepted work is never sent twice.
 *
 * Returns the runtime to start, or undefined while a host is still running or a controller still owns the operation
 * (pass ownsOperation when the caller is that controller). This replaced a deadline: a controller whose request timed
 * out after the commit gave up, and the login supervisor then waited 60 s and exited, leaving no host at all.
 */
export function settleHandoff(home: string, directory: string, ticket: UpdateCheckpoint, ownsOperation = false): string | undefined {
	const operation = ownsOperation ? undefined : lease(join(home, "operation"));
	if (!ownsOperation && !operation) return;
	try {
		// Nothing may start or run a host meanwhile: hold the same leases a runtime selection does.
		const manage = lease(join(home, "manage")), launch = manage && lease(join(directory, "launch")), host = launch && lease(join(directory, "host"));
		try {
			if (!manage || !launch || !host) return;
			const ledger = new InputLedger(directory);
			try {
				const current = ledger.checkpoint();
				if (!current || current.id !== ticket.id || current.state !== "committed" || current.source !== ticket.source || current.target !== ticket.target)
					throw new Error("The host handoff changed before selection.");
				const state = readState(home);
				if (state?.active === ticket.target) return ticket.target;
				if (state?.active !== ticket.source) throw new Error("Runtime selection changed during the host handoff.");
				if (current.resumeSource) return ticket.source;
				if (state.pending === ticket.target && state.autoApply === ticket.target) {
					try {
						if (canonicalPath(readRelease(home, ticket.target).source) !== canonicalPath(state.source)) throw new Error("Runtime source changed.");
						atomicJson(join(home, "state.json"), { ...state, active: ticket.target, previous: state.active, pending: undefined, autoApply: undefined });
						return ticket.target;
					} catch { /* An unreadable release falls back to the previous runtime. */ }
				}
				current.resumeSource = true; ledger.writeCheckpoint(current);
				return ticket.source;
			} finally { ledger.close(); }
		} finally { host?.close(); launch?.close(); manage?.close(); }
	} finally { operation?.close(); }
}

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { probeHost } from "../src/host/lifecycle.ts";
import { liveSupervisor } from "../src/host/login-supervisor.ts";
import { readInstallation } from "./installation.ts";
import { readState, validId } from "./store.ts";

export interface PruneResult { kept: string[]; removed: string[]; busy: string[]; archives: number; skipped?: string }

/** Slots named by any actor record, live or stale. Unreadable records stop pruning rather than guess. */
function workerPins(home: string): Set<string> {
	const pins = new Set<string>(), workers = join(readInstallation(home).directory, "workers");
	if (!existsSync(workers)) return pins;
	for (const key of readdirSync(workers)) {
		for (const name of ["worker.json", "bootstrap.json"]) {
			const file = join(workers, key, name);
			if (!existsSync(file)) continue;
			const value = JSON.parse(readFileSync(file, "utf8"));
			const directory = value?.runtimeDirectory ?? value?.options?.runtimeDirectory;
			if (directory === undefined) continue;
			if (typeof directory !== "string") throw new Error(`Unreadable runtime pin in ${file}`);
			// Ids are content digests; match by name so path aliases (8.3, case, symlinks) cannot hide a pin.
			if (validId(basename(directory))) pins.add(basename(directory));
		}
	}
	return pins;
}

/** `<runtime>/keep`: one runtime id or prefix (6+ hex) per line, for processes that run a version outside Desk. */
export function keepList(home: string): string[] {
	const file = join(home, "keep");
	if (!existsSync(file)) return [];
	const entries = readFileSync(file, "utf8").split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean);
	const invalid = entries.find(entry => !/^[a-f0-9]{6,64}$/.test(entry));
	if (invalid) throw new Error(`Invalid entry in ${file}: ${invalid}`);
	return entries;
}

/** Long-lived Desk processes run code from the slot that was active when they started, not from state.json. */
async function processPins(home: string): Promise<string[]> {
	const directory = readInstallation(home).directory, pins: string[] = [];
	const host = await probeHost(directory);
	if (host.state === "running") {
		if (!validId(host.host?.runtime)) throw new Error("the running host did not report its runtime");
		pins.push(host.host!.runtime!);
	} else if (host.state !== "stopped") throw new Error(`the host is ${host.state}`);
	const supervisor = liveSupervisor(directory);
	if (supervisor) {
		if (!validId(supervisor.runtime)) throw new Error("the login supervisor started before runtime tracking; old versions are kept until it restarts");
		pins.push(supervisor.runtime);
	}
	return pins;
}

function archiveOf(versions: string, id: string): string | undefined {
	try { return JSON.parse(readFileSync(join(versions, id, "runtime.json"), "utf8"))?.artifact?.dependencies; }
	catch { return undefined; }
}

/**
 * Remove runtime slots nothing can use: not active, pending, previous (rollback), running the host or login
 * supervisor, pinned by an actor or listed in `keep`.
 * Callers must hold the runtime `manage` lease. A slot whose files are open (Windows) cannot be renamed and is left.
 */
export async function pruneRuntimes(home: string, keepArchive?: string): Promise<PruneResult> {
	const versions = resolve(home, "versions"), state = readState(home);
	if (!state?.active) return { kept: [], removed: [], busy: [], archives: 0 };
	let pins: Set<string>, prefixes: string[];
	try { pins = new Set([...workerPins(home), ...await processPins(home)]); prefixes = keepList(home); }
	catch (error) { return { kept: [], removed: [], busy: [], archives: 0, skipped: String(error) }; }
	const keep = new Set([state.active, state.pending, state.previous, state.autoApply, ...pins].filter(validId));
	for (const id of existsSync(versions) ? readdirSync(versions) : []) if (validId(id) && prefixes.some(prefix => id.startsWith(prefix))) keep.add(id);
	const trash = join(home, ".trash"), removed: string[] = [], busy: string[] = [];
	await mkdir(trash, { recursive: true, mode: 0o700 });
	for (const id of existsSync(versions) ? readdirSync(versions) : []) {
		if (!validId(id) || keep.has(id)) continue;
		try { await rename(join(versions, id), join(trash, `${id}-${randomUUID()}`)); removed.push(id); }
		catch { busy.push(id); }
	}
	// Orphans from interrupted preparations; only created under the manage lease the caller holds.
	for (const entry of await readdir(home)) {
		if (/^\.(?:download|staging)-/.test(entry)) await rename(join(home, entry), join(trash, `${entry}-${randomUUID()}`)).catch(() => undefined);
	}
	for (const entry of await readdir(trash)) await rm(join(trash, entry), { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
	const archives = join(home, "archives"), used = new Set([...keep].map(id => archiveOf(versions, id)).filter(Boolean));
	if (keepArchive) used.add(basename(keepArchive).replace(/\.tgz$/, ""));
	let archiveCount = 0;
	for (const name of existsSync(archives) ? readdirSync(archives) : []) {
		const digest = name.replace(/\.tgz$/, "");
		if (!validId(digest) || used.has(digest)) continue;
		await rm(join(archives, name), { force: true }).then(() => archiveCount++, () => undefined);
	}
	return { kept: [...keep], removed, busy, archives: archiveCount };
}

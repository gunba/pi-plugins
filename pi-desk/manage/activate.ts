import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { probeHost } from "../src/host/lifecycle.ts";
import { readLoginConfig } from "../src/host/login-config.ts";
import { managerStatus } from "../src/host/login-manager.ts";
import { canonicalPath, launcherPath, readInstallation, saveInstallation, type RuntimeInstallation } from "./installation.ts";
import { atomicJson, readRelease, readState } from "./store.ts";

async function stopped<T>(directory: string, action: () => Promise<T>): Promise<T> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const edit = new SessionLease(join(directory, "login-edit"));
	let launch: SessionLease | undefined, host: SessionLease | undefined;
	try {
		launch = new SessionLease(join(directory, "launch"));
		const current = await probeHost(directory);
		if (current.state !== "stopped") throw new Error(`Stop the host before changing its runtime (currently ${current.state}). No process was stopped or killed.`);
		const login = readLoginConfig(directory);
		if (login) {
			const status = await managerStatus(login);
			if (status.error) throw new Error(status.error);
			if (!["inactive", "failed", "missing", "not-found", "Ready", "Disabled"].includes(status.state ?? ""))
				throw new Error("Stop login-start before changing the runtime; its process may still be starting.");
		}
		host = new SessionLease(join(directory, "host"));
		return await action();
	} finally { host?.close(); launch?.close(); edit.close(); }
}

export async function configureRuntime(home: string, options: Omit<RuntimeInstallation, "format">): Promise<void> {
	const lock = new SessionLease(join(home, "manage"));
	try {
		if (!readState(home)) throw new Error("Stage the installed Pi package before configuring its runtime.");
		const value: RuntimeInstallation = { ...options, format: 1, directory: resolve(options.directory),
			agentDir: realpathSync(options.agentDir), cwd: realpathSync(options.cwd),
			...(options.sessionDir ? { sessionDir: resolve(options.sessionDir) } : {}) };
		if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error("Invalid host port.");
		let previous: RuntimeInstallation | undefined;
		try { previous = readInstallation(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (previous && canonicalPath(previous.directory) !== canonicalPath(value.directory))
			throw new Error("This managed installation belongs to another data directory. Use a separate runtime installation.");
		await stopped(value.directory, async () => { saveInstallation(home, value); });
	} finally { lock.close(); }
}

/** Select ready code only; starting it and resuming conversations are separate actions. */
export async function activateRuntime(home: string, requested?: string) {
	const lock = new SessionLease(join(home, "manage"));
	try {
		const state = readState(home), installation = readInstallation(home);
		if (!state) throw new Error("No staged runtime installation.");
		const id = requested ?? state.pending;
		if (!id) throw new Error("No pending runtime to activate.");
		const release = readRelease(home, id);
		if (canonicalPath(release.source) !== canonicalPath(state.source)) throw new Error("Runtime source does not match this installation.");
		if (state.active === id) return release;
		return await stopped(installation.directory, async () => {
			const login = readLoginConfig(installation.directory);
			if (login && (canonicalPath(login.entry) !== canonicalPath(launcherPath(home))
				|| canonicalPath(login.node) !== canonicalPath(process.execPath))) {
				throw new Error("Login-start still points to another app or Node executable. Migrate it to the managed launcher before activating.");
			}
			atomicJson(join(home, "state.json"), { ...state, active: id, previous: state.active,
				pending: state.pending === id ? undefined : state.pending });
			return release;
		});
	} finally { lock.close(); }
}

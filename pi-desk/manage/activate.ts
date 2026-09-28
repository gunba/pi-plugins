import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { probeHost, stopHost } from "../src/host/lifecycle.ts";
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
				pending: state.pending === id ? undefined : state.pending, autoApply: undefined });
			return release;
		});
	} finally { lock.close(); }
}

/** Hold startup admission; interrupt workers only with consent for this exact prepared release. */
export async function activatePreparedRuntime(home: string, stopFor?: string): Promise<{ release?: string; restart?: boolean; deferred?: number }> {
	const manage = new SessionLease(join(home, "manage"));
	let edit: SessionLease | undefined, launch: SessionLease | undefined, host: SessionLease | undefined;
	try {
		const state = readState(home), installation = readInstallation(home);
		if (stopFor && (state?.pending !== stopFor || state.autoApply !== stopFor))
			throw new Error("The prepared update changed. Review it before stopping sessions.");
		if (!state?.pending || state.autoApply !== state.pending) return {};
		const release = readRelease(home, state.pending);
		if (canonicalPath(release.source) !== canonicalPath(state.source)) throw new Error("Runtime source does not match this installation.");
		edit = new SessionLease(join(installation.directory, "login-edit"));
		launch = new SessionLease(join(installation.directory, "launch"));
		const login = readLoginConfig(installation.directory);
		const before = await probeHost(installation.directory);
		if (!["running", "stopped"].includes(before.state)) throw new Error(`Host is ${before.state}; no update was applied.`);
		if (login) {
			if (canonicalPath(login.entry) !== canonicalPath(launcherPath(home)) || canonicalPath(login.node) !== canonicalPath(process.execPath))
				throw new Error("The configured launcher or Node has changed. Repair login-start before updating.");
			const status = await managerStatus(login);
			if (status.error || before.state === "running" && !status.enabled)
				throw new Error(status.error ?? "Login-start is disabled. Enable it before updating a running host.");
		}
		if (before.state === "running") {
			if (!state.active || before.host?.runtime !== state.active) throw new Error("The running host does not match the selected runtime.");
			const result = await stopHost(installation.directory, { idleOnly: !stopFor, runtime: state.active });
			if (result.deferred !== undefined) return { deferred: result.deferred };
		}
		if (login) {
			const until = Date.now() + 30_000;
			for (;;) {
				const status = await managerStatus(login);
				if (status.error) throw new Error(status.error);
				if (["inactive", "failed", "missing", "not-found", "Ready", "Disabled"].includes(status.state ?? "")) break;
				if (Date.now() >= until) throw new Error("Login-start has not finished stopping. No runtime was selected.");
				await delay(150);
			}
		}
		host = new SessionLease(join(installation.directory, "host"));
		atomicJson(join(home, "state.json"), { ...state, active: release.id, previous: state.active, pending: undefined, autoApply: undefined });
		return { release: release.desk, restart: before.state === "running" };
	} finally { host?.close(); launch?.close(); edit?.close(); manage.close(); }
}

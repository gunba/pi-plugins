import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { loginEnvironment, loginFile, loginPathsValid, makeLoginConfig, readLoginConfig, saveLoginConfig, type LoginConfig } from "./login-config.ts";
import { disableManager, installManager, managerStatus, removeManager, startManager, stopManager, type LoginStatus } from "./login-manager.ts";
import { probeHost, startHost, stopHost, type StartedHost } from "./lifecycle.ts";
import { atomicJson } from "../../manage/store.ts";
import { canonicalPath } from "../../manage/installation.ts";

export async function loginStatus(directory: string): Promise<LoginStatus> {
	const config = readLoginConfig(directory);
	if (!config) return { configured: false };
	const status = await managerStatus(config);
	status.environment = Object.keys(config.environment).sort();
	if (!loginPathsValid(config)) status.error = "The saved Node executable, app entry point or project directory is missing. Remove/reinstall login-start with the current paths.";
	else if (status.state === "failed") status.error = "Login-start failed. Check login-error.txt, host.log and the user service/task status.";
	else if (status.platform === "win32" && status.state === "Ready" && status.result && status.result !== 267011) {
		status.error = `The last login-start task returned ${status.result}. Check login-error.txt, host.log and Task Scheduler.`;
	}
	return status;
}
/** Preserve startup options and private environment while replacing the app entry. */
export async function migrateLogin(directory: string, entry: string): Promise<void> {
	const original = readLoginConfig(directory);
	if (!original) return;
	const edit = new SessionLease(join(directory, "login-edit"));
	let launch: SessionLease | undefined;
	try {
		launch = new SessionLease(join(directory, "launch"));
		if ((await probeHost(directory)).state !== "stopped") throw new Error("Stop login-start before migrating its entry.");
		const status = await managerStatus(original);
		if (status.error) throw new Error(status.error);
		if (!["inactive", "failed", "missing", "not-found", "Ready", "Disabled"].includes(status.state ?? ""))
			throw new Error("The login-start process has not stopped.");
		const changed = canonicalPath(original.entry) !== canonicalPath(entry) || canonicalPath(original.node) !== canonicalPath(process.execPath);
		if (!changed && !["missing", "not-found"].includes(status.state ?? "")) return;
		atomicJson(join(directory, "login-before-managed.json"), original);
		const config = { ...original, entry, node: process.execPath };
		await disableManager(original); await removeManager(original);
		try {
			atomicJson(loginFile(directory), config);
			await installManager(config);
			if (!status.enabled) await disableManager(config);
		} catch {
			try {
				await removeManager(config);
				atomicJson(loginFile(directory), original);
				await installManager(original);
				if (!status.enabled) await disableManager(original);
			} catch { throw new Error("Login migration and restoration are unconfirmed. Check login.json and login-before-managed.json locally. The host was not started."); }
			throw new Error("Login migration failed; the previous entry was restored and remains stopped.");
		}
	} finally { launch?.close(); edit.close(); }
}
export async function stopLogin(config: LoginConfig): Promise<{ stopped: boolean; unclean?: boolean }> {
	const before = await probeHost(config.directory);
	await stopManager(config);
	if (config.platform === "linux") {
		const result = await stopHost(config.directory);
		return { ...result, stopped: result.stopped || before.state !== "stopped" };
	}
	// No End/TerminateTask call: wait for the Node host and hidden task wrapper.
	const until = Date.now() + 30_000;
	let result = { stopped: false } as { stopped: boolean; unclean?: boolean };
	while (Date.now() < until) {
		const host = await probeHost(config.directory), manager = await managerStatus(config);
		if (manager.error) throw new Error(manager.error);
		if (host.state !== "unresponsive") {
			const stopped = await stopHost(config.directory);
			result = { stopped: result.stopped || stopped.stopped, unclean: result.unclean || stopped.unclean };
			if (!["Running", "Queued"].includes(manager.state ?? "")) return result;
		}
		await delay(150);
	}
	throw new Error("Login-start is still stopping. Check status; no task or process was force-killed.");
}
export async function installLogin(directory: string, cwd: string, arguments_: string[], environment: string[]): Promise<void> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const edit = new SessionLease(join(directory, "login-edit"));
	let lock: SessionLease | undefined;
	try {
		lock = new SessionLease(join(directory, "launch"));
		if (readLoginConfig(directory)) throw new Error("Login-start is already configured. Remove it before changing its paths, environment or startup options.");
		if ((await probeHost(directory)).state !== "stopped") throw new Error("Stop this host before installing login-start.");
		const config = makeLoginConfig(directory, cwd, arguments_, environment);
		saveLoginConfig(config);
		try { await installManager(config); }
		catch (error) {
			try { await removeManager(config); unlinkSync(loginFile(directory)); }
			catch { throw new Error("Login-start installation did not complete and cleanup could not be confirmed. Inspect login status, then login remove. Foreground serve remains available."); }
			throw new Error(`Login-start could not be installed. Ordinary start/serve remain available. ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally { lock?.close(); edit.close(); }
}
export async function removeLogin(directory: string): Promise<void> {
	const config = readLoginConfig(directory);
	if (!config) return;
	const edit = new SessionLease(join(directory, "login-edit"));
	try {
		await disableManager(config);
		await stopLogin(config);
		await removeManager(config);
		unlinkSync(loginFile(directory));
	} finally { edit.close(); }
}
export async function startLogin(config: LoginConfig): Promise<StartedHost> {
	const current = await probeHost(config.directory);
	if (current.state === "running") return { host: current.host!, reused: true };
	if (current.state !== "stopped") throw new Error(`Host is ${current.state}. ${current.error ?? "Wait for shutdown."}`);
	await startManager(config);
	const until = Date.now() + 30_000;
	while (Date.now() < until) {
		const status = await probeHost(config.directory);
		if (status.state === "running") return { host: status.host!, reused: false };
		const manager = await managerStatus(config);
		if (manager.error || manager.state === "failed") throw new Error(manager.error ?? `Login-start failed. Check ${join(config.directory, "host.log")} and login status.`);
		await delay(300);
	}
	throw new Error(`Login-start is unconfirmed. Check login status and ${join(config.directory, "host.log")}. No process was killed.`);
}
export async function runLogin(directory: string): Promise<void> {
	const config = readLoginConfig(directory);
	if (!config) throw new Error("Login-start is not configured.");
	if (config.platform !== process.platform) throw new Error("Login-start was configured for another operating system. Reinstall it on this computer.");
	if (!loginPathsValid(config)) throw new Error("Login-start paths have changed. Remove/reinstall it with the current Node/app paths.");
	let ready = false, stopping = false;
	const stop = () => {
		stopping = true;
		if (ready) void stopHost(directory).catch(error => console.error(error instanceof Error ? error.message : String(error)));
	};
	process.on("SIGTERM", stop); process.on("SIGINT", stop);
	try {
		const environment = loginEnvironment(config);
		// The launcher supplies this non-secret code identity; never save it in login.json.
		if (process.env.PI_DESK_RUNTIME) environment.PI_DESK_RUNTIME = process.env.PI_DESK_RUNTIME;
		const started = await startHost(directory, config.cwd, config.arguments, { managed: true, environment });
		rmSync(join(directory, "login-error.txt"), { force: true });
		ready = true; if (stopping) stop();
		const code = await started.exited;
		if (code !== 0) throw new Error(`The login-start host exited (${code ?? "signal"}). Check host.log; saved workers were not restarted.`);
	} catch (error) {
		writeFileSync(join(directory, "login-error.txt"), `${error instanceof Error ? error.message : String(error)}\n`, { mode: 0o600 });
		throw error;
	} finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { activateRuntime, configureRuntime } from "./activate.ts";
import { canonicalPath, launcherPath, readInstallation, type RuntimeInstallation } from "./installation.ts";
import { atomicJson, readRelease, readState, versionDirectory } from "./store.ts";
import { stageRuntime } from "./stage.ts";
import { probeHost, stopHost } from "../src/host/lifecycle.ts";
import { migrateLogin, removeLogin, stopLogin } from "../src/host/login.ts";
import { readLoginConfig } from "../src/host/login-config.ts";

export type DeskOperation = "setup" | "stage" | "update" | "restart" | "rollback" | "stop" | "login-install" | "login-remove";
export interface Operation {
	id: string; action: DeskOperation; phase: "running" | "complete" | "failed" | "interrupted";
	started: string; updated: string; message: string;
}
export interface OperationOptions {
	home: string; source: string; agentDir: string; cwd: string; directory: string;
	action: DeskOperation; signal?: AbortSignal; progress?: (value: Operation) => void;
}
const operationFile = (home: string) => join(home, "operation.json");
export function operationStatus(home: string): Operation | undefined {
	const read = (): Operation | undefined => {
		let value: Operation;
		try { value = JSON.parse(readFileSync(operationFile(home), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (!value || !["setup", "stage", "update", "restart", "rollback", "stop", "login-install", "login-remove"].includes(value.action)
			|| !["running", "complete", "failed", "interrupted"].includes(value.phase) || typeof value.message !== "string")
			throw new Error("Invalid Desk operation record.");
		return value;
	};
	const value = read();
	if (value?.phase === "running") {
		let lease: SessionLease;
		try { lease = new SessionLease(join(home, "operation")); } catch { return value; }
		try {
			// Completion can be published between the first read and lease release.
			const current = read();
			return current?.phase === "running"
				? { ...current, phase: "interrupted", message: "The operation ended without confirmation. Check status before retrying." } : current;
		} finally { lease.close(); }
	}
	return value;
}
export function extensionLocation(packageRoot: string, agentDir: string) {
	const root = realpathSync(packageRoot), version = dirname(root);
	if (basename(root) === "source" && basename(dirname(version)) === "versions" && existsSync(join(version, "runtime.json"))) {
		const home = dirname(dirname(version)), release = readRelease(home, basename(version));
		return { home, source: release.source, pinned: true };
	}
	return { home: join(agentDir, "desk", "runtime"), source: root, pinned: false };
}
export async function deskStatus(home: string, directory: string) {
	const state = readState(home), operation = operationStatus(home);
	let installation: RuntimeInstallation | undefined;
	try { installation = readInstallation(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return { state, installation, operation, host: await probeHost(installation?.directory ?? directory) };
}
export function statusText(status: Awaited<ReturnType<typeof deskStatus>>): string {
	const short = (id?: string) => id?.slice(0, 12) ?? "none";
	return [`Host: ${status.host.state}`, `Active: ${short(status.state?.active)} · staged: ${short(status.state?.pending)}`,
		...(status.host.host ? [`Conversations: ${status.host.host.sessions.active} · working: ${status.host.host.sessions.working}`] : []),
		...(status.operation ? [`${status.operation.action}: ${status.operation.phase} — ${status.operation.message}`] : [])].join("\n");
}
export async function runLauncher(home: string, args: string[], signal?: AbortSignal): Promise<string> {
	return await new Promise((accept, reject) => {
		const child = spawn(process.execPath, [launcherPath(home), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
		let output = "";
		child.stdout.on("data", chunk => { output = (output + chunk).slice(-16000); });
		// Child errors can contain private startup settings; keep diagnostics in host files.
		child.stderr.on("data", () => {});
		child.once("error", reject);
		child.once("close", code => code === 0 ? accept(output.trim()) : reject(new Error(`Desk ${args[0]} failed (${code}). Check host.log and login status.`)));
	});
}
async function installationOptions(options: OperationOptions): Promise<Omit<RuntimeInstallation, "format">> {
	try { return readInstallation(options.home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const legacy = readLoginConfig(options.directory);
	if (legacy) {
		const { values } = parseArgs({ args: legacy.arguments, options: {
			cwd: { type: "string" }, port: { type: "string" }, "data-dir": { type: "string" },
			"agent-dir": { type: "string" }, "session-dir": { type: "string" }, proxy: { type: "string" },
		} });
		return { directory: options.directory, cwd: legacy.cwd, agentDir: resolve(values["agent-dir"] ?? options.agentDir),
			port: Number(values.port ?? 8910), sessionDir: values["session-dir"], proxy: values.proxy };
	}
	const current = await probeHost(options.directory);
	if (current.host) throw new Error("Stop the unmanaged host and retain its startup options before setup. No process was stopped.");
	if (current.state !== "stopped") throw new Error("The existing host cannot be identified. Resolve its status before setup.");
	return { directory: options.directory, agentDir: options.agentDir, cwd: options.cwd, port: 8910 };
}
export async function runOperation(options: OperationOptions): Promise<Operation> {
	const { home } = options;
	mkdirSync(home, { recursive: true, mode: 0o700 });
	let lock: SessionLease;
	try { lock = new SessionLease(join(home, "operation")); } catch { throw new Error("A Desk operation is already in progress. Use /desk status."); }
	const now = new Date().toISOString();
	let value: Operation = { id: randomUUID(), action: options.action, phase: "running", started: now, updated: now, message: "Starting" };
	const publish = (message: string, phase = value.phase) => {
		value = { ...value, phase, message, updated: new Date().toISOString() };
		atomicJson(operationFile(home), value); options.progress?.(value);
	};
	try {
		publish("Checking installation");
		let packages: DefaultPackageManager | undefined, source: ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number] | undefined;
		if (["setup", "stage", "update"].includes(options.action)) {
			const sdk = await import("@earendil-works/pi-coding-agent");
			const settings = sdk.SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
			packages = new sdk.DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings });
			source = packages.listConfiguredPackages().find(pkg => pkg.scope === "user" && pkg.installedPath
				&& canonicalPath(pkg.installedPath) === canonicalPath(options.source));
			if (!source) throw new Error("Install this Pi package in personal settings before managing Desk.");
		}
		if (options.action === "setup") {
			const installation = await installationOptions(options);
			const current = await probeHost(installation.directory);
			if (current.state !== "stopped") throw new Error("Stop the existing host before setup. Its data and account will be retained.");
			await stageRuntime({ source: options.source, home, signal: options.signal, progress: message => publish(message) });
			await configureRuntime(home, installation);
			publish("Moving login-start to the stable launcher");
			await migrateLogin(installation.directory, launcherPath(home));
			await activateRuntime(home);
			publish("Ready. Existing account and native sessions are retained.", "complete");
			return value;
		}
		const installation = readInstallation(home);
		if (options.action === "update") {
			const current = await probeHost(installation.directory);
			if (current.state !== "stopped" && (current.state !== "running" || !current.host?.runtime))
				throw new Error("Stop the unmanaged or unresponsive host before updating the installed package.");
			publish("Updating the installed Pi package");
			packages!.setProgressCallback(event => publish(`Pi package ${event.action}: ${event.type}`));
			try { await packages!.update(source!.source); }
			catch { throw new Error("Pi package update failed. Use Pi's package command locally to inspect authentication or network diagnostics."); }
		}
		if (options.action === "stage" || options.action === "update") {
			await stageRuntime({ source: options.source, home, signal: options.signal, progress: message => publish(message) });
			publish("Prepared. Restart explicitly to apply a pending version.", "complete");
			return value;
		}
		const state = readState(home)!;
		const selected = options.action === "rollback" ? state.previous : options.action === "restart" ? state.pending : undefined;
		if (options.action === "rollback" && !selected) throw new Error("No previous runtime is available.");
		const login = readLoginConfig(installation.directory);
		if (options.action === "login-install" && login) throw new Error("Login-start is already configured.");
		publish("Stopping the host; saved sessions will remain closed");
		if (login) await stopLogin(login); else await stopHost(installation.directory);
		if (options.action === "login-remove") await removeLogin(installation.directory);
		if (options.action === "login-install") await runLauncher(home, ["login", "install"]);
		if (options.action !== "stop") {
			if (selected) await activateRuntime(home, selected);
			publish("Starting the selected runtime");
			await runLauncher(home, ["start"]);
		}
		publish(options.action === "stop" ? "Host stopped." : "Host started. Resume saved conversations explicitly.", "complete");
		return value;
	} catch (error) {
		publish(error instanceof Error ? error.message : String(error), "failed");
		throw error;
	} finally { lock.close(); }
}
/** A restart controller must outlive the conversation worker it is stopping. */
export async function launchOperation(home: string, action: Exclude<DeskOperation, "setup">): Promise<void> {
	const state = readState(home);
	if (!state?.active) throw new Error("Run /desk setup first.");
	readRelease(home, state.active);
	const file = join(versionDirectory(home, state.active), "source", "pi-desk", "dist", "host", "manage-cli.js");
	const fd = openSync(join(home, "operation.log"), "a", 0o600);
	try {
		const child = spawn(process.execPath, [file, home, action], { detached: true, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"] });
		try {
			await new Promise<void>((accept, reject) => {
				const timer = setTimeout(() => reject(new Error("Operation startup is unconfirmed. Use /desk status before retrying.")), 10000);
				const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : accept(); };
				child.once("error", finish);
				child.once("exit", code => finish(new Error(`Desk controller exited (${code}). Check operation.log.`)));
				child.on("message", message => {
					const result = message as { type?: string; error?: string };
					if (result.type === "accepted") finish();
					if (result.type === "failed") finish(new Error(result.error));
				});
			});
		} finally { if (child.connected) child.disconnect(); child.unref(); }
	} finally { closeSync(fd); }
}

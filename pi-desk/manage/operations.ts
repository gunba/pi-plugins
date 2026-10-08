import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { activatePreparedRuntime, activateRuntime, configureRuntime } from "./activate.ts";
import { canonicalPath, launcherPath, readInstallation, type RuntimeInstallation } from "./installation.ts";
import { atomicJson, readControllerRelease, readRelease, readState, versionDirectory } from "./store.ts";
import { stageRuntime } from "./stage.ts";
import { probeHost, stopHost } from "../src/host/lifecycle.ts";
import { migrateLogin, removeLogin, stopLogin } from "../src/host/login.ts";
import { readLoginConfig } from "../src/host/login-config.ts";
import { liveSupervisor } from "../src/host/login-supervisor.ts";
import type { RuntimeUpdateState } from "../src/shared/updates.ts";
import { personalPackageSource, releaseSourceSupported } from "./release-source.ts";
import { readUpdateCheck } from "./update-check.ts";
import { launchWindowsController } from "./windows-controller.ts";
import { InputLedger } from "../src/host/inputs.ts";

export type DeskOperation = "setup" | "stage" | "update" | "update-now" | "apply" | "apply-now" | "restart" | "rollback" | "stop" | "login-install" | "login-remove";
export interface Operation {
	id: string; action: DeskOperation; phase: "running" | "waiting" | "complete" | "failed" | "interrupted";
	started: string; updated: string; message: string;
}
export interface OperationOptions {
	home: string; source: string; agentDir: string; cwd: string; directory: string;
	action: DeskOperation; signal?: AbortSignal; progress?: (value: Operation) => void;
	prepared?: string; expected?: string;
	startup?: Pick<RuntimeInstallation, "cwd" | "port" | "sessionDir" | "proxy">;
}
const operationFile = (home: string) => join(home, "operation.json");
async function waitForRestoration(directory: string, id: string, signal?: AbortSignal): Promise<number> {
	const until = Date.now() + 150_000;
	while (Date.now() < until) {
		signal?.throwIfAborted();
		const current = await probeHost(directory), restore = current.host?.restore;
		if (current.state === "running" && restore?.id === id && !restore.pending) return restore.failures;
		await delay(500, undefined, { signal });
	}
	throw new Error("Desk restarted but conversation restoration was not confirmed. Check status before retrying; queued work was not replayed.");
}
export function operationStatus(home: string): Operation | undefined {
	const read = (): Operation | undefined => {
		let value: Operation;
		try { value = JSON.parse(readFileSync(operationFile(home), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (!value || !["setup", "stage", "update", "update-now", "apply", "apply-now", "restart", "rollback", "stop", "login-install", "login-remove"].includes(value.action)
			|| !["running", "waiting", "complete", "failed", "interrupted"].includes(value.phase) || typeof value.message !== "string")
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
export function runtimeUpdateState(home: string): RuntimeUpdateState | undefined {
	const state = readState(home);
	if (!state?.active) return;
	const operation = operationStatus(home), current = readControllerRelease(home, state.active);
	const check = readUpdateCheck(home, state.active);
	return { current: current.desk, pending: state.pending ? readControllerRelease(home, state.pending).desk : undefined, pendingId: state.pending,
		available: check?.available, checkedAt: check?.checkedAt, checkError: check?.error,
		phase: operation?.phase === "running" ? ["apply", "apply-now", "update-now"].includes(operation.action) ? "applying" : "preparing"
			: operation?.phase === "waiting" ? "waiting"
			: operation && ["failed", "interrupted"].includes(operation.phase) ? "failed" : "idle",
		message: operation?.message };
}
export function automaticUpdatePending(home: string): boolean {
	const state = readState(home);
	return !!state?.pending && state.autoApply === state.pending && operationStatus(home)?.phase === "waiting";
}
function armUpdate(home: string, id: string): void {
	const lock = new SessionLease(join(home, "manage"));
	try {
		const state = readState(home);
		if (!state || state.active !== id && state.pending !== id) throw new Error("The prepared runtime changed before activation was requested.");
		atomicJson(join(home, "state.json"), { ...state, autoApply: state.active === id ? undefined : id });
	} finally { lock.close(); }
}
function configuredNode(home: string): string {
	return readLoginConfig(readInstallation(home).directory)?.node ?? process.execPath;
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
	return { state, installation, operation, updates: state?.active ? runtimeUpdateState(home) : undefined,
		host: await probeHost(installation?.directory ?? directory) };
}
export function statusText(status: Awaited<ReturnType<typeof deskStatus>>): string {
	const short = (id?: string) => id?.slice(0, 12) ?? "none";
	return [`Host: ${status.host.state}`,
		...(status.updates ? [`Desk ${status.updates.current}${status.updates.pending ? ` · prepared ${status.updates.pending}` : ""}`] : []),
		`Active: ${short(status.state?.active)} · staged: ${short(status.state?.pending)}`,
		...(status.host.host ? [`Conversations: ${status.host.host.sessions.active} · working: ${status.host.host.sessions.working}`] : []),
		...(status.operation ? [`${status.operation.action}: ${status.operation.phase} — ${status.operation.message}`] : [])].join("\n");
}
export async function runLauncher(home: string, args: string[], signal?: AbortSignal): Promise<string> {
	return await new Promise((accept, reject) => {
		const child = spawn(configuredNode(home), [launcherPath(home), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
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
	return { directory: options.directory, agentDir: options.agentDir, cwd: options.cwd, port: 8910, ...options.startup };
}
export async function runOperation(options: OperationOptions): Promise<Operation> {
	const { home } = options;
	if (options.action === "update-now" && !/^\d+\.\d+\.\d+$/.test(options.expected ?? ""))
		throw new Error("Select the published update before stopping conversations.");
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
		if (["setup", "stage", "update", "update-now"].includes(options.action)) {
			const source = await personalPackageSource(options.source, options.cwd, options.agentDir);
			if (options.action !== "stage" && !releaseSourceSupported(source))
				throw new Error("Prebuilt releases require the unpinned gunba/pi-plugins package. Use /desk stage for a local, pinned or forked source.");
		}
		if (options.action === "setup") {
			const installation = await installationOptions(options);
			const current = await probeHost(installation.directory);
			if (current.state !== "stopped") throw new Error("Stop the existing host before setup. Its data and account will be retained.");
			const state = readState(home);
			if (state && canonicalPath(state.source) !== canonicalPath(options.source)) throw new Error("This runtime belongs to another source package.");
			if (!state) atomicJson(join(home, "state.json"), { format: 1, source: realpathSync(options.source) });
			const { downloadRuntime } = await import("./releases.ts");
			await downloadRuntime({ source: options.source, home, signal: options.signal, progress: message => publish(message) });
			options.signal?.throwIfAborted();
			await configureRuntime(home, installation);
			publish("Moving login-start to the stable launcher");
			await migrateLogin(installation.directory, launcherPath(home));
			await activateRuntime(home);
			publish("Ready. Existing account and native sessions are retained.", "complete");
			return value;
		}
		const installation = readInstallation(home);
		if (options.action === "update" || options.action === "update-now") {
			const current = await probeHost(installation.directory);
			if (current.state !== "stopped" && (current.state !== "running" || !current.host?.runtime))
				throw new Error("The host must be managed and responding before it can be updated.");
			const { downloadRuntime } = await import("./releases.ts");
			const release = await downloadRuntime({ source: options.source, home, signal: options.signal,
				expected: options.action === "update-now" ? options.expected : undefined, progress: message => publish(message) });
			options.signal?.throwIfAborted();
			if (release.id === readState(home)?.active) { publish("Desk is up to date.", "complete"); return value; }
			armUpdate(home, release.id);
			if (options.action === "update-now") options.prepared = release.id;
		}
		if (["update", "update-now", "apply", "apply-now"].includes(options.action)) {
			const forced = options.action === "apply-now" || options.action === "update-now";
			if (forced && !options.prepared) throw new Error("Select the prepared update before stopping sessions.");
			publish(forced ? "Checkpointing conversations before the update" : "Checking whether the prepared update can be applied");
			const previous = readState(home)?.active;
			let result: Awaited<ReturnType<typeof activatePreparedRuntime>>;
			try { result = await activatePreparedRuntime(home, forced ? options.prepared : undefined, forced ? value.id : undefined); }
			catch (error) {
				if (forced && previous && readState(home)?.active === previous && (await probeHost(installation.directory)).state === "stopped") {
					const ledger = new InputLedger(installation.directory);
					let committed = false;
					try {
						const ticket = ledger.checkpoint();
						committed = ticket?.id === value.id && ticket.state === "committed" && ticket.source === previous && ticket.target === options.prepared;
						if (committed && ticket!.workers) { ticket!.resumeSource = true; ledger.writeCheckpoint(ticket!); }
					} finally { ledger.close(); }
					if (committed) {
						publish("The update could not be selected; restoring the previous runtime");
						try {
							if (!liveSupervisor(installation.directory)) await runLauncher(home, ["start"]);
							await waitForRestoration(installation.directory, value.id);
						}
						catch { throw new Error("The update was not selected and restoration is unconfirmed. Saved checkpoints remain; check Desk status before retrying."); }
					}
				}
				throw error;
			}
			if (result.deferred !== undefined) {
				publish("Update ready. It will apply after all open Pi sessions close.", "waiting");
			} else {
				if (result.startup) {
					publish(`Starting Desk ${result.release}`);
					if (result.startup === "launcher") await runLauncher(home, ["start"]);
				}
				const failures = result.startup && forced
					? await waitForRestoration(installation.directory, value.id, options.signal) : 0;
				publish(failures ? `Desk ${result.release} is installed; ${failures} conversations need manual attention.`
					: result.release ? `Desk ${result.release} is installed. Native history and account access are retained.` : "Desk is up to date.", "complete");
			}
			return value;
		}
		if (options.action === "stage") {
			await stageRuntime({ source: options.source, home, signal: options.signal, progress: message => publish(message) });
			publish("Prepared. Restart explicitly to apply a pending version.", "complete");
			return value;
		}
		const state = readState(home)!;
		const selected = options.action === "rollback" ? state.previous : options.action === "restart" ? state.pending : undefined;
		if (options.action === "rollback" && !selected) throw new Error("No previous runtime is available.");
		// Refuse an incompatible target before closing a healthy host or changing login-start.
		if (options.action !== "stop") readRelease(home, selected ?? state.active!);
		const login = readLoginConfig(installation.directory);
		if (options.action === "login-install" && login) throw new Error("Login-start is already configured.");
		publish("Stopping the host; open sessions will be interrupted");
		if (login) await stopLogin(login); else await stopHost(installation.directory);
		if (options.action === "login-remove") await removeLogin(installation.directory);
		if (options.action === "login-install") await runLauncher(home, ["login", "install"]);
		if (options.action !== "stop") {
			await migrateLogin(installation.directory, launcherPath(home));
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
export async function launchOperation(home: string, action: Exclude<DeskOperation, "setup">, target?: string): Promise<void> {
	const state = readState(home);
	if (!state?.active) throw new Error("Run /desk setup first.");
	readControllerRelease(home, state.active);
	const file = join(versionDirectory(home, state.active), "source", "pi-desk", "dist", "host", "manage-cli.js");
	const node = ["update", "update-now", "apply", "apply-now"].includes(action) ? configuredNode(home) : process.execPath;
	if (process.platform === "win32") {
		await launchWindowsController({ home, cwd: readInstallation(home).cwd, node, entry: file,
			args: [home, action, ...(target ? [target] : [])] });
		return;
	}
	const fd = openSync(join(home, "operation.log"), "a", 0o600);
	try {
		const child = spawn(node, [file, home, action, ...(target ? [target] : [])], { detached: true, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"] });
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

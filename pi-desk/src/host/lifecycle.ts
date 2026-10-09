import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease, SessionOwnedError, sessionPath } from "../../../pi-session-ownership/lease.ts";
import { readHostRecord, removeHostRecord, type HostRecord, type HostStatus } from "./host-control.ts";

export interface HostProbe { state: "running" | "stopping" | "stopped" | "unresponsive"; host?: HostStatus; stale?: boolean; error?: string }

export async function controlRequest<T extends { instance: string }>(record: HostRecord, operation: string, body?: object): Promise<T> {
	const response = await fetch(`${record.origin}/api/host/${operation}`, {
		method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000), // A busy host on a slow PC is not unresponsive.
		headers: { Authorization: `Bearer ${record.secret}`, "Content-Type": "application/json" },
		...(body ? { body: JSON.stringify({ ...body, instance: record.instance }) } : {}),
	});
	const result = await response.json() as T & { error?: string };
	if (!response.ok) throw new Error(result.error ?? `Host control returned HTTP ${response.status}.`);
	if (result.instance !== record.instance) throw new Error("The running host does not match its runtime record.");
	return result;
}

function freeLease(directory: string): SessionLease | undefined {
	try { return new SessionLease(join(directory, "host")); } catch { return; }
}

function stoppedProbe(directory: string, error: string, launchHeld: boolean, stale = false): HostProbe {
	let admission: SessionLease | undefined;
	try {
		if (!launchHeld) {
			try { admission = new SessionLease(join(directory, "launch")); }
			catch (cause) { return { state: "unresponsive", error: cause instanceof SessionOwnedError
				? "A host launch or management operation is in progress."
				: `Host launch admission is unavailable: ${cause instanceof Error ? cause.message : String(cause)}` }; }
		}
		const lease = freeLease(directory);
		if (!lease) return { state: "unresponsive", error };
		lease.close();
		return { state: "stopped", ...(stale ? { stale: true } : {}) };
	} finally { admission?.close(); }
}

/** A caller holding launch admission passes its lease; other probes cannot contend with startup. */
export function probeHost(directory: string, launch?: SessionLease): Promise<HostProbe> {
	if (launch && launch.file !== sessionPath(join(directory, "launch"))) throw new Error("Host probe received another directory's launch lease.");
	return inspectHost(directory, !!launch);
}

async function inspectHost(directory: string, launchHeld: boolean): Promise<HostProbe> {
	if (!existsSync(directory)) return { state: "stopped" };
	const record = readHostRecord(directory);
	if (record) {
		try {
			const host = await controlRequest<HostStatus>(record, "status");
			return { state: host.stopping ? "stopping" : "running", host };
		} catch (error) {
			return stoppedProbe(directory, error instanceof Error ? error.message : String(error), launchHeld, true);
		}
	}
	return stoppedProbe(directory, "The host lock is occupied or unavailable, but no runtime record exists. It may be starting or running an older release.", launchHeld);
}

/** Constrained computers can take minutes to load extensions and restore conversations. */
export const STARTUP_WAIT_MS = 180_000, SHUTDOWN_WAIT_MS = 120_000;

export interface StartedHost {
	host: HostStatus; reused: boolean; exited?: Promise<number | null>;
}
export async function startHost(directory: string, cwd: string, arguments_: string[],
	options: { managed?: boolean; environment?: NodeJS.ProcessEnv; entry?: string; waitForLaunch?: number; signal?: AbortSignal } = {}): Promise<StartedHost> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let launch: SessionLease;
	const until = Date.now() + (options.waitForLaunch ?? 0);
	for (;;) {
		options.signal?.throwIfAborted();
		try { launch = new SessionLease(join(directory, "launch")); break; }
		catch (error) {
			if (!(error instanceof SessionOwnedError)) throw error;
			if (Date.now() >= until) throw new Error("Another start command is in progress. Check status before trying again.");
			await delay(100, undefined, { signal: options.signal }); // Only lease admission repeats; no process has been launched.
		}
	}
	try {
		const current = await probeHost(directory, launch);
		if (current.state === "running") {
			if (options.managed) throw new Error("A host is already running outside this login-start process. Stop it before starting the integration.");
			return { host: current.host!, reused: true };
		}
		if (current.state !== "stopped") throw new Error(`Host is ${current.state}. ${current.error ?? "Wait for it to finish stopping."}`);
		options.signal?.throwIfAborted();
		const log = join(directory, "host.log");
		if (existsSync(log) && statSync(log).size > 8 * 1024 * 1024) {
			rmSync(`${log}.1`, { force: true }); renameSync(log, `${log}.1`);
		}
		const fd = openSync(log, "a", 0o600);
		try {
			const child = spawn(process.execPath, [options.entry ?? fileURLToPath(new URL("./cli.js", import.meta.url)), "serve", ...arguments_, "--background"], {
				cwd, detached: !options.managed, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"], env: options.environment ?? process.env,
			});
			const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
			let handedOff = false;
			try {
				await new Promise<void>((resolve, reject) => {
					// A login supervisor owns the host process: giving up on a live, slow host would end both.
					const timer = options.managed ? undefined : setTimeout(() => finish(new Error(`Startup is still unconfirmed. Check status and ${log}; the host was not killed.`)), STARTUP_WAIT_MS);
					const cancel = () => finish(new Error("Startup was cancelled."));
					options.signal?.addEventListener("abort", cancel, { once: true });
					const finish = (error?: Error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
					child.once("error", error => finish(error));
					child.once("exit", code => finish(new Error(`Host exited during startup (${code}). See ${log}.`)));
					child.on("message", message => {
						if ((message as { type?: string }).type === "ready") finish();
					});
				});
				const ready = await probeHost(directory, launch);
				if (ready.state !== "running") throw new Error(`Host startup was not confirmed. See ${log}.`);
				handedOff = true;
				return { host: ready.host!, reused: false, ...(options.managed ? { exited } : {}) };
			} finally {
				if (child.connected) child.disconnect();
				if (!options.managed || !handedOff) child.unref();
			}
		} finally { closeSync(fd); }
	} finally { launch.close(); }
}

export async function stopHost(directory: string, options?: { idleOnly: boolean; runtime: string; checkpoint?: { id: string; target: string } }, launch?: SessionLease): Promise<{ stopped: boolean; unclean?: boolean; deferred?: number }> {
	const current = await probeHost(directory, launch);
	if (current.state === "stopped") {
		const record = readHostRecord(directory);
		if (record) {
			const lease = freeLease(directory);
			if (lease) { try { removeHostRecord(directory, record.instance); } finally { lease.close(); } }
		}
		return { stopped: false, unclean: current.stale };
	}
	if (current.state === "unresponsive") throw new Error(`Host is not responding. No PID was signalled. ${current.error}`);
	const record = readHostRecord(directory)!;
	if (record.instance !== current.host!.instance) throw new Error("The host changed. Check status before stopping it.");
	let result: { instance: string; deferred?: number };
	try {
		if (options?.checkpoint) {
			const { id, target } = options.checkpoint;
			const body = { runtime: options.runtime, checkpoint: id, target };
			let preparation = await controlRequest<{ instance: string; checkpoint: import("./checkpoints.ts").CheckpointStatus }>(record, "prepare-update", body);
			const until = Date.now() + 120_000;
			while (preparation.checkpoint.state === "preparing" && Date.now() < until)
				preparation = await controlRequest(record, `update-checkpoint?id=${encodeURIComponent(id)}`);
			if (preparation.checkpoint.state !== "ready" || preparation.checkpoint.id !== id || preparation.checkpoint.target !== target)
				throw new Error(preparation.checkpoint.error ?? "The host handoff is not ready. The host was not stopped.");
		}
		result = await controlRequest<{ instance: string; deferred?: number }>(record,
			options?.checkpoint ? "stop-for-update" : options?.idleOnly ? "stop-if-idle" : "stop",
			options ? { runtime: options.runtime, ...(options.checkpoint ? { checkpoint: options.checkpoint.id, target: options.checkpoint.target } : {}) } : {});
	} catch (error) {
		if (options?.checkpoint) await controlRequest(record, "cancel-update", { checkpoint: options.checkpoint.id }).catch(() => {});
		throw error;
	}
	if (result.deferred !== undefined) return { stopped: false, deferred: result.deferred };
	const until = Date.now() + SHUTDOWN_WAIT_MS;
	while (Date.now() < until) {
		if (readHostRecord(directory)?.instance !== record.instance) return { stopped: true };
		const lease = freeLease(directory);
		if (lease) {
			try { removeHostRecord(directory, record.instance); } finally { lease.close(); }
			return { stopped: true, unclean: true };
		}
		await delay(100);
	}
	throw new Error("Shutdown is still in progress. Check status and host.log. No process was force-killed.");
}

export async function openBrowser(url: string): Promise<void> {
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid app URL.");
	const command = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe") : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
	await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
	child.unref();
}

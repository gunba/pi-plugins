import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { readHostRecord, removeHostRecord, type HostRecord, type HostStatus } from "./host-control.ts";

export interface HostProbe { state: "running" | "stopping" | "stopped" | "unresponsive"; host?: HostStatus; stale?: boolean; error?: string }

export async function controlRequest<T extends { instance: string }>(record: HostRecord, operation: string, body?: object): Promise<T> {
	const response = await fetch(`${record.origin}/api/host/${operation}`, {
		method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(2500),
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

export async function probeHost(directory: string): Promise<HostProbe> {
	if (!existsSync(directory)) return { state: "stopped" };
	const record = readHostRecord(directory);
	if (record) {
		try {
			const host = await controlRequest<HostStatus>(record, "status");
			return { state: host.stopping ? "stopping" : "running", host };
		} catch (error) {
			const lease = freeLease(directory);
			if (lease) { lease.close(); return { state: "stopped", stale: true }; }
			return { state: "unresponsive", error: error instanceof Error ? error.message : String(error) };
		}
	}
	const lease = freeLease(directory);
	if (lease) { lease.close(); return { state: "stopped" }; }
	return { state: "unresponsive", error: "The host lock is occupied or unavailable, but no runtime record exists. It may be starting or running an older release." };
}

export interface StartedHost {
	host: HostStatus; reused: boolean; exited?: Promise<number | null>;
}
export async function startHost(directory: string, cwd: string, arguments_: string[],
	options: { managed?: boolean; environment?: NodeJS.ProcessEnv } = {}): Promise<StartedHost> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let launch: SessionLease;
	try { launch = new SessionLease(join(directory, "launch")); }
	catch { throw new Error("Another start command is in progress. Check status before trying again."); }
	try {
		const current = await probeHost(directory);
		if (current.state === "running") {
			if (options.managed) throw new Error("A host is already running outside this login-start process. Stop it before starting the integration.");
			return { host: current.host!, reused: true };
		}
		if (current.state !== "stopped") throw new Error(`Host is ${current.state}. ${current.error ?? "Wait for it to finish stopping."}`);
		const log = join(directory, "host.log");
		if (existsSync(log) && statSync(log).size > 8 * 1024 * 1024) {
			rmSync(`${log}.1`, { force: true }); renameSync(log, `${log}.1`);
		}
		const fd = openSync(log, "a", 0o600);
		try {
			const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve", ...arguments_, "--background"], {
				cwd, detached: !options.managed, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"], env: options.environment ?? process.env,
			});
			const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
			let handedOff = false;
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`Startup is still unconfirmed. Check status and ${log}; the host was not killed.`)), 30_000);
					const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
					child.once("error", error => finish(error));
					child.once("exit", code => finish(new Error(`Host exited during startup (${code}). See ${log}.`)));
					child.on("message", message => {
						if ((message as { type?: string }).type === "ready") finish();
					});
				});
				const ready = await probeHost(directory);
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

export async function stopHost(directory: string, options?: { idleOnly: true; runtime: string }): Promise<{ stopped: boolean; unclean?: boolean; deferred?: number }> {
	const current = await probeHost(directory);
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
	const result = await controlRequest<{ instance: string; deferred?: number }>(record,
		options ? "stop-if-idle" : "stop", options ? { runtime: options.runtime } : {});
	if (result.deferred !== undefined) return { stopped: false, deferred: result.deferred };
	const until = Date.now() + 30_000;
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

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease, SessionOwnedError } from "../../../pi-session-ownership/lease.ts";
import type { WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import { WorkerChannel, type WorkerEndpointAddress } from "./worker-channel.ts";
import { WorkerConnectionError } from "./worker-errors.ts";

export interface WorkerBootstrap {
	version: 1;
	instance: string;
	secret: string;
	options: WorkerInit;
	pid?: number;
	failed?: boolean;
}
export interface WorkerRecord extends WorkerEndpointAddress {
	version: 1;
	pid: number;
	runtimeDirectory?: string;
}
export interface WorkerAttachment { channel: WorkerChannel; bootstrap: WorkerBootstrap; record: WorkerRecord; created: boolean }

export function workerDirectory(directory: string, key: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("Invalid worker key.");
	return join(directory, "workers", key);
}
export function writeWorkerFile(directory: string, name: "bootstrap.json" | "worker.json", value: WorkerBootstrap | WorkerRecord): void {
	const file = join(directory, name), temporary = `${file}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(temporary, file);
}
function read<T>(directory: string, name: string): T | undefined {
	const file = join(directory, name);
	if (!existsSync(file)) return;
	return JSON.parse(readFileSync(file, "utf8")) as T;
}
function identity(value: { version: number; instance: string; secret: string }): void {
	if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.instance) || !/^[a-f0-9]{64}$/.test(value.secret)) throw new Error("Invalid worker registry identity.");
}
export function readWorkerBootstrap(directory: string): WorkerBootstrap | undefined {
	const value = read<WorkerBootstrap>(directory, "bootstrap.json");
	if (!value) return;
	identity(value);
	if (!value.options || typeof value.options.cwd !== "string" || value.pid !== undefined && (!Number.isSafeInteger(value.pid) || value.pid <= 0)) throw new Error("Invalid worker bootstrap.");
	return value;
}
export function readWorkerRecord(directory: string): WorkerRecord | undefined {
	const value = read<WorkerRecord>(directory, "worker.json");
	if (!value) return;
	identity(value);
	if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) throw new Error("Invalid worker endpoint record.");
	return value;
}
export function removeWorkerRecord(directory: string, instance: string): void {
	if (readWorkerRecord(directory)?.instance === instance) unlinkSync(join(directory, "worker.json"));
}
export function workerLease(directory: string): SessionLease { return new SessionLease(join(directory, "actor")); }
function vacant(directory: string): boolean {
	try { const lease = workerLease(directory); lease.close(); return true; }
	catch (error) { if (error instanceof SessionOwnedError) return false; throw error; }
}
export function workerOccupied(directory: string): boolean { return !vacant(directory); }
function pidAbsent(pid: number): boolean {
	try { process.kill(pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** One launch or authenticated adoption under an OS-backed launch lease. */
export async function attachWorker(directory: string, options: WorkerInit, receive: (message: WorkerMessage) => void,
	disconnected: () => void, settings: { module?: string; runtimeDirectory?: string; timeout?: number; adoptOnly?: boolean; expectedInstance?: string } = {}): Promise<WorkerAttachment> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let launch: SessionLease;
	try { launch = new SessionLease(join(directory, "launch")); }
	catch (error) { if (error instanceof SessionOwnedError) throw new WorkerConnectionError("A worker launch is already in progress; no second worker was started."); throw error; }
	try {
		const previous = readWorkerRecord(directory);
		if (previous) {
			if (settings.expectedInstance && previous.instance !== settings.expectedInstance) throw new WorkerConnectionError("The worker instance changed; it was not adopted.");
			const bootstrap = readWorkerBootstrap(directory);
			if (!bootstrap || bootstrap.instance !== previous.instance || bootstrap.secret !== previous.secret) throw new Error("Worker registry records disagree.");
			try {
				const channel = await WorkerChannel.connect(previous, receive, disconnected);
				return { channel, bootstrap, record: previous, created: false };
			} catch (error) {
				if (settings.adoptOnly) throw new WorkerConnectionError("The existing worker could not be adopted; no replacement was started.");
				if (!vacant(directory)) throw new WorkerConnectionError("The existing worker could not be attached. Its lease is still held; it was not replaced.");
				if (!pidAbsent(previous.pid)) throw new WorkerConnectionError("The previous worker process is still present; no replacement was started.");
				removeWorkerRecord(directory, previous.instance);
			}
		}
		if (settings.adoptOnly) throw new WorkerConnectionError("No existing worker endpoint was found; no worker was started.");
		const pending = readWorkerBootstrap(directory);
		if (!vacant(directory) || pending && !pending.failed && (!pending.pid || !pidAbsent(pending.pid)))
			throw new WorkerConnectionError("The previous worker launch is still unconfirmed; it was not repeated.");
		const bootstrap: WorkerBootstrap = { version: 1, instance: randomUUID(), secret: randomBytes(32).toString("hex"),
			options: { ...options, runtimeDirectory: settings.runtimeDirectory } };
		writeWorkerFile(directory, "bootstrap.json", bootstrap);
		const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PI_DESK_")));
		const child = spawn(process.execPath, ["--report-on-fatalerror", "--report-uncaught-exception",
			"--report-exclude-env", "--report-exclude-network", `--report-filename=${join(directory, "failure.json")}`,
			settings.module ?? fileURLToPath(new URL("./worker.js", import.meta.url)), directory], {
			cwd: options.cwd, detached: true, windowsHide: true, stdio: "ignore",
			env: { ...environment, ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}) },
		});
		let spawnError: Error | undefined;
		child.once("error", error => {
			spawnError = error;
			if (!child.pid) { bootstrap.failed = true; writeWorkerFile(directory, "bootstrap.json", bootstrap); }
		});
		child.unref();
		if (child.pid) { bootstrap.pid = child.pid; writeWorkerFile(directory, "bootstrap.json", bootstrap); }
		const until = Date.now() + (settings.timeout ?? 30_000);
		while (Date.now() < until) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null) throw new WorkerConnectionError(`Worker stopped during launch (${child.exitCode}); no retry was made.`);
			const record = readWorkerRecord(directory);
			if (record) {
				if (record.instance !== bootstrap.instance || record.secret !== bootstrap.secret) throw new Error("Worker launch identity changed.");
				const channel = await WorkerChannel.connect(record, receive, disconnected);
				return { channel, bootstrap, record, created: true };
			}
			await delay(25);
		}
		throw new WorkerConnectionError("Worker startup is unconfirmed. Inspect its registry before retrying; the process was not killed.");
	} finally { launch.close(); }
}

export async function waitWorkerStopped(directory: string, instance: string, timeout = 30_000): Promise<void> {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const record = readWorkerRecord(directory);
		if ((!record || record.instance !== instance) && vacant(directory)) return;
		await delay(25);
	}
	throw new WorkerConnectionError("Worker shutdown is still unconfirmed. No process was force-killed.");
}

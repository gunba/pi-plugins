import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SessionSnapshot, WorkerCommand, WorkerInit, WorkerMessage, WorkerRequest } from "../shared/protocol.ts";
import type { ControlCommand, ControlStatus } from "../shared/controls.ts";
import { ReceiptConflict, StaleGeneration, WorkerCommandError, WorkerConnectionError } from "./worker-errors.ts";

export class SessionWorker {
	private child: ChildProcess;
	private pending = new Map<string, { fingerprint: string; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private stopped = false;
	private stopping = false;
	private shutdownConfirmed = false;
	private closeJob?: Promise<void>;
	private resolveExit!: () => void;
	private exited = new Promise<void>(resolve => { this.resolveExit = resolve; });
	private controls = new Map<string, { fingerprint: string; status: ControlStatus }>();
	generation = "";
	snapshot?: SessionSnapshot;
	private readonly event: (message: WorkerMessage) => void;
	private readonly runtimeDirectory: string | undefined;

	constructor(options: WorkerInit, event: (message: WorkerMessage) => void) {
		this.event = event;
		this.runtimeDirectory = process.env.PI_DESK_RUNTIME || undefined;
		const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PI_DESK_")));
		this.child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url))], {
			cwd: options.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
			env: { ...environment, ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}) },
		});
		this.child.stdout?.on("data", () => {}); // Extensions may write to stdout; it is not our protocol.
		this.child.stderr?.on("data", chunk => process.stderr.write(chunk));
		this.child.on("message", (message: WorkerMessage) => {
			if (message.type === "result") {
				const pending = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error) pending?.reject(message.code === "stale_generation" ? new StaleGeneration()
					: message.code === "receipt_conflict" ? new ReceiptConflict(message.error) : new WorkerCommandError(message.error));
				else pending?.resolve(message.value);
			} else {
				if (message.type === "snapshot") this.snapshot = message.snapshot;
				if (message.type === "ui") this.generation = message.snapshot.generation;
				if (message.type === "snapshot") this.generation = message.snapshot.ui.generation;
				this.event(message);
			}
		});
		this.child.once("error", error => { if (!this.child.pid) this.resolveExit(); this.fail(error); });
		this.child.once("exit", (code, signal) => { this.resolveExit(); this.fail(new Error(`Session worker stopped (${signal ?? code}).`)); });
	}

	private fail(error: Error): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const pending of this.pending.values()) pending.reject(new WorkerConnectionError(`${error.message} The outcome was not confirmed; check saved history before repeating the operation.`));
		this.pending.clear();
		if (!this.shutdownConfirmed) this.event({ type: "fatal", error: error.message });
	}

	private request(request: WorkerRequest): Promise<unknown> {
		if (this.stopped || this.stopping && request.type !== "shutdown") {
			return Promise.reject(new WorkerConnectionError("Session worker is stopped or closing. Check its state before trying again."));
		}
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const existing = this.pending.get(request.id);
		if (existing) return existing.fingerprint === fingerprint ? existing.promise
			: Promise.reject(new ReceiptConflict("This command ID is already in use for different contents."));
		let resolve!: (value: unknown) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
		this.pending.set(request.id, { fingerprint, promise, resolve, reject });
		const failed = (error: Error | null) => {
			if (!error) return;
			this.pending.delete(request.id);
			reject(new WorkerConnectionError(`${error.message} Delivery was not confirmed.`));
		};
		try { this.child.send(request, failed); }
		catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
		return promise;
	}

	submitControl(command: ControlCommand | { kind: "close" }, generation: string, id: string): { accepted: true; control: ControlStatus } {
		const fingerprint = createHash("sha256").update(JSON.stringify({ command, ...(command.kind === "close" ? {} : { generation }) })).digest("hex");
		const previous = this.controls.get(id);
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new ReceiptConflict("This control receipt has different contents.");
			return { accepted: true, control: previous.status };
		}
		if (this.stopped || this.stopping) throw new WorkerConnectionError("Session worker is stopped or closing.");
		if (command.kind !== "close" && generation !== this.generation) throw new StaleGeneration();
		const pending = [...this.controls.values()].filter(item => item.status.state === "running");
		if (command.kind !== "close" && pending.some(item => command.kind !== "abort" || item.status.kind === "abort" || item.status.kind === "close")) {
			throw new Error("A control is already running. Stop it or wait for its outcome before starting another.");
		}
		const receipt = { fingerprint, status: {
			id, kind: command.kind, generation, state: "running", started: Date.now(),
		} as ControlStatus };
		this.controls.set(id, receipt);
		this.event({ type: "control", control: { ...receipt.status } });
		const operation = command.kind === "close" ? this.close(false) : this.command(command, generation, id);
		void operation.then(() => {
			receipt.status = { ...receipt.status, state: "completed", ended: Date.now() };
		}, error => {
			receipt.status = { ...receipt.status, state: error instanceof WorkerConnectionError ? "interrupted" : "failed",
				ended: Date.now(), error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
		}).then(() => {
			this.event({ type: "control", control: { ...receipt.status } });
			for (const [key, item] of this.controls) {
				if (this.controls.size <= 128) break;
				if (item.status.state !== "running") this.controls.delete(key);
			}
		});
		return { accepted: true, control: { ...receipt.status } };
	}

	async start(options: WorkerInit): Promise<SessionSnapshot> {
		const snapshot = await this.request({ type: "init", id: randomUUID(), options: { ...options, runtimeDirectory: this.runtimeDirectory } }) as SessionSnapshot;
		this.snapshot = snapshot;
		this.generation = snapshot.ui.generation;
		return snapshot;
	}

	command(command: WorkerCommand, generation = this.generation, id: string = randomUUID()): Promise<unknown> {
		return this.request({ type: "command", id, generation, command });
	}

	close(force = true): Promise<void> {
		if (this.closeJob) return force ? this.closeJob.catch(() => this.close(true)) : this.closeJob;
		const job = this.finishClose(force);
		this.closeJob = job;
		void job.catch(() => { if (this.closeJob === job) this.closeJob = undefined; });
		return job;
	}

	private async finishClose(force: boolean): Promise<void> {
		this.stopping = true;
		this.shutdownConfirmed = false;
		try {
			if (!this.stopped) { await this.request({ type: "shutdown", id: randomUUID() }); this.shutdownConfirmed = true; }
		}
		catch (error) {
			if (!force) { this.stopping = false; throw error; }
		}
		if (this.child.connected) this.child.disconnect();
		await this.exited;
	}
}

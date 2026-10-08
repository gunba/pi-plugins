import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot, WorkerCommand, WorkerInit, WorkerMessage, WorkerRequest, WorkerState, WorkerReceipt, WorkerRuntimeInfo } from "../shared/protocol.ts";
import type { ControlCommand, ControlStatus } from "../shared/controls.ts";
import type { CheckpointAction, CheckpointSnapshot } from "../shared/checkpoint.ts";
import { ReceiptConflict, StaleGeneration, WorkerCommandError, WorkerConnectionError } from "./worker-errors.ts";
import { attachWorker, waitWorkerStopped, workerDirectory, type WorkerAttachment } from "./worker-registry.ts";

interface WorkerLocation { directory: string; key: string; module?: string; adopt?: string }
interface WorkerConnections { attach: typeof attachWorker; waitStopped: typeof waitWorkerStopped }

export class SessionWorker {
	private pending = new Map<string, { fingerprint: string; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private stopped = false;
	private stopping = false;
	private intentionalDetach = false;
	private shutdownConfirmed = false;
	private closeJob?: Promise<void>;
	private startJob?: Promise<SessionSnapshot>;
	private connection: Promise<WorkerAttachment>;
	private directory: string;
	private ephemeral?: string;
	private waitStopped: typeof waitWorkerStopped;
	generation = "";
	initialGeneration?: string;
	runtimeDirectory?: string;
	runtime?: WorkerRuntimeInfo;
	instance?: string;
	snapshot?: SessionSnapshot;
	closedCheckpoint?: CheckpointSnapshot & { checkpoint: string };
	private readonly event: (message: WorkerMessage) => void;

	constructor(options: WorkerInit, event: (message: WorkerMessage) => void, location?: WorkerLocation,
		connections: WorkerConnections = { attach: attachWorker, waitStopped: waitWorkerStopped }) {
		this.event = event;
		this.waitStopped = connections.waitStopped;
		if (!location) {
			this.ephemeral = mkdtempSync(join(tmpdir(), "pi-desk-worker-"));
			location = { directory: this.ephemeral, key: "inspect" };
		}
		this.directory = workerDirectory(location.directory, location.key);
		this.connection = connections.attach(this.directory, options, message => this.receive(message), error => {
			this.fail(error ?? new WorkerConnectionError("The host connection to the worker closed. Native work may still be running."), true);
		}, { module: location.module, runtimeDirectory: process.env.PI_DESK_RUNTIME || undefined,
			adoptOnly: !!location.adopt, expectedInstance: location.adopt }).then(connection => {
			this.instance = connection.record.instance;
			this.runtimeDirectory = connection.record.runtimeDirectory;
			return connection;
		});
		void this.connection.catch(error => this.fail(error instanceof Error ? error : new Error(String(error)), !!location?.adopt));
	}

	private receive(message: WorkerMessage): void {
		if (message.type === "result") {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending?.reject(message.code === "stale_generation" ? new StaleGeneration()
				: message.code === "receipt_conflict" ? new ReceiptConflict(message.error) : new WorkerCommandError(message.error));
			else pending?.resolve(message.value);
		} else {
			if (message.type === "snapshot") { this.snapshot = message.snapshot; this.generation = message.snapshot.ui.generation; }
			if (message.type === "ui") this.generation = message.snapshot.generation;
			if (message.type === "control" && message.control.kind === "close" && message.control.state === "completed") this.shutdownConfirmed = true;
			this.event(message);
		}
	}

	private fail(error: Error, detached = false): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const pending of this.pending.values()) pending.reject(new WorkerConnectionError(`${error.message} The outcome was not confirmed; check saved history before repeating the operation.`));
		this.pending.clear();
		if (!this.shutdownConfirmed && !this.intentionalDetach) this.event({ type: detached ? "detached" : "fatal", error: error.message });
	}

	private request(request: WorkerRequest): Promise<unknown> {
		if (this.stopped || this.stopping && request.type !== "shutdown")
			return Promise.reject(new WorkerConnectionError("The worker connection is stopped or closing. Check its state before trying again."));
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const existing = this.pending.get(request.id);
		if (existing) return existing.fingerprint === fingerprint ? existing.promise
			: Promise.reject(new ReceiptConflict("This command ID is already in use for different contents."));
		let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
		const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
		this.pending.set(request.id, { fingerprint, promise, resolve, reject });
		void this.connection.then(connection => connection.channel.send(request)).catch(error => {
			this.pending.delete(request.id);
			reject(new WorkerConnectionError(`${error instanceof Error ? error.message : String(error)} Delivery was not confirmed.`));
		});
		return promise;
	}

	checkpoint(id: string, action: CheckpointAction): Promise<CheckpointSnapshot | undefined> {
		return this.request({ type: "checkpoint", id: `${id}:${action}`, checkpoint: id, action }) as Promise<CheckpointSnapshot | undefined>;
	}
	submitControl(command: ControlCommand | { kind: "close" }, generation: string, id: string): Promise<{ accepted: true; control: ControlStatus }> {
		return this.request({ type: "control", id, generation: command.kind === "close" ? "" : generation, command }) as Promise<{ accepted: true; control: ControlStatus }>;
	}

	async handoffIdentity(): Promise<{ instance: string }> {
		await this.describe();
		return { instance: (await this.connection).record.instance };
	}
	start(): Promise<SessionSnapshot> { return this.startJob ??= this.initialize(); }
	private async initialize(): Promise<SessionSnapshot> {
		const connection = await this.connection;
		if (!connection.created) {
			const state = await this.describe();
			if (state.snapshot && state.initialGeneration) return state.snapshot;
		}
		await this.request({ type: "init", id: `init:${connection.record.instance}`, options: connection.bootstrap.options });
		const state = await this.describe();
		if (!state.snapshot) throw new Error("The worker did not confirm its native session.");
		return state.snapshot;
	}
	receipt(id: string, wait = false): Promise<WorkerReceipt> {
		return this.request({ type: "receipt", id: randomUUID(), target: id, wait }) as Promise<WorkerReceipt>;
	}
	async describe(): Promise<WorkerState> {
		const state = await this.request({ type: "describe", id: randomUUID() }) as WorkerState;
		this.initialGeneration = state.initialGeneration;
		this.runtime = state.runtime;
		if (state.snapshot) this.receive({ type: "snapshot", snapshot: state.snapshot });
		for (const control of state.controls) this.receive({ type: "control", control });
		if (state.historyReady) this.receive({ type: "history_ready", generation: state.historyReady });
		return state;
	}
	command(command: WorkerCommand, generation = this.generation, id: string = randomUUID()): Promise<unknown> {
		return this.request({ type: "command", id, generation, command });
	}

	async detach(): Promise<void> {
		this.intentionalDetach = true;
		const connection = await this.connection;
		await connection.channel.detach();
		this.fail(new WorkerConnectionError("The host detached; native work remains with the worker."), true);
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
		const connection = await this.connection;
		try {
			this.closedCheckpoint = await this.request({ type: "shutdown", id: randomUUID(), force }) as typeof this.closedCheckpoint;
			this.shutdownConfirmed = true;
		} catch (error) { if (!force) { this.stopping = false; throw error; } }
		await this.waitStopped(this.directory, connection.record.instance);
		await connection.channel.detach();
		if (this.ephemeral) rmSync(this.ephemeral, { recursive: true, force: true });
	}
}

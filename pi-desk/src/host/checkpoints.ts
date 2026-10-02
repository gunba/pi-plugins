import { setTimeout as delay } from "node:timers/promises";
import type { CheckpointSnapshot, UpdateCheckpoint } from "../shared/checkpoint.ts";
import type { InputLedger } from "./inputs.ts";
import type { SessionWorker } from "./worker-client.ts";

export interface CheckpointActor {
	key: string;
	worker: SessionWorker;
	ready: boolean;
	controlBusy: boolean;
	draining?: Promise<void>;
}
export interface CheckpointStatus {
	id: string;
	target: string;
	state: "preparing" | "ready" | "failed";
	error?: string;
}

/** Holds admission before inspecting any worker; a failed batch releases every hold. */
export class UpdateCheckpoints {
	private inputs: InputLedger;
	private actors: () => CheckpointActor[];
	private changed: () => void;
	private current?: CheckpointStatus;
	private timer?: ReturnType<typeof setTimeout>;
	private captured: CheckpointActor[] = [];
	private cancelled = false;
	private disposed = false;
	private rollback?: Promise<void>;
	private job?: Promise<void>;

	constructor(inputs: InputLedger, actors: () => CheckpointActor[], changed: () => void) {
		this.inputs = inputs; this.actors = actors; this.changed = changed;
	}
	get held(): boolean { return !!this.current && this.current.state !== "failed"; }
	status(touch = false): CheckpointStatus | undefined {
		if (touch && this.held) this.renew();
		return this.current ? { ...this.current } : undefined;
	}
	async wait(id: string): Promise<CheckpointStatus> {
		if (this.current?.id !== id) throw new Error("The update checkpoint changed.");
		this.status(true);
		await Promise.race([this.job, delay(1750, undefined, { ref: false })]);
		return this.status(true)!;
	}
	private renew(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.fail("The update controller disconnected; previous work was released."); }, 90_000);
		this.timer.unref();
	}
	prepare(id: string, source: string, target: string): CheckpointStatus {
		if (this.disposed) throw new Error("The host is stopping.");
		if (this.current?.id === id && this.current.state === "failed") throw new Error(this.current.error);
		if (this.held) {
			if (this.current?.id !== id || this.current.target !== target) throw new Error("Another update holds this computer.");
			this.renew(); return this.status()!;
		}
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(source) || !/^[a-f0-9]{64}$/.test(target) || source === target)
			throw new Error("Invalid update checkpoint.");
		this.current = { id, target, state: "preparing" };
		this.cancelled = false; this.rollback = undefined;
		this.captured = this.actors(); this.renew(); this.changed();
		this.job = this.capture(id, source, target).catch(error => this.fail(error instanceof Error ? error.message : String(error)));
		return this.status()!;
	}
	private async capture(id: string, source: string, target: string): Promise<void> {
		await Promise.all(this.captured.map(actor => actor.draining));
		this.inputs.assertCheckpointInputs();
		if (this.captured.some(actor => !actor.ready || actor.controlBusy))
			throw new Error("Finish opening conversations and pending controls before updating.");
		const inspect = (actor: CheckpointActor) => actor.worker.checkpoint(id, "inspect");
		await Promise.all(this.captured.map(inspect));
		if (this.cancelled || this.disposed) return;
		const snapshots = await Promise.all(this.captured.map(actor => actor.worker.checkpoint(id, "hold")));
		if (this.cancelled || this.disposed) return;
		const sessions = snapshots.map((snapshot, index) => {
			if (!snapshot) throw new Error("A worker did not confirm its checkpoint.");
			return { ...snapshot, key: this.captured[index].key };
		});
		const ticket: UpdateCheckpoint = { id, source, target, state: "held", created: Date.now(), sessions };
		this.inputs.writeCheckpoint(ticket);
		this.current!.state = "ready"; this.changed();
	}
	async commit(id: string, target: string): Promise<void> {
		if (this.current?.id !== id || this.current.target !== target || this.current.state !== "ready" || this.cancelled)
			throw new Error("The update checkpoint is not ready or changed.");
		try { await this.finishCommit(id, target); }
		catch (error) {
			await this.fail(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
	private async finishCommit(id: string, target: string): Promise<void> {
		const snapshots = await Promise.all(this.captured.map(actor => actor.worker.checkpoint(id, "inspect")));
		const ticket = this.inputs.checkpoint();
		if (!ticket || ticket.id !== id || ticket.target !== target || ticket.state !== "held")
			throw new Error("The saved update checkpoint changed.");
		for (let index = 0; index < snapshots.length; index++) {
			const snapshot = snapshots[index] as CheckpointSnapshot | undefined;
			if (!snapshot || snapshot.session !== ticket.sessions[index]?.session || snapshot.file !== ticket.sessions[index]?.file)
				throw new Error("A native conversation changed during the update checkpoint.");
			ticket.sessions[index] = { ...ticket.sessions[index], ...snapshot };
		}
		if (this.cancelled || this.disposed) throw new Error("The update checkpoint expired.");
		ticket.state = "committed"; this.inputs.writeCheckpoint(ticket); clearTimeout(this.timer);
	}
	cancel(id: string): void {
		if (this.current?.id !== id) throw new Error("The update checkpoint changed.");
		void this.fail("The update was cancelled; previous work was released.");
	}
	private fail(error: string): Promise<void> {
		if (this.disposed || !this.current) return Promise.resolve();
		if (this.rollback) return this.rollback;
		this.cancelled = true; clearTimeout(this.timer);
		const id = this.current.id;
		this.rollback = Promise.allSettled(this.captured.map(actor => actor.worker.checkpoint(id, "release"))).then(results => {
			if (this.disposed) return;
			if (results.some(result => result.status === "rejected")) error += " Some worker releases were not confirmed; check their state before retrying.";
			try {
				const ticket = this.inputs.checkpoint();
				if (ticket?.id === id && ticket.state === "held") { ticket.state = "cancelled"; this.inputs.writeCheckpoint(ticket); }
			} catch { error += " Checkpoint storage could not confirm cancellation."; }
			this.current = { ...this.current!, state: "failed", error: error.slice(0, 2000) }; this.changed();
		});
		return this.rollback;
	}
	/** Stop releases no models; the normal worker shutdown path owns disposal. */
	dispose(): void { this.disposed = true; clearTimeout(this.timer); }
	async settled(): Promise<void> { await this.job; await this.rollback; }
}

import { setTimeout as delay } from "node:timers/promises";
import type { UpdateCheckpoint } from "../shared/checkpoint.ts";
import type { InputLedger } from "./inputs.ts";
import type { SessionWorker } from "./worker-client.ts";

export interface CheckpointActor { key: string; worker: SessionWorker }
export interface CheckpointStatus {
	id: string; target: string; state: "preparing" | "ready" | "failed"; error?: string;
}

/** A brief host-admission hold. Native execution, controls and queues remain owned by their actors. */
export class UpdateCheckpoints {
	private inputs: InputLedger;
	private actors: () => CheckpointActor[];
	private changed: () => void;
	private current?: CheckpointStatus;
	private timer?: ReturnType<typeof setTimeout>;
	private captured: CheckpointActor[] = [];
	private cancelled = false;
	private disposed = false;
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
		if (this.current?.id !== id) throw new Error("The update handoff changed.");
		this.status(true);
		await Promise.race([this.job, delay(1750, undefined, { ref: false })]);
		return this.status(true)!;
	}
	private renew(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.fail("The update controller disconnected; host admission was released."); }, 90_000);
		this.timer.unref();
	}
	prepare(id: string, source: string, target: string): CheckpointStatus {
		if (this.disposed) throw new Error("The host is stopping.");
		if (this.current?.id === id && this.current.state === "failed") throw new Error(this.current.error);
		if (this.held) {
			if (this.current?.id !== id || this.current.target !== target) throw new Error("Another update holds host admission.");
			this.renew(); return this.status()!;
		}
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(source) || !/^[a-f0-9]{64}$/.test(target) || source === target)
			throw new Error("Invalid update handoff.");
		this.current = { id, target, state: "preparing" }; this.cancelled = false;
		this.captured = this.actors(); this.renew(); this.changed();
		this.job = this.capture(id, source, target).catch(error => this.fail(error instanceof Error ? error.message : String(error)));
		return this.status()!;
	}
	private async capture(id: string, source: string, target: string): Promise<void> {
		const workers = await Promise.all(this.captured.map(async actor => ({ key: actor.key, ...await actor.worker.handoffIdentity() })));
		if (this.cancelled || this.disposed) return;
		const ticket: UpdateCheckpoint = { id, source, target, state: "held", created: Date.now(), workers, sessions: [] };
		this.inputs.writeCheckpoint(ticket);
		this.current!.state = "ready"; this.changed();
	}
	async commit(id: string, target: string): Promise<void> {
		if (this.current?.id !== id || this.current.target !== target || this.current.state !== "ready" || this.cancelled)
			throw new Error("The update handoff is not ready or changed.");
		try {
			const ticket = this.inputs.checkpoint();
			if (!ticket || ticket.id !== id || ticket.target !== target || ticket.state !== "held" || !ticket.workers)
				throw new Error("The saved update handoff changed.");
			const identities = await Promise.all(this.captured.map(actor => actor.worker.handoffIdentity()));
			if (this.cancelled || this.disposed) throw new Error("The update handoff expired.");
			if (identities.some((identity, index) => identity.instance !== ticket.workers![index]?.instance))
				throw new Error("An actor changed during the update handoff.");
			ticket.state = "committed"; this.inputs.writeCheckpoint(ticket); clearTimeout(this.timer);
		} catch (error) {
			await this.fail(error instanceof Error ? error.message : String(error)); throw error;
		}
	}
	cancel(id: string): void {
		if (this.current?.id !== id) throw new Error("The update handoff changed.");
		void this.fail("The update was cancelled; host admission was released.");
	}
	private async fail(error: string): Promise<void> {
		if (this.disposed || !this.current || this.cancelled) return;
		this.cancelled = true; clearTimeout(this.timer);
		try {
			const ticket = this.inputs.checkpoint();
			if (ticket?.id === this.current.id && ticket.state === "held") { ticket.state = "cancelled"; this.inputs.writeCheckpoint(ticket); }
		} catch { error += " Handoff storage could not confirm cancellation."; }
		this.current = { ...this.current, state: "failed", error: error.slice(0, 2000) }; this.changed();
	}
	dispose(): void { this.disposed = true; clearTimeout(this.timer); }
	async settled(): Promise<void> { await this.job; }
}

import { createHash } from "node:crypto";
import type { ControlCommand, ControlStatus } from "../shared/controls.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "./worker-errors.ts";

type Command = ControlCommand | { kind: "close" };

/** Admission and outcomes remain in the actor when its host detaches. */
export class WorkerControls {
	private controls = new Map<string, { fingerprint: string; status: ControlStatus }>();
	private retired = new Set<string>();
	private generation: () => string;
	private execute: (command: Command, id: string, generation: string) => Promise<unknown>;
	private changed: (status: ControlStatus) => void;
	private closing = false;

	constructor(generation: () => string, execute: (command: Command, id: string, generation: string) => Promise<unknown>, changed: (status: ControlStatus) => void) {
		this.generation = generation; this.execute = execute; this.changed = changed;
	}
	snapshot(): ControlStatus[] { return [...this.controls.values()].map(item => ({ ...item.status })); }

	submit(command: Command, generation: string, id: string): { accepted: true; control: ControlStatus } {
		const fingerprint = createHash("sha256").update(JSON.stringify({ command, ...(command.kind === "close" ? {} : { generation }) })).digest("hex");
		const previous = this.controls.get(id);
		if (this.retired.has(id) || previous && previous.fingerprint !== fingerprint) throw new ReceiptConflict("This control receipt expired or its contents changed.");
		if (previous) return { accepted: true, control: { ...previous.status } };
		if (this.closing) throw new WorkerConnectionError("The worker is closing.");
		if (command.kind !== "close" && generation !== this.generation()) throw new StaleGeneration();
		const pending = [...this.controls.values()].filter(item => item.status.state === "running");
		if (command.kind !== "close" && pending.some(item => command.kind !== "abort" || item.status.kind === "abort" || item.status.kind === "close"))
			throw new Error("A control is already running. Stop it or wait for its outcome before starting another.");
		if (command.kind === "close") this.closing = true;
		const receipt = { fingerprint, status: { id, kind: command.kind, generation, state: "running", started: Date.now(), ...(command.kind === "native" ? { command: command.name } : {}) } as ControlStatus };
		this.controls.set(id, receipt);
		this.changed({ ...receipt.status });
		void Promise.resolve().then(() => this.execute(command, id, generation)).then(result => {
			const output = command.kind === "native" && command.name === "export" && result && typeof result === "object"
				&& "path" in result && typeof result.path === "string" ? { path: result.path } : undefined;
			receipt.status = { ...receipt.status, state: "completed", ended: Date.now(), ...(output ? { output } : {}) };
		}, error => {
			if (command.kind === "close") this.closing = false;
			receipt.status = { ...receipt.status, state: error instanceof WorkerConnectionError ? "interrupted" : "failed", ended: Date.now(),
				error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
		}).then(() => {
			this.changed({ ...receipt.status });
			for (const [key, item] of this.controls) {
				if (this.controls.size <= 128) break;
				if (item.status.state !== "running") { this.controls.delete(key); this.retired.add(key); }
			}
		});
		return { accepted: true, control: { ...receipt.status } };
	}
}

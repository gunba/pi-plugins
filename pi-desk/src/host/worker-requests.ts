import { createHash } from "node:crypto";
import type { WorkerMessage, WorkerReceipt, WorkerRequest } from "../shared/protocol.ts";
import { ReceiptConflict, StaleGeneration } from "./worker-errors.ts";

type Result = Extract<WorkerMessage, { type: "result" }>;

/** Receipts belong to the worker, independently of its current host connection. */
export class WorkerRequests {
	private admitted = new Map<string, { operation: Promise<Result>; fingerprint: string; result?: Result }>();
	private completed: string[] = [];
	private retired = new Set<string>();

	private execute: (request: WorkerRequest) => Promise<unknown>;
	constructor(execute: (request: WorkerRequest) => Promise<unknown>) { this.execute = execute; }

	async receipt(id: string, wait = false): Promise<WorkerReceipt> {
		const item = this.admitted.get(id);
		if (!item) return { state: this.retired.has(id) ? "retired" : "missing" };
		if (item.result) return { state: "finished", result: item.result };
		return wait ? { state: "finished", result: await item.operation } : { state: "running" };
	}

	run(request: WorkerRequest): Promise<Result> {
		if (request.type === "receipt") return this.receipt(request.target, request.wait).then(value => ({ type: "result", id: request.id, value }));
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const previous = this.admitted.get(request.id);
		if (this.retired.has(request.id) || previous && previous.fingerprint !== fingerprint) {
			return Promise.resolve({ type: "result", id: request.id, code: "receipt_conflict",
				error: "This command receipt expired or its contents changed. Check the session before trying again." });
		}
		if (previous) return previous.operation;
		const operation = Promise.resolve().then(() => this.execute(request)).then(
			value => ({ type: "result" as const, id: request.id, value }),
			error => ({ type: "result" as const, id: request.id, error: error instanceof Error ? error.message : String(error),
				...(error instanceof StaleGeneration ? { code: "stale_generation" as const } : error instanceof ReceiptConflict ? { code: "receipt_conflict" as const } : {}) }),
		);
		const readOnly = request.type === "describe" || request.type === "control" || request.type === "checkpoint" && request.action === "inspect"
			|| request.type === "command" && ["snapshot", "history", "asset", "artifact", "tree", "native_read", "context_inspect", "context_read"].includes(request.command.kind)
			|| request.type === "command" && request.command.kind === "file" && ["info", "text", "chunk"].includes(request.command.operation);
		if (!readOnly) {
			this.admitted.set(request.id, { operation, fingerprint });
			void operation.then(result => {
				const item = this.admitted.get(request.id);
				if (item) item.result = result;
				this.completed.push(request.id);
				if (this.completed.length > 256) {
					const old = this.completed.shift()!;
					this.admitted.delete(old);
					this.retired.add(old);
				}
			});
		}
		return operation;
	}
}

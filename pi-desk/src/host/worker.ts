import { DeskEngine } from "./engine.ts";
import { createHash } from "node:crypto";
import type { WorkerMessage, WorkerRequest } from "../shared/protocol.ts";
import { StaleGeneration } from "./worker-errors.ts";
import { isControl } from "../shared/controls.ts";

const send = (message: WorkerMessage) => { if (process.connected) process.send?.(message); };
const engine = new DeskEngine(send);
const admitted = new Map<string, { operation: Promise<unknown>; fingerprint: string }>();
const completed: string[] = [];
const retired = new Set<string>();
let started = false;

process.on("message", (request: WorkerRequest) => {
	if (!request || typeof request.id !== "string") return;
	const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
	const previous = admitted.get(request.id);
	if (retired.has(request.id) || previous && previous.fingerprint !== fingerprint) {
		send({ type: "result", id: request.id, code: "receipt_conflict",
			error: "This command receipt expired or its contents changed. Check the session before trying again." });
		return;
	}
	let operation = previous?.operation;
	if (!operation) {
		operation = Promise.resolve().then(async () => {
			if (request.type === "shutdown") return engine.close();
			if (request.type === "init") {
				if (started) throw new Error("Worker already initialized.");
				started = true;
				return engine.start(request.options);
			}
			const result = await engine.command(request.generation, request.command);
			if (isControl(request.command)) send({ type: "snapshot", snapshot: engine.snapshot() });
			return result;
		});
		const readOnly = request.type === "command" && ["snapshot", "history", "asset", "artifact", "file", "tree"].includes(request.command.kind);
		if (!readOnly) {
			admitted.set(request.id, { operation, fingerprint });
			void operation.finally(() => {
				completed.push(request.id);
				if (completed.length > 256) {
					const old = completed.shift()!;
					admitted.delete(old);
					retired.add(old);
				}
			}).catch(() => {});
		}
	}
	void operation.then(
		value => send({ type: "result", id: request.id, value }),
		error => send({ type: "result", id: request.id, error: error instanceof Error ? error.message : String(error),
			...(error instanceof StaleGeneration ? { code: "stale_generation" as const } : {}) }),
	);
});
const stop = () => {
	void engine.close().then(() => process.exit(0), error => {
		console.error("Session shutdown failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveWorker } from "./worker-runtime.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Worker registry directory is required.");
const runtime = await serveWorker(directory, async send => {
	const { DeskEngine } = await import("./engine.ts");
	return new DeskEngine(send);
});
process.on("SIGTERM", () => { void runtime.stop().catch(() => {}); });
runtime.closed.then(() => process.exit(0), error => {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Worker shutdown failed:", message);
	// Shaped like Node's own crash report, which the host reads to explain a worker that stopped while starting.
	try { writeFileSync(join(directory, "failure.json"), JSON.stringify({ javascriptStack: { message: `Worker shutdown failed: ${message}` } })); } catch { /* The exit code still reports it. */ }
	process.exit(1);
});

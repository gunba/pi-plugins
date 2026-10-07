import { serveWorker } from "./worker-runtime.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Worker registry directory is required.");
const runtime = await serveWorker(directory, async send => {
	const { DeskEngine } = await import("./engine.ts");
	return new DeskEngine(send);
});
process.on("SIGTERM", () => { void runtime.stop().catch(() => {}); });
runtime.closed.then(() => process.exit(0), error => {
	console.error("Worker shutdown failed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});

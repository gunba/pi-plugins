import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { serveWorker } from "../../src/host/worker-runtime.ts";
import { DeskEngine } from "../../src/host/engine.ts";

globalThis.fetch = () => { throw new Error("Native handoff fixture cannot access the network."); };
const runtime = await serveWorker(process.argv[2], async send => {
	const engine = new DeskEngine(send);
	return {
		async start(options) {
			await engine.start(options);
			const models = engine.runtime.services.modelRuntime, calls = [];
			models.registerNativeProvider({ ...models.getProvider("anthropic"), streamSimple(model, context) {
				calls.push(context.messages.filter(message => message.role === "user").flatMap(message =>
					typeof message.content === "string" ? [message.content] : message.content.filter(block => block.type === "text").map(block => block.text)));
				writeFileSync(join(options.cwd, "model-calls.json"), JSON.stringify(calls));
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const reason = calls.length === 1 ? "toolUse" : "stop";
					stream.push({ type: "done", reason, message: { role: "assistant", provider: model.provider, model: model.id,
						api: model.api, stopReason: reason, timestamp: Date.now(),
						content: calls.length === 1 ? [{ type: "toolCall", id: "fixture-call", name: "handoff_fixture", arguments: {} }]
							: [{ type: "text", text: "Offline fixture complete" }],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
					stream.end();
				});
				return stream;
			} });
			return engine.snapshot();
		},
		snapshot: () => engine.snapshot(), command: (generation, command) => engine.command(generation, command),
		checkpoint: (id, action) => engine.checkpoint(id, action),
		shutdownCheckpoint: () => engine.shutdownCheckpoint(), close: () => engine.close(),
	};
});
process.on("SIGTERM", () => { void runtime.stop(); });
runtime.closed.then(() => process.exit(0), () => process.exit(1));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { serveWorker } from "../../src/host/worker-runtime.ts";
import { DeskEngine } from "../../src/host/engine.ts";

globalThis.fetch = () => { throw new Error("Subagent handoff fixture cannot access the network."); };
const runtime = await serveWorker(process.argv[2], async send => {
	const engine = new DeskEngine(send);
	return {
		async start(options) {
			await engine.start(options);
			const models = engine.runtime.services.modelRuntime, calls = {};
			const root = engine.snapshot().id;
			await models.setRuntimeApiKey("anthropic", "synthetic-offline-fixture");
			await engine.command(engine.snapshot().ui.generation, { kind: "account", provider: "anthropic", id: "pi" });
			models.registerNativeProvider({ ...models.getProvider("anthropic"), streamSimple(model, context, request) {
				const id = request?.sessionId ?? root;
				calls[id] ??= [];
				calls[id].push(context.messages.map(message => ({ role: message.role, content: message.content })));
				writeFileSync(join(options.cwd, "subagent-model-calls.json"), JSON.stringify(calls));
				const count = calls[id].length;
				const call = id === root
					? count === 1 ? { name: "agent_start", arguments: { name: "handoff_child", task: "Child lifecycle fixture", context: "fresh" } } : undefined
					: count === 1 ? { name: "handoff_fixture", arguments: {} } : undefined;
				const reason = call ? "toolUse" : "stop", stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason, message: { role: "assistant", provider: model.provider, model: model.id,
						api: model.api, stopReason: reason, timestamp: Date.now(),
						content: call ? [{ type: "toolCall", id: `${id}-${count}`, ...call }]
							: [{ type: "text", text: "Offline subagent fixture complete" }],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
					stream.end();
				});
				return stream;
			} });
			engine.runtime.session.setActiveToolsByName(["agent_start", "agent_send", "handoff_fixture"]);
			return engine.snapshot();
		},
		snapshot: () => engine.snapshot(), command: (generation, command) => engine.command(generation, command),
		close: () => engine.close(),
	};
});
process.on("SIGTERM", () => { void runtime.stop(); });
runtime.closed.then(() => process.exit(0), () => process.exit(1));

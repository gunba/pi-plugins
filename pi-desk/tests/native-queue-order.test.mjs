import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { promoteFollowUp } from "../src/host/native-queue-order.ts";

const model = { id: "offline", name: "Offline", api: "openai-completions", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

test("Send now on a queued follow-up delivers it, with its image, before earlier follow-ups", { timeout: 5000 }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "desk-queue-order-")), contexts = [];
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let session;
	t.after(() => { session?.dispose(); rmSync(dir, { recursive: true, force: true }); });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("fixture", { name: "Offline", apiKey: "fixture", api: model.api, baseUrl: "http://127.0.0.1:1", models: [model], streamSimple(model, context, options) {
		contexts.push(JSON.stringify(context.messages));
		const stream = new AssistantMessageEventStream(), first = contexts.length === 1;
		const finish = reason => { stream.push({ type: reason === "aborted" ? "error" : "done", reason, ...(reason === "aborted" ? { error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "aborted" } } : { message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "stop" } }) }); stream.end(); };
		if (first) options.signal.addEventListener("abort", () => finish("aborted"), { once: true }); else queueMicrotask(() => finish("stop"));
		return stream;
	} });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPrompt: "Offline fixture." });
	await loader.reload();
	({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("fixture", "offline"), resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir), settingsManager: settings, tools: [] }));
	session.agent.steeringMode = "all";
	const running = session.prompt("Start");
	while (contexts.length < 1) await delay(2);
	await session.followUp("Earlier follow-up");
	await session.followUp("Look at this", [image]);

	promoteFollowUp(session, 1, "Look at this");
	assert.deepEqual(session.getSteeringMessages(), ["Look at this"]);
	assert.deepEqual(session.getFollowUpMessages(), ["Earlier follow-up"]);
	assert.throws(() => promoteFollowUp(session, 0, "Something else"), /no longer queued/);

	await session.abort(); await running;
	await session.sendCustomMessage({ customType: "desk-steering-resume", content: "Process the pending steering messages.", display: false }, { triggerTurn: true });
	await session.waitForIdle();
	assert.match(contexts[1], /Look at this/); assert.match(contexts[1], /iVBORw0KGgo=/);
	assert.doesNotMatch(contexts[1], /Earlier follow-up/);
	assert.match(contexts.at(-1), /Earlier follow-up/);
	assert.deepEqual([session.getSteeringMessages(), session.getFollowUpMessages()], [[], []]);
});

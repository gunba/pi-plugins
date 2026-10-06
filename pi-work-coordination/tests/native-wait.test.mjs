import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkCoordination, getWorkCoordinator, WAKE_MESSAGE } from "../index.ts";

const modelData = { id: "offline", name: "Offline", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const mode of ["rpc", "sdk"]) test(`native ${mode} root stays active through a pending wait without a separate wake`, { timeout: 5000 }, async t => {
 const dir = mkdtempSync(join(tmpdir(), "pi-native-wait-"));
 const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const manager = SessionManager.create(dir, dir);
 let session, calls = 0, settled = false; const errors = [], contexts = [];
 const priorFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail("No network allowed");
 t.after(async () => { try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally { globalThis.fetch = priorFetch; rmSync(dir, { recursive: true, force: true }); } });
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
 runtime.registerProvider("fixture", { name: "Offline", apiKey: "fixture", api: modelData.api, baseUrl: "http://127.0.0.1:1", models: [modelData], streamSimple(model, context) {
  contexts.push(context.messages); calls++; assert.ok(calls <= 2);
  const content = calls === 1 ? [{ type: "toolCall", id: "wait", name: "wait_agent", arguments: { timeout_ms: 2000 } }] : [{ type: "text", text: "Done" }];
  const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: calls === 1 ? "toolUse" : "stop" };
  const stream = new AssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
 } });
 const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
  extensionFactories: [ensureWorkCoordination], systemPrompt: "Offline fixture." });
 await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
 ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("fixture", "offline"), resourceLoader: loader,
  sessionManager: manager, settingsManager: settings, tools: ["wait_agent"] }));
 await session.bindExtensions({ mode, onError: e => errors.push(e) });
 const coordinator = getWorkCoordinator(manager.getSessionId());
 const running = session.prompt("Wait for the existing child").then(() => { settled = true; });
 const deadline = Date.now() + 1000;
 while (!coordinator.waiting && Date.now() < deadline) await delay(5);
 assert.equal(coordinator.waiting, true); await delay(20);
 assert.equal(settled, false, "wait must not settle the root and leave Desk showing idle");
 assert.equal(session.isStreaming, true); assert.equal(calls, 1);
 await session.sendCustomMessage({ customType: "pi-subagents/notice", content: "CHILD REPORTED", display: true,
  details: { messageIds: ["report"] } }, { deliverAs: "steer", triggerTurn: false });
 coordinator.notify(["report"]); await running;
 assert.equal(calls, 2); assert.equal(coordinator.blocked, false);
 assert.match(JSON.stringify(contexts[1]), /CHILD REPORTED/); assert.deepEqual(errors, []);
 assert.match(JSON.stringify(contexts[1]), /clamped to the minimum of 10000ms/);
 assert.equal(coordinator.hasUnread, false);
 assert.equal(manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === WAKE_MESSAGE).length, 0);
});

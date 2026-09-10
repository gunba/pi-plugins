import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiSdkDriverFactory } from "../extensions/pi-sdk-driver.ts";
import { getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { waitUntil } from "./helpers.mjs";

const model = { id: "offline", name: "offline", api: "openai-completions", provider: "wait-test", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const target = { kind: "process", id: "existing-job" };
async function fixture(t, mixed = false, afterFirstContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-explicit-wait-"));
  const id = randomUUID(); const manager = SessionManager.create(dir, join(dir, "sessions"), { id });
  let calls = 0; const contexts = [];
  const host = { rootSessionId: "root", cwd: dir, agentDir: dir, activeRootLaunchIds: new Set(), isProjectTrusted: () => true, recordRootLaunch() {}, deliverRootNotice() { return true; }, resolveModel: () => model,
    async prepareModelRuntime(_ref, runtime) {
      runtime.registerProvider(model.provider, { name: "offline", baseUrl: model.baseUrl, apiKey: "offline", api: model.api, models: [model], streamSimple(_model, context) {
        contexts.push(context); calls++;
        const content = calls === 1 && !afterFirstContext ? [{ type: "toolCall", id: "wait", name: "wait_for_work", arguments: { targets: [target] } }, ...(mixed ? [{ type: "toolCall", id: "noop", name: "noop", arguments: {} }] : [])] : [{ type: "text", text: "finished after event" }];
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: calls === 1 && !afterFirstContext ? "toolUse" : "stop" };
        const stream = new AssistantMessageEventStream(); queueMicrotask(() => { if (calls === 1) afterFirstContext?.(); stream.push({ type: "done", reason: message.stopReason, message }); }); return stream;
      } });
    } };
  const driver = await new PiSdkDriverFactory(host).open({ signal: new AbortController().signal, sessionManager: manager,
    descriptor: { version: 2, projectTrusted: true, childSessionId: id, rootSessionId: "root", parentSessionId: "root", mode: "continuable", context: "fresh", provider: "pi-sdk", label: "wait test", depth: 1, cwd: dir, createdAt: Date.now(), model: { provider: model.provider, id: model.id }, thinkingLevel: "off", toolNames: [] },
    authority: { sessionId: id, rootSessionId: "root", depth: 1, generation: "test", token: Symbol() },
    customTools: mixed ? [defineTool({ name: "noop", label: "noop", description: "fixture", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; } })] : [],
  });
  t.after(async () => { await driver.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const coordinator = getWorkCoordinator(id); assert.ok(coordinator, "explicit noExtensions inline factory was initialized");
  coordinator.register(target);
  return { driver, coordinator, manager, contexts, calls: () => calls };
}

test("real SDK child parks a terminating wait without settlement, then resumes exactly once", async (t) => {
  const f = await fixture(t); let settled = false;
  const running = f.driver.prompt("work").then((value) => { settled = true; return value; });
  await waitUntil(() => f.coordinator.waiting, "explicit wait"); await delay(30);
  assert.equal(f.calls(), 1); assert.equal(settled, false); assert.equal(f.driver.isRunning, true);
  const unrelated = { messageId: "one-report", kind: "report", childId: "other-child", content: "unrelated routine result" };
  f.driver.receiveNotices([unrelated]); f.driver.receiveNotices([unrelated]); await delay(10);
  assert.equal(f.calls(), 1, "unrelated routine report does not wake an explicit process wait");
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-subagents/notice").length, 1, "driver replay and runtime batch cannot duplicate the same receipt");
  assert.equal(f.coordinator.complete(target, "job exited successfully"), true);
  const outcome = await running;
  assert.equal(outcome.stopReason, "completed"); assert.equal(outcome.output, "finished after event");
  assert.equal(f.calls(), 2); assert.match(JSON.stringify(f.contexts.at(-1)), /job exited successfully/);
  assert.equal(f.coordinator.complete(target, "duplicate"), false); assert.equal(f.calls(), 2);
});
test("real SDK child cancellation during explicit wait is aborted, not a toolUse error", async (t) => {
  const f = await fixture(t); const running = f.driver.prompt("work");
  await waitUntil(() => f.coordinator.waiting); f.driver.interrupt();
  const outcome = await running; assert.equal(outcome.stopReason, "aborted"); assert.equal(outcome.errorMessage, undefined); assert.equal(f.calls(), 1);
});
test("real SDK mixed tool batch does not pretend to yield", async (t) => {
  const f = await fixture(t, true); const outcome = await f.driver.prompt("work");
  assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 2); assert.equal(f.coordinator.blocked, false);
  f.coordinator.complete(target, "later"); assert.equal(f.calls(), 2);
});
test("real SDK completion immediately before wait returns without an extra wake", async (t) => {
  const f = await fixture(t); f.coordinator.complete(target, "already done");
  const outcome = await f.driver.prompt("work"); assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 2); assert.equal(f.coordinator.blocked, false);
});
test("notice arriving after final provider context gets one SDK continuation instead of an unseen settlement", async (t) => {
  let f;
  f = await fixture(t, false, () => f.driver.receiveNotices([{ messageId: "late", kind: "settlement", childId: "other", content: "LATE CHILD FINDING" }]));
  const outcome = await f.driver.prompt("work");
  assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 2);
  assert.match(JSON.stringify(f.contexts.at(-1)), /LATE CHILD FINDING/);
});

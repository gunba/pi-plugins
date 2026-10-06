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
import { createHarness, waitUntil } from "./helpers.mjs";
import { DELIVERY_ENTRY } from "../extensions/subagent-runtime.ts";

const model = { id: "offline", name: "offline", api: "openai-completions", provider: "wait-test", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function fixture(t, mixed = false, afterFirstContext, waitFirst = !afterFirstContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-explicit-wait-"));
  const id = randomUUID(); const manager = SessionManager.create(dir, join(dir, "sessions"), { id });
  let calls = 0; const contexts = [];
  const host = { rootSessionId: "root", cwd: dir, agentDir: dir, activeRootLaunchIds: new Set(), isProjectTrusted: () => true, recordRootLaunch() {}, deliverRootNotice() { return true; }, resolveModel: () => model,
    async prepareModelRuntime(_ref, runtime) {
      runtime.registerProvider(model.provider, { name: "offline", baseUrl: model.baseUrl, apiKey: "offline", api: model.api, models: [model], streamSimple(_model, context) {
        contexts.push(context); calls++;
        const content = calls === 1 && waitFirst ? [{ type: "toolCall", id: "wait", name: "wait_agent", arguments: {} }, ...(mixed ? [{ type: "toolCall", id: "noop", name: "noop", arguments: {} }] : [])] : [{ type: "text", text: "finished after event" }];
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: calls === 1 && waitFirst ? "toolUse" : "stop" };
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
  return { driver, coordinator, manager, contexts, calls: () => calls };
}

test("real SDK child keeps its wait pending and continues on a routine message", async (t) => {
  const f = await fixture(t); let settled = false;
  const running = f.driver.prompt("work").then((value) => { settled = true; return value; });
  await waitUntil(() => f.coordinator.waiting, "explicit wait"); await delay(30);
  assert.equal(f.calls(), 1); assert.equal(settled, false); assert.equal(f.driver.isRunning, true);
  const report = { messageId: "one-report", kind: "report", childId: "other-child", content: "routine result" };
  f.driver.receiveNotices([report]); f.driver.receiveNotices([report]);
  const outcome = await running;
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-subagents/notice").length, 1, "driver replay and runtime batch cannot duplicate the same receipt");
  assert.equal(outcome.stopReason, "completed"); assert.equal(outcome.output, "finished after event");
  assert.equal(f.calls(), 2); assert.match(JSON.stringify(f.contexts.at(-1)), /routine result/);
  assert.equal(f.coordinator.hasUnread, false, "the native context acknowledged the exact message");
});
test("explicit follow-up releases an SDK wait and reaches the next request in the same invocation", async t => {
  const f = await fixture(t);
  const running = f.driver.prompt("work");
  await waitUntil(() => f.coordinator.waiting);
  f.driver.enqueueFollowup({ messageId: "followup-1", content: "NEW TASK INSTRUCTION" });
  const outcome = await running;
  assert.equal(f.calls(), 2);
  assert.match(JSON.stringify(f.contexts[1]), /NEW TASK INSTRUCTION/);
  assert.deepEqual(outcome.consumedFollowups, ["followup-1"]);
  assert.equal(f.coordinator.hasUnread, false);
  assert.equal(outcome.usage.output, 2);
});

test("runtime coalesces an active SDK follow-up once and cold recovery does not replay it", async t => {
  let h; let calls = 0; const contexts = []; const charges = []; const checkpointErrors = [];
  h = createHarness({ factory: { open: input => new PiSdkDriverFactory(h.host).open(input) }, getActiveToolNames: () => ["wait_agent"] });
  t.after(h.cleanup);
  h.host.resolveModel = () => model;
  h.host.recordBackgroundUsage = (...args) => charges.push(args);
  h.host.prepareModelRuntime = async (_ref, runtime) => runtime.registerProvider(model.provider, {
    name: "offline", baseUrl: model.baseUrl, apiKey: "offline", api: model.api, models: [model],
    streamSimple(_model, context) {
      contexts.push(context); calls++;
      if (calls === 2) {
        assert.equal(h.runtime.snapshot()[0].queued, 0);
        try { h.runtime.checkpointReady(); } catch (error) { checkpointErrors.push(error.message); }
      }
      const content = calls === 1 ? [{ type: "toolCall", id: "hold", name: "wait_agent", arguments: {} }] : [{ type: "text", text: "both inputs handled" }];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: calls === 1 ? "toolUse" : "stop" };
      const stream = new AssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message })); return stream;
    },
  });
  const child = await h.runtime.start({ taskName: "worker", description: "worker", prompt: "initial task", context: "fresh", runInBackground: true,
    parent: h.parent({ model, thinkingLevel: "off", toolNames: ["wait_agent"] }) });
  await waitUntil(() => getWorkCoordinator(child.subagentId)?.waiting);
  const followup = h.runtime.followupTask(h.runtime.rootAuthority, "worker", "FOLLOWUP TASK");
  assert.throws(() => h.runtime.checkpointReady(), /Finish queued tasks/, "undelivered input still blocks checkpointing");
  await waitUntil(() => h.runtime.listAgents(h.runtime.rootAuthority)[0]?.status === "ready");
  assert.equal(calls, 2); assert.match(JSON.stringify(contexts[1]), /FOLLOWUP TASK/);
  assert.equal(h.runtime.snapshot()[0].queued, 0);
  const manager = SessionManager.open(h.runtime.getSessionFile(child.subagentId));
  const terminal = manager.getBranch().filter(entry => entry.customType === DELIVERY_ENTRY && entry.data.action === "finished");
  assert.equal(terminal.length, 1); assert.deepEqual(terminal[0].data.consumedFollowups, [followup]);
  assert.equal(charges.length, 1); assert.equal(charges[0][2].output, 2);
  assert.deepEqual(checkpointErrors, [], "context-consumed inputs belong to the active invocation, not an undispatched queue");
  await h.runtime.shutdown();
  const restored = createHarness({ root: h.root, rootManager: h.rootManager });
  try { assert.equal(restored.runtime.snapshot()[0].queued, 0); assert.equal(restored.factory.opens.length, 0); }
  finally { await restored.runtime.shutdown(); }
});

for (const timing of ["before-start", "after-first-context", "after-settled"]) test(`explicit follow-up at ${timing} is consumed only at a native boundary`, async t => {
  let f;
  const input = { messageId: "timed-followup", content: "TIMED FOLLOWUP" };
  f = await fixture(t, false, timing === "after-first-context" ? () => f.driver.enqueueFollowup(input) : undefined, false);
  if (timing === "before-start") f.driver.enqueueFollowup(input);
  let sent = false;
  const unsubscribe = f.driver.subscribeTranscript(event => {
    if (timing === "after-settled" && event.type === "agent_settled" && !sent) { sent = true; f.driver.enqueueFollowup(input); }
  });
  try {
    const result = await f.driver.prompt("initial task");
    assert.equal(f.calls(), timing === "after-first-context" ? 2 : 1);
    assert.deepEqual(result.consumedFollowups ?? [], timing === "after-settled" ? [] : [input.messageId]);
    if (timing !== "after-settled") assert.match(JSON.stringify(f.contexts.at(-1)), /TIMED FOLLOWUP/);
    assert.equal(f.coordinator.hasUnread, false);
  } finally { unsubscribe(); }
});

test("real SDK child cancellation during explicit wait is aborted, not a toolUse error", async (t) => {
  const f = await fixture(t); const running = f.driver.prompt("work");
  await waitUntil(() => f.coordinator.waiting); f.driver.interrupt();
  const outcome = await running; assert.equal(outcome.stopReason, "aborted"); assert.equal(outcome.errorMessage, undefined); assert.equal(f.calls(), 1);
});
test("real SDK mixed tool batch waits without special termination rules", async (t) => {
  const f = await fixture(t, true); const running = f.driver.prompt("work");
  await waitUntil(() => f.coordinator.waiting); assert.equal(f.calls(), 1);
  f.driver.receiveNotices([{ messageId: "finished", kind: "settlement", childId: "child", content: "finished" }]);
  const outcome = await running;
  assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 2); assert.equal(f.coordinator.blocked, false);
  f.driver.receiveNotices([{ messageId: "later", kind: "report", childId: "child", content: "later" }]);
  await delay(10); assert.equal(f.calls(), 2);
});
test("real SDK completion immediately before wait returns without an extra wake", async (t) => {
  let f;
  f = await fixture(t, false, () => f.driver.receiveNotices([{ messageId: "early", kind: "settlement", childId: "child", content: "already done" }]), true);
  const outcome = await f.driver.prompt("work"); assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 2); assert.equal(f.coordinator.blocked, false);
  assert.match(JSON.stringify(f.contexts.at(-1)), /already done/);
  assert.equal(f.coordinator.hasUnread, false);
});
test("notice arriving after final provider context stays queued without starting another turn", async (t) => {
  let f;
  f = await fixture(t, false, () => f.driver.receiveNotices([{ messageId: "late", kind: "settlement", childId: "other", content: "LATE CHILD FINDING" }]));
  const outcome = await f.driver.prompt("work");
  assert.equal(outcome.stopReason, "completed"); assert.equal(f.calls(), 1);
  assert.equal(f.driver.isRunning, false);
  await f.driver.prompt("Read the pending finding");
  assert.equal(f.calls(), 2);
  assert.match(JSON.stringify(f.contexts.at(-1)), /LATE CHILD FINDING/);
});

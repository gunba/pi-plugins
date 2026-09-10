import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";
import { getWorkCoordinator, WAKE_MESSAGE } from "../../pi-work-coordination/index.ts";
import { GOAL_ROUND_MESSAGE } from "../src/constants.ts";

test("goal driver continues useful work but never spends rounds while explicitly awaiting events", async () => {
  const h = createExtensionHarness({ idle: false }); await h.start(); await h.directInput();
  const coordinator = getWorkCoordinator(h.ctx.sessionManager.getSessionId());
  const process = { kind: "process", id: "existing" }, child = { kind: "child", id: "existing-child" };
  coordinator.register(process); coordinator.register(child);
  assert.equal(coordinator.blocked, false, "resource existence alone cannot stop useful work");
  await executeTool(h, "create_goal", { objective: "finish real work" });
  const waiting = await executeTool(h, "wait_for_work", { targets: [process, child], mode: "all" });
  assert.equal(waiting.terminate, true);
  h.setIdle(true);
  for (let i = 0; i < 4; i++) await h.emit("agent_settled");
  assert.equal(h.sentMessages.length, 0);
  coordinator.complete(process, "process done"); await h.emit("agent_settled"); assert.equal(h.sentMessages.length, 0);
  coordinator.complete(child, "child done"); await h.emit("agent_settled");
  assert.equal(h.sentMessages.length, 1); assert.equal(h.sentMessages[0].message.customType, WAKE_MESSAGE);
  assert.equal(h.sentMessages.filter((item) => item.message.customType === GOAL_ROUND_MESSAGE).length, 0, "ready wait blocks a competing settled goal round until context consumes the event");
  await h.emit("context", { messages: [] }); await h.emit("agent_settled");
  assert.equal(h.sentMessages.filter((item) => item.message.customType === GOAL_ROUND_MESSAGE).length, 1);
  await h.emit("session_shutdown");
});

test("reload, branch replacement and direct input cannot retain phantom work waits", async () => {
  const h = createExtensionHarness(); await h.start();
  const id = h.ctx.sessionManager.getSessionId();
  const target = { kind: "timer", id: "existing" }; getWorkCoordinator(id).register(target);
  await executeTool(h, "wait_for_work", { targets: [target] });
  await h.directInput("do something else"); assert.equal(getWorkCoordinator(id).blocked, false);
  await executeTool(h, "wait_for_work", { targets: [target] }); await h.emit("session_shutdown"); await h.start("reload");
  assert.equal(getWorkCoordinator(id).blocked, false);
  await assert.rejects(executeTool(h, "wait_for_work", { targets: [target] }), /session-owned/);
  getWorkCoordinator(id).register(target); await executeTool(h, "wait_for_work", { targets: [target] });
  await h.emit("session_tree"); assert.equal(getWorkCoordinator(id).blocked, false);
  await h.emit("session_shutdown");
});
test("tree replacement does not copy an abandoned branch's ready event into the destination", async () => {
  const h = createExtensionHarness({ persistSentMessages: false }); await h.start();
  const target = { kind: "process", id: "branch-local" };
  const c = getWorkCoordinator(h.ctx.sessionManager.getSessionId()); c.register(target); c.begin([target]); c.complete(target, "old branch event");
  const priorSends = h.sentMessages.length;
  h.branch.splice(0); await h.emit("session_tree");
  assert.equal(h.branch.length, 0); assert.equal(h.sentMessages.length, priorSends);
  await h.emit("session_shutdown");
});
test("a successful goal pause command cancels waiting even though slash commands skip input hooks", async () => {
  const h = createExtensionHarness({ idle: false }); await h.start(); await h.directInput();
  await executeTool(h, "create_goal", { objective: "work" });
  const c = getWorkCoordinator(h.ctx.sessionManager.getSessionId()), target = { kind: "timer", id: "t" };
  c.register(target); c.begin([target]); await h.commands.get("goal").handler("pause", h.ctx);
  assert.equal(c.blocked, false); c.complete(target, "late timer"); assert.equal(h.sentMessages.length, 0);
  await h.emit("session_shutdown");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";
import { getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { PLAN_ROUND_MESSAGE } from "../src/constants.ts";

test("automatic plans never spend rounds while explicitly awaiting events", async () => {
	const h = createExtensionHarness({ idle: false }); await h.start();
	const coordinator = getWorkCoordinator(h.ctx.sessionManager.getSessionId());
	assert.equal(coordinator.blocked, false);
	await executeTool(h, "create_plan", { objective: "finish real work", auto_continue: true });
	const waiting = executeTool(h, "wait_agent", {});
	h.setIdle(true);
	for (let i = 0; i < 4; i++) await h.emit("agent_settled");
	assert.equal(h.sentMessages.length, 0);
	coordinator.notify(["child-report"]); const result = await waiting;
	assert.equal(result.terminate, undefined); assert.equal(h.sentMessages.length, 0, "completion returns to the tool loop without a wake message");
	await h.emit("agent_settled");
	assert.equal(h.sentMessages.filter(item => item.message.customType === PLAN_ROUND_MESSAGE).length, 1);
	await h.emit("session_shutdown");
});

test("reload, branch replacement and direct input cannot retain phantom waits", async () => {
	const h = createExtensionHarness(); await h.start();
	const id = h.ctx.sessionManager.getSessionId();
	const first = executeTool(h, "wait_agent", {});
	await h.directInput("do something else"); await first; assert.equal(getWorkCoordinator(id).blocked, false);
	const second = executeTool(h, "wait_agent", {}); await h.emit("session_shutdown"); await second; await h.start("reload");
	assert.equal(getWorkCoordinator(id).blocked, false);
	assert.equal(getWorkCoordinator(id).hasUnread, false);
	const third = executeTool(h, "wait_agent", {});
	await h.emit("session_tree"); await third; assert.equal(getWorkCoordinator(id).blocked, false);
	await h.emit("session_shutdown");
});

test("tree replacement cannot copy an abandoned branch's ready event into the destination", async () => {
	const h = createExtensionHarness({ persistSentMessages: false }); await h.start();
	const coordinator = getWorkCoordinator(h.ctx.sessionManager.getSessionId());
	coordinator.notify(["old-branch-event"]);
	const priorSends = h.sentMessages.length;
	h.branch.splice(0); await h.emit("session_tree");
	assert.equal(h.branch.length, 0); assert.equal(h.sentMessages.length, priorSends);
	assert.equal(getWorkCoordinator(h.ctx.sessionManager.getSessionId()).hasUnread, false);
	await h.emit("session_shutdown");
});

test("a successful pause command cancels waits although slash commands skip input hooks", async () => {
	const h = createExtensionHarness({ idle: false }); await h.start();
	await executeTool(h, "create_plan", { objective: "work", auto_continue: true });
	const coordinator = getWorkCoordinator(h.ctx.sessionManager.getSessionId());
	const waiting = coordinator.wait(1000); await h.commands.get("plan").handler("pause", h.ctx); await waiting;
	assert.equal(coordinator.blocked, false); coordinator.notify(["late"]); assert.equal(h.sentMessages.length, 0);
	await h.emit("session_shutdown");
});

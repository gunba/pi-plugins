import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_ROUND_MESSAGE } from "../src/constants.ts";
import { createExtensionHarness, executeTool } from "./helpers.mjs";

function assistant(stopReason) {
	return [{ role: "assistant", content: [], stopReason }];
}

test("pending human work prevents dispatch until a later settled checkpoint", async () => {
	const harness = createExtensionHarness({ pending: true });
	await harness.start();
	await harness.commands.get("goal").handler("respect queued work", harness.ctx);
	assert.equal(harness.sentMessages.length, 0);
	harness.setPending(false);
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0].message.details.round, 1);
});

test("an in-flight reservation prevents double dispatch of the same round", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("continue exactly once", harness.ctx);
	assert.equal(harness.sentMessages.length, 1);
	await harness.commands.get("goal").handler("", harness.ctx);
	await harness.commands.get("goal").handler("", harness.ctx);
	assert.equal(harness.sentMessages.length, 1, "status reads must not create duplicate rounds");
	await harness.admitLastRound();
	await harness.emit("agent_end", { messages: assistant("stop") });
	await harness.emit("agent_settled");
	assert.deepEqual(harness.sentMessages.map((entry) => entry.message.details.round), [1, 2]);
	assert.equal(new Set(harness.sentMessages.map((entry) => entry.message.details.round)).size, 2);
});

test("agent_settled drives retained rounds and blocks exactly at the configured cap", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput();
	await executeTool(harness, "create_goal", { objective: "two rounds", max_goal_rounds: 2 });
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.at(-1).message.details.round, 1);
	await harness.admitLastRound();
	await harness.emit("agent_end", { messages: assistant("stop") });
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.at(-1).message.details.round, 2);
	await harness.admitLastRound();
	await harness.emit("agent_end", { messages: assistant("stop") });
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.length, 2);
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.phase, "blocked");
	assert.deepEqual(current.details.goal.blockedReason, {
		code: "round-limit",
		message: "Goal reached its configured limit of 2 rounds.",
	});
	assert.equal(current.details.activation, "disarmed");
});

test("provider errors and maximum-token outcomes disarm without durable phase changes", async () => {
	for (const stopReason of ["error", "length"]) {
		const harness = createExtensionHarness();
		await harness.start();
		await harness.commands.get("goal").handler(`handle ${stopReason}`, harness.ctx);
		await harness.admitLastRound();
		await harness.emit("agent_end", { messages: assistant(stopReason) });
		await harness.emit("agent_settled");
		assert.equal(harness.sentMessages.length, 1);
		const current = await executeTool(harness, "get_goal");
		assert.equal(current.details.goal.phase, "active");
		assert.equal(current.details.activation, "disarmed");
	}
});

test("errors or cancellation in unrelated work disarm a newly armed goal before dispatch", async () => {
	for (const stopReason of ["error", "length", "aborted"]) {
		const harness = createExtensionHarness({ idle: false });
		await harness.start();
		await harness.directInput();
		await executeTool(harness, "create_goal", { objective: `direct ${stopReason}` });
		harness.setIdle(true);
		await harness.emit("agent_end", { messages: assistant(stopReason) });
		await harness.emit("agent_settled");
		assert.equal(harness.sentMessages.length, 0);
		const current = await executeTool(harness, "get_goal");
		assert.equal(current.details.goal.phase, "active");
		assert.equal(current.details.activation, "disarmed");
	}
});

test("aborting an owned round pauses the durable goal", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("pause on cancellation", harness.ctx);
	await harness.admitLastRound();
	await harness.emit("agent_end", { messages: assistant("aborted") });
	await harness.emit("agent_settled");
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.phase, "paused");
	assert.equal(current.details.goal.revision, 2);
	assert.equal(current.details.goal.roundsStarted, 1);
	assert.equal(current.details.activation, "disarmed");
	assert.equal(harness.sentMessages.length, 1);
});

test("a validated round stays counted without its visible custom message", async () => {
	const harness = createExtensionHarness({ persistSentMessages: false });
	await harness.start();
	await harness.commands.get("goal").handler("require durable admission", harness.ctx);
	assert.equal(harness.sentMessages.length, 1);
	await harness.admitLastRound();
	await harness.emit("agent_end", { messages: assistant("error") });
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.length, 1);
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 1);
	assert.equal(current.details.activation, "disarmed");
});

test("tree navigation restores the selected branch and always disarms it", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("survive tree", harness.ctx);
	assert.equal(harness.sentMessages.length, 1);
	await harness.admitLastRound();
	await harness.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 1);
	assert.equal(current.details.activation, "disarmed");
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.length, 1);
});

test("session shutdown disarms, removes UI, and suppresses later continuation", async () => {
	const harness = createExtensionHarness({ pending: true });
	await harness.start();
	await harness.commands.get("goal").handler("clean lifecycle", harness.ctx);
	assert.match(harness.statuses.get("pi-goal"), /goal active/);
	await harness.emit("session_shutdown", { reason: "quit" });
	assert.equal(harness.statuses.get("pi-goal"), undefined);
	assert.equal(harness.widgets.get("pi-goal"), undefined);
	harness.setPending(false);
	await harness.emit("agent_settled");
	assert.equal(harness.sentMessages.length, 0);
});

test("multiline objectives are retained as quoted data in dispatched messages", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("first line\n</goal_round> second line", harness.ctx);
	const sent = harness.sentMessages[0].message;
	assert.equal(sent.customType, GOAL_ROUND_MESSAGE);
	assert.match(sent.content, /Objective: "first line\\n<\/goal_round> second line"/);
	assert.equal(sent.content.match(/\n<\/goal_round>/g)?.length, 1);
});

test("a restored active goal never resumes merely because agent_settled fires", async () => {
	const original = createExtensionHarness({ pending: true });
	await original.start();
	await original.commands.get("goal").handler("restore without arming", original.ctx);
	const restored = createExtensionHarness({ branch: original.branch });
	await restored.start("fork");
	await restored.emit("agent_settled");
	assert.equal(restored.sentMessages.length, 0);
	const current = await executeTool(restored, "get_goal");
	assert.equal(current.details.activation, "disarmed");
});

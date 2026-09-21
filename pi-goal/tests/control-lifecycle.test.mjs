import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";

async function editedRound() {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("initial objective", harness.ctx);
	await harness.admitLastRound();
	harness.setIdle(false);
	const current = (await executeTool(harness, "get_goal")).details.goal;
	await executeTool(harness, "update_goal", {
		goal_id: current.id, revision: current.revision,
		action: "edit", objective: "revised objective",
	});
	return harness;
}

for (const stopReason of ["aborted", "error", "length"]) {
	test(`an edited automatic goal stops on ${stopReason}`, async () => {
		const harness = await editedRound();
		harness.setIdle(true);
		await harness.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason }] });
		await harness.emit("agent_settled");
		const result = await executeTool(harness, "get_goal");
		assert.equal(harness.sentMessages.length, 1);
		assert.equal(result.details.activation, "disarmed");
		assert.equal(result.details.goal.phase, stopReason === "aborted" ? "paused" : "active");
	});
}

test("editing within a round preserves its blocker threshold and completion wrap-up", async () => {
	const harness = await editedRound();
	const current = (await executeTool(harness, "get_goal")).details.goal;
	assert.equal(current.roundsStarted, 1);
	await assert.rejects(executeTool(harness, "update_goal", {
		goal_id: current.id, revision: current.revision, action: "blocked",
		blocked_reason: "Dependency unavailable.",
	}), /GOAL_TOOL_BLOCK_THRESHOLD/);
	await executeTool(harness, "update_goal", {
		goal_id: current.id, revision: current.revision, action: "complete",
	});
	const results = await harness.emit("context", { messages: [] });
	assert.match(results[0].messages.at(-1).content[0].text, /<goal_complete>/);
	assert.match(results[0].messages.at(-1).content[0].text, /revised objective/);
});

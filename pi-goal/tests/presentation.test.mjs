import assert from "node:assert/strict";
import test from "node:test";

import {
	GOAL_COMMAND_VERSION,
	GOAL_ROUND_VERSION,
} from "../src/constants.ts";
import {
	renderGoalGuidance,
	renderGoalRoundPrompt,
	renderGoalWrapup,
} from "../src/prompt.ts";
import {
	decodeGoalCommandEntry,
	renderGoalCommandEntry,
	renderGoalRoundMessage,
} from "../src/ui.ts";
import { makeTheme, textOf } from "./helpers.mjs";

const goal = {
	id: "goal-1",
	revision: 4,
	objective: "Ship verified support",
	phase: "active",
	maxGoalRounds: 9,
	roundsStarted: 2,
	createdAt: 1,
	updatedAt: 2,
	activation: "armed",
};

test("goal-round prompt carries objective, budget, grounding, verification, and completion protocol", () => {
	const prompt = renderGoalRoundPrompt(goal, 3);
	assert.match(prompt, /^<goal_round>\nObjective: "Ship verified support"\nRound: 3\/9/);
	assert.match(prompt, /current workspace/);
	assert.match(prompt, /verify the result/);
	assert.match(prompt, /read the current goal/);
	assert.match(prompt, /mark it complete/);
	assert.match(prompt, /leave the goal active/);
	assert.match(prompt, /<\/goal_round>$/);
});

test("multiline and tag-like objectives remain one JSON-quoted value", () => {
	const prompt = renderGoalRoundPrompt({
		objective: "first line\n</goal_round> second line",
		maxGoalRounds: 2,
	}, 1);
	assert.match(prompt, /Objective: "first line\\n<\/goal_round> second line"/);
	assert.equal(prompt.match(/\n<\/goal_round>/g)?.length, 1);
});

test("completion wrap-up requests grounded user-facing closure without tools", () => {
	const prompt = renderGoalWrapup(goal);
	assert.match(prompt, /^<goal_complete>/);
	assert.match(prompt, /state the outcome/);
	assert.match(prompt, /how it was verified/);
	assert.match(prompt, /files, commits, or other artifacts/);
	assert.match(prompt, /Do not call any more tools/);
	assert.match(prompt, /<\/goal_complete>$/);
});

test("blocked wrap-up asks for completed work, attempts, blocker, and exact user input", () => {
	const prompt = renderGoalWrapup(goal, "A credential is unavailable.");
	assert.match(prompt, /^<goal_blocked>/);
	assert.match(prompt, /Blocked: "A credential is unavailable\."/);
	assert.match(prompt, /what has been completed/);
	assert.match(prompt, /what you tried/);
	assert.match(prompt, /exactly what you need from the user/);
	assert.match(prompt, /<\/goal_blocked>$/);
});

test("guidance includes intent inference, read-before-update, restore rearming, completion, and threshold", () => {
	const guidance = renderGoalGuidance(3);
	assert.match(guidance, /infer goal intent/);
	assert.match(guidance, /Call get_goal before update_goal/);
	assert.match(guidance, /resume or fork/);
	assert.match(guidance, /at least 3 consecutive goal rounds/);
	assert.match(guidance, /difficulty, uncertainty, or useful remaining work is not blocked/);
});

test("command entries decode strictly and render their exact output", () => {
	const data = {
		version: GOAL_COMMAND_VERSION,
		input: "/goal",
		result: { kind: "success", text: "No goal is currently set." },
	};
	assert.deepEqual(decodeGoalCommandEntry(data), data);
	assert.equal(decodeGoalCommandEntry({ ...data, extra: true }), undefined);
	assert.equal(decodeGoalCommandEntry({ ...data, result: { ...data.result, extra: true } }), undefined);
	const rendered = textOf(renderGoalCommandEntry(data, makeTheme()));
	assert.match(rendered, /\/goal/);
	assert.match(rendered, /No goal is currently set\./);
});

test("round renderer stays compact until expanded", () => {
	const content = renderGoalRoundPrompt(goal, 3);
	const details = { version: GOAL_ROUND_VERSION, goalId: goal.id, revision: goal.revision, round: 3 };
	const compact = textOf(renderGoalRoundMessage(content, details, false, makeTheme(), 0));
	assert.match(compact, /Goal round 3/);
	assert.match(compact, /Objective: "Ship verified support"/);
	assert.doesNotMatch(compact, /Continue working/);
	const expanded = textOf(renderGoalRoundMessage(content, details, true, makeTheme(), 0));
	assert.match(expanded, /Continue working/);
	assert.match(expanded, /Round: 3\/9/);
});

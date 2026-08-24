import assert from "node:assert/strict";
import test from "node:test";

import {
	applyGoalChange,
	emptyGoalFoldState,
	planClear,
	planCreate,
	planEdit,
	planPause,
} from "../src/domain.ts";
import {
	GOAL_CHANGE_ENTRY,
	GOAL_ROUND_ADMISSION_ENTRY,
	GOAL_ROUND_ADMISSION_VERSION,
	GOAL_ROUND_MESSAGE,
	GOAL_ROUND_VERSION,
} from "../src/constants.ts";
import { renderGoalRoundPrompt } from "../src/prompt.ts";
import {
	branchContainsRound,
	createGoalRoundAdmission,
	replayGoalBranch,
} from "../src/replay.ts";

function custom(data) {
	return { type: "custom", customType: GOAL_CHANGE_ENTRY, data };
}

function roundMessage(goal, number, overrides = {}) {
	return {
		type: "custom_message",
		customType: GOAL_ROUND_MESSAGE,
		content: renderGoalRoundPrompt(goal, number),
		display: true,
		details: {
			version: GOAL_ROUND_VERSION,
			goalId: goal.id,
			revision: goal.revision,
			round: number,
		},
		...overrides,
	};
}

function roundAdmission(goal, number, overrides = {}) {
	return {
		type: "custom",
		customType: GOAL_ROUND_ADMISSION_ENTRY,
		data: {
			...createGoalRoundAdmission(
				{ goalId: goal.id, revision: goal.revision, round: number },
				renderGoalRoundPrompt(goal, number),
			),
			...overrides,
		},
	};
}

function canonicalHistory() {
	const state = emptyGoalFoldState();
	const create = planCreate(state, { objective: "verify replay", maxGoalRounds: 3 }, "goal-replay", 10, 256);
	applyGoalChange(state, create.change);
	const firstRound = roundAdmission(state.goal, 1);
	state.roundsStarted = 1;
	const edit = planEdit(state, { id: "goal-replay", revision: 1 }, { objective: "verify strict replay" }, 11, "armed");
	applyGoalChange(state, edit.change);
	return { create: create.change, firstRound, edit: edit.change, state };
}

test("strict replay reconstructs full snapshots and durable round admissions", () => {
	const history = canonicalHistory();
	const folded = replayGoalBranch([
		{ type: "message", message: { role: "user", content: "unrelated" } },
		custom(history.create),
		roundMessage(history.create.goal, 1),
		history.firstRound,
		custom(history.edit),
	]);
	assert.equal(folded.goal.objective, "verify strict replay");
	assert.equal(folded.goal.revision, 2);
	assert.equal(folded.roundsStarted, 1);
	assert.equal(folded.updatedAt, 11);
});

test("pruning the visible round message does not regress durable counters", () => {
	const history = canonicalHistory();
	const visible = roundMessage(history.create.goal, 1);
	const retained = replayGoalBranch([
		custom(history.create),
		visible,
		history.firstRound,
		custom(history.edit),
	]);
	const pruned = replayGoalBranch([
		custom(history.create),
		history.firstRound,
		custom(history.edit),
	]);
	assert.equal(retained.roundsStarted, 1);
	assert.equal(pruned.roundsStarted, 1);
	assert.equal(branchContainsRound([custom(history.create), visible], {
		goalId: history.create.goal.id,
		revision: history.create.goal.revision,
		round: 1,
	}), false);
	assert.equal(branchContainsRound([custom(history.create), history.firstRound], {
		goalId: history.create.goal.id,
		revision: history.create.goal.revision,
		round: 1,
	}), true);
});

test("a missing durable admission is detected before a later snapshot can claim its counter", () => {
	const history = canonicalHistory();
	assert.throws(() => replayGoalBranch([
		custom(history.create),
		roundMessage(history.create.goal, 1),
		custom(history.edit),
	]), /preserve.*counters/);
});

test("only entries on the supplied branch affect replay", () => {
	const history = canonicalHistory();
	const selected = replayGoalBranch([custom(history.create)]);
	assert.equal(selected.goal.revision, 1);
	assert.equal(selected.roundsStarted, 0);
	assert.throws(
		() => replayGoalBranch([custom(history.edit)]),
		/requires a current goal/,
	);
});

test("clear tombstones remove the current goal but retain identity history", () => {
	const state = emptyGoalFoldState();
	const create = planCreate(state, { objective: "temporary" }, "goal-clear", 1, 256);
	applyGoalChange(state, create.change);
	const clear = planClear(state, { id: "goal-clear", revision: 1 }, 2);
	const folded = replayGoalBranch([custom(create.change), custom(clear.change)]);
	assert.equal(folded.goal, undefined);
	assert.equal(folded.roundsStarted, 0);
	assert.deepEqual(folded.lastRef, { id: "goal-clear", revision: 2 });

	const reused = structuredClone(create.change);
	reused.createdAt = 3;
	reused.updatedAt = 3;
	assert.throws(() => replayGoalBranch([custom(create.change), custom(clear.change), custom(reused)]), /fresh active/);
});

test("unsupported versions, operations, and extra fields fail replay", () => {
	const { create } = canonicalHistory();
	assert.throws(() => replayGoalBranch([custom({ ...create, version: 2 })]), /unsupported goal change version/);
	assert.throws(() => replayGoalBranch([custom({ ...create, operation: "archive" })]), /operation is invalid/);
	assert.throws(() => replayGoalBranch([custom({ ...create, extra: true })]), /must have exactly/);
});

test("snapshot shape, normalization, and blocker shape are strict", () => {
	const { create } = canonicalHistory();
	assert.throws(() => replayGoalBranch([custom({
		...create,
		goal: { ...create.goal, objective: " unnormalized " },
	})]), /normalized/);
	assert.throws(() => replayGoalBranch([custom({
		...create,
		goal: { ...create.goal, extra: true },
	})]), /must have exactly/);
	const blocked = {
		...create,
		operation: "create",
		goal: {
			...create.goal,
			phase: "blocked",
			blockedReason: { code: "Not Valid", message: "x" },
		},
	};
	assert.throws(() => replayGoalBranch([custom(blocked)]), /lower-kebab-case|fresh active/);
});

test("revision gaps and illegal phase transitions fail replay", () => {
	const state = emptyGoalFoldState();
	const create = planCreate(state, { objective: "x" }, "goal-transition", 1, 256);
	applyGoalChange(state, create.change);
	const pause = planPause(state, { id: "goal-transition", revision: 1 }, 2).change;
	assert.throws(() => replayGoalBranch([
		custom(create.change),
		custom({ ...pause, goal: { ...pause.goal, revision: 3 } }),
	]), /advance.*one revision/);
	assert.throws(() => replayGoalBranch([
		custom(create.change),
		custom({ ...pause, goal: { ...pause.goal, phase: "complete" } }),
	]), /pause has an invalid phase transition/);
});

test("counter and timestamp regressions fail replay", () => {
	const history = canonicalHistory();
	assert.throws(() => replayGoalBranch([
		custom(history.create),
		history.firstRound,
		custom({ ...history.edit, roundsStarted: 0 }),
	]), /preserve.*counters/);
	assert.throws(() => replayGoalBranch([
		custom(history.create),
		history.firstRound,
		custom({ ...history.edit, updatedAt: 9 }),
	]), /preserve.*timestamps|cannot precede/);
});

test("round admissions require exact identity, order, revision, cap, and prompt", () => {
	const { create } = canonicalHistory();
	const goal = create.goal;
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 2)]), /next admitted round/);
	assert.throws(() => replayGoalBranch([
		custom(create),
		roundAdmission(goal, 1),
		roundAdmission(goal, 1),
	]), /next admitted round/);
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 1, {
		goalId: "other",
	})]), /next admitted round/);
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 1, {
		content: "<goal_round>counterfeit</goal_round>",
	})]), /content does not match/);
});

test("round admission records are strict", () => {
	const { create } = canonicalHistory();
	const goal = create.goal;
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 1, {
		extra: true,
	})]), /must have exactly/);
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 1, {
		version: GOAL_ROUND_ADMISSION_VERSION + 1,
	})]), /unsupported goal round admission version/);
	assert.throws(() => replayGoalBranch([custom(create), roundAdmission(goal, 1, {
		kind: "not-an-admission",
	})]), /invalid kind/);
});

test("malformed recognized goal entries fail; unrelated custom entries do not", () => {
	assert.throws(() => replayGoalBranch([
		{ type: "custom", customType: GOAL_CHANGE_ENTRY, data: { kind: "not-goal" } },
	]), /invalid kind/);
	assert.throws(() => replayGoalBranch([
		{ type: "custom", customType: GOAL_ROUND_ADMISSION_ENTRY, data: { kind: "not-round" } },
	]), /must have exactly|invalid kind/);
	assert.doesNotThrow(() => replayGoalBranch([
		{ type: "custom", customType: "other", data: { anything: true } },
		{ type: "custom_message", customType: "other", details: { invalid: true } },
	]));
});

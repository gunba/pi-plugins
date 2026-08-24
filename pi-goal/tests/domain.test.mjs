import assert from "node:assert/strict";
import test from "node:test";

import {
	applyGoalChange,
	applyGoalRound,
	emptyGoalFoldState,
	goalView,
	planBlock,
	planClear,
	planComplete,
	planCreate,
	planEdit,
	planPause,
	planResume,
} from "../src/domain.ts";

function commit(state, planned) {
	applyGoalChange(state, planned.change);
	return planned.activation;
}

function created(options = {}) {
	const state = emptyGoalFoldState();
	const planned = planCreate(
		state,
		{ objective: options.objective ?? "ship verified support", maxGoalRounds: options.cap },
		options.id ?? "goal-1",
		options.now ?? 100,
		options.defaultCap ?? 256,
	);
	const activation = commit(state, planned);
	return { state, activation };
}

test("create normalizes the objective, applies defaults, and arms revision one", () => {
	const { state, activation } = created({ objective: "  finish the release  " });
	assert.deepEqual(goalView(state, activation), {
		id: "goal-1",
		revision: 1,
		objective: "finish the release",
		phase: "active",
		maxGoalRounds: 256,
		roundsStarted: 0,
		createdAt: 100,
		updatedAt: 100,
		activation: "armed",
	});
});

test("create validates objective and positive safe-integer caps", () => {
	const state = emptyGoalFoldState();
	assert.throws(() => planCreate(state, { objective: " " }, "goal-1", 1, 256), { code: "GOAL_INVALID_OBJECTIVE" });
	for (const cap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => planCreate(state, { objective: "x", maxGoalRounds: cap }, "goal-1", 1, 256), {
			code: "GOAL_INVALID_MAX_ROUNDS",
		});
	}
});

test("unfinished goals cannot be replaced; complete goals can", () => {
	const { state } = created();
	assert.throws(() => planCreate(state, { objective: "replacement" }, "goal-2", 101, 256), {
		code: "GOAL_ALREADY_EXISTS",
	});
	commit(state, planComplete(state, { id: "goal-1", revision: 1 }, 102));
	commit(state, planCreate(state, { objective: "replacement" }, "goal-2", 103, 256));
	assert.equal(state.goal.id, "goal-2");
	assert.equal(state.goal.revision, 1);
});

test("compare-and-set rejects stale IDs and revisions", () => {
	const { state } = created();
	assert.throws(() => planEdit(state, { id: "other", revision: 1 }, { objective: "x" }, 101, "armed"), {
		code: "GOAL_STALE_REVISION",
	});
	const edit = planEdit(state, { id: "goal-1", revision: 1 }, { objective: "new" }, 101, "armed");
	commit(state, edit);
	assert.throws(() => planPause(state, { id: "goal-1", revision: 1 }, 102), {
		code: "GOAL_STALE_REVISION",
	});
});

test("edit preserves phase, blocker, counters, and activation", () => {
	const { state } = created({ cap: 4 });
	applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 1 });
	commit(state, planBlock(
		state,
		{ id: "goal-1", revision: 1 },
		{ code: "needs-input", message: "A decision is required." },
		101,
	));
	const planned = planEdit(
		state,
		{ id: "goal-1", revision: 2 },
		{ objective: "revised", maxGoalRounds: 1 },
		102,
		"disarmed",
	);
	commit(state, planned);
	assert.deepEqual(state.goal.blockedReason, { code: "needs-input", message: "A decision is required." });
	assert.equal(state.goal.phase, "blocked");
	assert.equal(state.roundsStarted, 1);
	assert.equal(planned.activation, "disarmed");
});

test("edit requires at least one replacement", () => {
	const { state } = created();
	assert.throws(() => planEdit(state, { id: "goal-1", revision: 1 }, {}, 101, "armed"), {
		code: "GOAL_INVALID_EDIT",
	});
});

test("phase transitions follow the exact lifecycle", () => {
	const { state } = created();
	let activation = commit(state, planPause(state, { id: "goal-1", revision: 1 }, 101));
	assert.deepEqual([state.goal.phase, activation, state.goal.revision], ["paused", "disarmed", 2]);
	activation = commit(state, planResume(state, { id: "goal-1", revision: 2 }, 102, activation));
	assert.deepEqual([state.goal.phase, activation, state.goal.revision], ["active", "armed", 3]);
	activation = commit(state, planBlock(
		state,
		{ id: "goal-1", revision: 3 },
		{ code: "upstream-unavailable", message: "  Provider unavailable.  " },
		103,
	));
	assert.equal(state.goal.blockedReason.message, "Provider unavailable.");
	activation = commit(state, planResume(state, { id: "goal-1", revision: 4 }, 104, activation));
	activation = commit(state, planComplete(state, { id: "goal-1", revision: 5 }, 105));
	assert.deepEqual([state.goal.phase, activation, state.goal.revision], ["complete", "disarmed", 6]);
});

test("invalid or redundant transitions fail", () => {
	const { state } = created();
	assert.throws(() => planResume(state, { id: "goal-1", revision: 1 }, 101, "armed"), {
		code: "GOAL_INVALID_TRANSITION",
	});
	commit(state, planPause(state, { id: "goal-1", revision: 1 }, 101));
	assert.throws(() => planPause(state, { id: "goal-1", revision: 2 }, 102), {
		code: "GOAL_INVALID_TRANSITION",
	});
	assert.throws(() => planBlock(state, { id: "goal-1", revision: 2 }, { code: "x", message: "x" }, 102), {
		code: "GOAL_INVALID_TRANSITION",
	});
});

test("resume rejects exhausted budgets until an edit raises the cap", () => {
	const { state } = created({ cap: 1 });
	applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 1 });
	commit(state, planBlock(state, { id: "goal-1", revision: 1 }, { code: "round-limit", message: "Limit." }, 101));
	assert.throws(() => planResume(state, { id: "goal-1", revision: 2 }, 102, "disarmed"), {
		code: "GOAL_INVALID_TRANSITION",
	});
	commit(state, planEdit(state, { id: "goal-1", revision: 2 }, { maxGoalRounds: 2 }, 103, "disarmed"));
	commit(state, planResume(state, { id: "goal-1", revision: 3 }, 104, "disarmed"));
	assert.equal(state.goal.phase, "active");
});

test("round admission is sequential and does not change revision or update time", () => {
	const { state } = created({ cap: 2 });
	applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 1 });
	assert.deepEqual([state.roundsStarted, state.goal.revision, state.updatedAt], [1, 1, 100]);
	assert.throws(() => applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 1 }), /next admitted round/);
	assert.throws(() => applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 3 }), /next admitted round/);
	applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 2 });
	assert.throws(() => applyGoalRound(state, { goalId: "goal-1", revision: 1, round: 3 }), /next admitted round/);
});

test("block reasons require lower-kebab-case and nonblank messages", () => {
	for (const reason of [
		{ code: "Not Canonical", message: "x" },
		{ code: "", message: "x" },
		{ code: "valid", message: " " },
	]) {
		const { state } = created();
		assert.throws(() => planBlock(state, { id: "goal-1", revision: 1 }, reason, 101), {
			code: "GOAL_INVALID_BLOCK_REASON",
		});
	}
});

test("mutation and clear timestamps clamp backward clock movement", () => {
	const { state } = created({ now: 100 });
	commit(state, planPause(state, { id: "goal-1", revision: 1 }, 90));
	assert.equal(state.updatedAt, 100);
	const clear = planClear(state, { id: "goal-1", revision: 2 }, 80);
	assert.equal(clear.change.clearedAt, 100);
	commit(state, clear);
	assert.equal(state.goal, undefined);
	assert.deepEqual(state.lastRef, { id: "goal-1", revision: 3 });
});

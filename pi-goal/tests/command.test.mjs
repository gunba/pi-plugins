import assert from "node:assert/strict";
import test from "node:test";

import {
	executeGoalCommand,
	GOAL_USAGE,
	parseGoalCommand,
	renderGoal,
} from "../src/command.ts";
import { GoalError } from "../src/domain.ts";

function view(overrides = {}) {
	return {
		id: "goal-1",
		revision: 1,
		objective: "ship",
		phase: "active",
		maxGoalRounds: 256,
		roundsStarted: 0,
		createdAt: 1,
		updatedAt: 1,
		activation: "armed",
		...overrides,
	};
}

function operations(initial) {
	let current = initial;
	const calls = [];
	return {
		calls,
		get current() { return current; },
		api: {
			get: () => current,
			create(request) {
				calls.push(["create", request]);
				current = view({ objective: request.objective.trim(), id: `goal-${calls.length}` });
				return current;
			},
			edit(ref, request) {
				calls.push(["edit", ref, request]);
				current = { ...current, objective: request.objective.trim(), revision: current.revision + 1 };
				return current;
			},
			pause(ref) {
				calls.push(["pause", ref]);
				current = { ...current, phase: "paused", revision: current.revision + 1, activation: "disarmed" };
				return current;
			},
			resume(ref) {
				calls.push(["resume", ref]);
				current = { ...current, phase: "active", revision: current.revision + 1, activation: "armed" };
				return current;
			},
			clear(ref) {
				calls.push(["clear", ref]);
				current = undefined;
				return { id: ref.id, revision: ref.revision + 1 };
			},
		},
	};
}

test("parser owns only exact control words", () => {
	assert.deepEqual(parseGoalCommand(" \n "), { kind: "show" });
	assert.deepEqual(parseGoalCommand(" CLEAR "), { kind: "clear" });
	assert.deepEqual(parseGoalCommand("PaUsE"), { kind: "pause" });
	assert.deepEqual(parseGoalCommand(" resume "), { kind: "resume" });
	assert.deepEqual(parseGoalCommand("edit"), { kind: "invalid-edit" });
	assert.deepEqual(parseGoalCommand("EDIT\n next objective "), { kind: "edit", objective: "next objective" });
	assert.deepEqual(parseGoalCommand("pause after verification"), {
		kind: "create",
		objective: "pause after verification",
	});
});

test("empty status and invalid edit use exact text", () => {
	const empty = operations(undefined);
	assert.deepEqual(executeGoalCommand("", empty.api), {
		kind: "success",
		text: `No goal is currently set.\n${GOAL_USAGE}`,
	});
	assert.deepEqual(executeGoalCommand(" edit ", empty.api), {
		kind: "error",
		text: `Goal editing requires a replacement objective.\n${GOAL_USAGE}`,
	});
});

test("rendering includes phase, blocker, objective, rounds, activation, and state hints", () => {
	assert.equal(renderGoal("Goal", view()).text, [
		"Goal",
		"Status: active",
		"Objective: ship",
		"Rounds: 0/256",
		"Activation: armed",
		"",
		"Commands: /goal edit <objective>, /goal pause, /goal clear",
	].join("\n"));
	const blocked = renderGoal("Goal", view({
		phase: "blocked",
		blockedReason: { code: "needs-input", message: "Choose one." },
		activation: "disarmed",
	}));
	assert.match(blocked.text, /Blocker: needs-input: Choose one\./);
	assert.match(blocked.text, /\/goal resume/);
	assert.match(renderGoal("Goal", view({ phase: "complete", activation: "disarmed" })).text, /Commands: \/goal <objective>, \/goal clear/);
});

test("unfinished replacement is refused without mutation", () => {
	const state = operations(view());
	assert.deepEqual(executeGoalCommand("replacement", state.api), {
		kind: "error",
		text: "A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.",
	});
	assert.deepEqual(state.calls, []);
});

test("edit updates unfinished work and creates after completion", () => {
	const active = operations(view());
	assert.match(executeGoalCommand("edit new", active.api).text, /^Goal updated/m);
	assert.deepEqual(active.calls[0], ["edit", { id: "goal-1", revision: 1 }, { objective: "new" }]);

	const complete = operations(view({ phase: "complete", activation: "disarmed" }));
	assert.match(executeGoalCommand("edit fresh", complete.api).text, /^Goal created/m);
	assert.equal(complete.calls[0][0], "create");
});

test("missing pause, resume, edit, and clear have stable results", () => {
	const empty = operations(undefined);
	for (const action of ["pause", "resume"]) {
		assert.deepEqual(executeGoalCommand(action, empty.api), {
			kind: "error",
			text: `No goal is currently set; /goal ${action} requires one. ${GOAL_USAGE}`,
		});
	}
	assert.match(executeGoalCommand("edit x", empty.api).text, /\/goal edit requires one/);
	assert.deepEqual(executeGoalCommand("clear", empty.api), { kind: "success", text: "No goal to clear." });
});

test("pause, resume, and clear use the exact current ref", () => {
	const state = operations(view());
	assert.match(executeGoalCommand("pause", state.api).text, /^Goal paused/m);
	assert.match(executeGoalCommand("resume", state.api).text, /^Goal resumed/m);
	assert.deepEqual(executeGoalCommand("clear", state.api), { kind: "success", text: "Goal cleared." });
	assert.deepEqual(state.calls.map((call) => call[0]), ["pause", "resume", "clear"]);
});

test("domain errors collapse to the stable command-state error", () => {
	const state = operations(view());
	state.api.pause = () => { throw new GoalError("bad transition", "GOAL_INVALID_TRANSITION"); };
	assert.deepEqual(executeGoalCommand("pause", state.api), {
		kind: "error",
		text: "The goal command is not valid for the current state. Run /goal to view available commands.",
	});
});

test("unexpected implementation errors remain fail-loud", () => {
	const state = operations(view());
	state.api.get = () => { throw new Error("unexpected"); };
	assert.throws(() => executeGoalCommand("", state.api), /unexpected/);
});

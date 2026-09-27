import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PlanStore, PlanStateError } from "../src/store.ts";
import { PLAN_CHANGE_ENTRY, PLAN_IMPORT_ENTRY, PLAN_ROUND_ADMISSION_ENTRY } from "../src/constants.ts";
import { replayPlanBranch } from "../src/replay.ts";
import { renderPlanRoundPrompt } from "../src/prompt.ts";
import { planSteps } from "../src/steps.ts";

const steps = [{ content: "Inspect source", status: "in_progress" }, { content: "Verify", status: "pending" }];
function harness(manager = SessionManager.inMemory()) {
	let id = 0, now = 100;
	const pi = { appendEntry: (type, data) => manager.appendCustomEntry(type, data) };
	const store = new PlanStore(pi, { newId: () => `plan-${++id}`, now: () => ++now });
	return { manager, pi, store, branch: () => manager.getBranch() };
}
function ref(plan) { return { id: plan.id, revision: plan.revision }; }
function legacyCreate(h, overrides = {}) {
	h.pi.appendEntry("pi-goal-change/v1", { kind: "goal/change", version: 1, operation: "create",
		goal: { id: "goal-existing", revision: 1, objective: "Deliver the project", phase: "active", maxGoalRounds: 8, ...overrides },
		roundsStarted: 0, createdAt: 1, updatedAt: 1 });
}
function legacyAdmission(h) {
	h.pi.appendEntry("pi-goal-round-admission/v1", {
		kind: "goal/round-admission", version: 1, goalId: "goal-existing", revision: 1, round: 1,
		content: [
			"<goal_round>", 'Objective: "Deliver the project"', "Round: 1/8", "",
			"Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.",
			"</goal_round>",
		].join("\n"),
	});
}

test("one manual plan retains steps across native turns and branch restoration", () => {
	const h = harness();
	const original = structuredClone(steps), created = h.store.create({ objective: "Deliver the project", steps: original });
	assert.equal(created.autoContinue, false); assert.equal(created.activation, "disarmed");
	const first = h.manager.getLeafId();
	original[0].content = "mutated input"; created.steps[0].content = "mutated result";
	h.manager.appendMessage({ role: "user", content: "Continue", timestamp: 1 });
	h.manager.appendCustomEntry("unrelated-state", {});
	h.store.reconcile(h.branch());
	assert.deepEqual(h.store.get().steps, steps);
	assert.throws(() => h.store.admitRound({ planId: created.id, revision: 1, round: 1 }, ""), /disarmed/);
	const edited = h.store.edit(ref(created), { steps: steps.map(step => ({ ...step, status: "completed" })) });
	assert.equal(edited.revision, 2); assert.equal(edited.activation, "disarmed");
	h.manager.branch(first); h.store.restore(h.branch());
	assert.equal(h.store.get().revision, 1); assert.deepEqual(h.store.get().steps, steps);
	assert.equal(h.store.get().activation, "disarmed");
});

test("steps and continuation use one exact revision; ordinary edits never silently arm restored work", () => {
	const h = harness(), created = h.store.create({ objective: "Ship", steps });
	assert.throws(() => h.store.complete(ref(created)), /remaining steps/);
	assert.equal(h.branch().length, 1, "invalid completion never appends a corrupt transition");
	const enabled = h.store.edit(ref(created), { autoContinue: true });
	assert.equal(enabled.activation, "armed");
	assert.throws(() => h.store.edit(ref(created), { objective: "stale edit" }), /current id and revision/);
	const identity = { planId: enabled.id, revision: enabled.revision, round: 1 };
	h.store.admitRound(identity, renderPlanRoundPrompt(enabled, 1));
	h.store.restore(h.branch());
	assert.equal(h.store.get().roundsStarted, 1); assert.equal(h.store.get().activation, "disarmed");
	const edited = h.store.edit(ref(h.store.get()), { objective: "Ship safely" });
	assert.equal(edited.activation, "disarmed");
	const resumed = h.store.resume(ref(edited));
	assert.equal(resumed.activation, "armed");
	const manual = h.store.edit(ref(resumed), { autoContinue: false });
	assert.equal(manual.activation, "disarmed"); assert.deepEqual(manual.steps, steps);
	const paused = h.store.pause(ref(manual)), unpaused = h.store.resume(ref(paused));
	assert.equal(unpaused.autoContinue, false); assert.equal(unpaused.activation, "disarmed");
	const finished = h.store.edit(ref(unpaused), { steps: steps.map(step => ({ ...step, status: "completed" })) });
	assert.equal(h.store.complete(ref(finished)).phase, "complete");
});

test("legacy goal identity, admitted rounds and current task list import once into the selected native branch", () => {
	const h = harness(); legacyCreate(h); legacyAdmission(h);
	h.pi.appendEntry("pi-todo-write", { todos: steps });
	const prefix = h.manager.getLeafId(), before = structuredClone(h.branch());
	h.store.restore(h.branch());
	const plan = h.store.get();
	assert.deepEqual(ref(plan), { id: "goal-existing", revision: 1 });
	assert.equal(plan.roundsStarted, 1); assert.equal(plan.autoContinue, true); assert.equal(plan.activation, "disarmed");
	assert.deepEqual(plan.steps, steps);
	assert.deepEqual(h.branch().slice(0, before.length), before, "legacy records are not rewritten or frozen in place");
	assert.equal(h.branch().filter(entry => entry.customType === PLAN_IMPORT_ENTRY).length, 1);
	h.store.restore(h.branch());
	assert.equal(h.branch().filter(entry => entry.customType === PLAN_IMPORT_ENTRY).length, 1);
	const resumed = h.store.resume(ref(plan));
	h.store.admitRound({ planId: resumed.id, revision: resumed.revision, round: 2 }, renderPlanRoundPrompt(resumed, 2));
	h.store.restore(h.branch());
	assert.equal(h.store.get().roundsStarted, 2);
	h.manager.branch(prefix); h.store.restore(h.branch());
	assert.equal(h.store.get().roundsStarted, 1);
	assert.equal(h.branch().filter(entry => entry.customType === PLAN_IMPORT_ENTRY).length, 1, "a sibling branch has its own cutover");
});

test("todo-only import is a manual plan and respects old clears without reviving a previous task", () => {
	const h = harness();
	h.pi.appendEntry("pi-todo-write", { todos: steps });
	const prefix = h.manager.getLeafId();
	h.store.restore(h.branch());
	const imported = h.store.get();
	assert.equal(imported.objective, "Session plan"); assert.equal(imported.autoContinue, false);
	h.store.restore(h.branch()); assert.equal(h.store.get().id, imported.id);
	h.manager.branch(prefix); h.pi.appendEntry("pi-todo-turn-start", {});
	h.store.restore(h.branch()); assert.equal(h.store.get(), undefined);
	const fresh = h.store.create({ objective: "Next task" });
	assert.deepEqual(fresh.steps, []); assert.equal(fresh.autoContinue, false);
});

test("native fork label re-chaining preserves the imported plan identity and disarms continuation", () => {
	const h = harness(), entry = h.manager.appendMessage({ role: "user", content: "Task", timestamp: 1 });
	h.manager.appendLabelChange(entry, "Start");
	h.pi.appendEntry("pi-todo-write", { todos: steps });
	h.store.restore(h.branch());
	const imported = h.store.get();
	h.store.edit(ref(imported), { autoContinue: true });
	h.manager.createBranchedSession(h.manager.getLeafId());
	h.store.restore(h.branch());
	assert.equal(h.store.get().id, imported.id);
	assert.equal(h.store.get().revision, 2);
	assert.equal(h.store.get().activation, "disarmed");
	assert.deepEqual(h.store.get().steps, steps);
});

test("corrupt legacy state, altered checkpoints and retired writers fail closed", () => {
	const h = harness(); legacyCreate(h); legacyAdmission(h);
	const legacy = structuredClone(h.branch());
	legacy[1].data.round = 2;
	const corrupt = harness();
	corrupt.store.restore(legacy);
	assert.throws(() => corrupt.store.get(), PlanStateError); assert.equal(corrupt.branch().length, 0);
	h.store.restore(h.branch());
	const branch = structuredClone(h.branch());
	branch.at(-1).data.plan.objective = "Different objective";
	assert.throws(() => replayPlanBranch(branch), /does not match/);
	h.pi.appendEntry("pi-todo-turn-start", {});
	h.store.reconcile(h.branch());
	assert.throws(() => h.store.get(), /retired goal\/todo writer/);
	assert.equal(h.store.currentActivation, "disarmed");
});

test("manual or duplicate/forged automatic admissions cannot consume rounds", () => {
	const h = harness(), plan = h.store.create({ objective: "Check", autoContinue: true, maxRounds: 1 });
	const identity = { planId: plan.id, revision: plan.revision, round: 1 }, content = renderPlanRoundPrompt(plan, 1);
	assert.throws(() => h.store.admitRound(identity, content + "\nchanged"), /does not match/);
	h.store.admitRound(identity, content);
	assert.throws(() => h.store.admitRound(identity, content), /next admitted round/);
	assert.throws(() => h.store.admitRound({ ...identity, round: 2 }, renderPlanRoundPrompt(plan, 2)), /next admitted round/);
	const manual = h.store.edit(ref(h.store.get()), { autoContinue: false });
	const branch = [...h.branch(), { type: "custom", customType: PLAN_ROUND_ADMISSION_ENTRY,
		data: { kind: "plan/round-admission", version: 1, planId: manual.id, revision: manual.revision, round: 2,
			content: renderPlanRoundPrompt(manual, 2) } }];
	assert.throws(() => replayPlanBranch(branch), /next admitted round/);
});

test("a failed native append leaves the prior plan intact; clear retains revision and identity history", () => {
	const h = harness(), plan = h.store.create({ objective: "Check" });
	const stored = h.branch().at(-1);
	const store = new PlanStore({ appendEntry() { throw Error("disk failure"); } });
	store.restore(h.branch());
	assert.throws(() => store.edit(ref(plan), { steps }), /disk failure/);
	assert.deepEqual(store.get().steps, []); assert.equal(store.get().revision, 1);
	h.store.clear(ref(plan)); assert.equal(h.store.get(), undefined);
	assert.equal(h.branch().at(-1).data.cleared.revision, 2);
	assert.throws(() => replayPlanBranch([...h.branch(), { type: "custom", customType: PLAN_CHANGE_ENTRY, data: stored.data }]), /fresh active/);
});

test("steps preserve control characters and reject coercion or duplicate normalized content; prompts stay bounded", () => {
	const h = harness();
	const content = "Inspect\n\u001b[31m source", plan = h.store.create({ objective: "Check", steps: [{ content, status: "in_progress" }] });
	assert.equal(plan.steps[0].content, content); assert.equal(h.branch()[0].data.plan.steps[0].content, content);
	assert.throws(() => planSteps([{ content: 3, status: "pending" }], true), /string/);
	assert.throws(() => planSteps([{ content: "a", status: "pending" }, { content: " a ", status: "pending" }], true), /duplicate/);
	assert.throws(() => planSteps([{ content: "a", status: "pending", extra: true }]), /content and status/);
	const large = h.store.edit(ref(plan), { steps: Array.from({ length: 100 }, (_, i) => ({ content: `${i}: ${"x".repeat(1000)}`, status: "in_progress" })) });
	assert.ok(renderPlanRoundPrompt(large, 1).length < 2200);
});

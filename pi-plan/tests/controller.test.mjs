import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";
import { preparePlanArguments } from "../src/tools.ts";
import { PLAN_READ } from "../extensions/plan.ts";
import { DeskPresentation } from "../../pi-desk/src/host/presentation.ts";
import { PRESENTATION_DISCOVER } from "../../pi-ui/index.ts";

const read = async h => { const probe = {}; h.events.emit(PLAN_READ, probe); return probe.plan; };
const create = (h, options = {}) => executeTool(h, "create_plan", { objective: "Finish", auto_continue: true, ...options });
const update = (h, args) => executeTool(h, "update_plan", args);
const settled = async (h, reason = "stop") => {
	await h.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: reason }] });
	await h.emit("agent_settled");
};

test("manual checklists survive turns and share one terminal work section", async () => {
	const h = createExtensionHarness(); await h.start();
	await executeTool(h, "create_plan", { objective: "Review\u001b[2J code", steps: [{ content: "Read files", status: "in_progress" }] });
	await h.directInput("Next turn"); await settled(h);
	assert.equal(h.sentMessages.length, 0); assert.equal((await read(h)).steps.length, 1);
	const lines = h.widgets.get("pi-work")({ terminal: { rows: 40 }, requestRender() {} }, h.theme).render(150).join("\n");
	assert.match(lines, /Plan active.*manual/); assert.match(lines, /Read files/); assert.doesNotMatch(lines, /\x1b/);
	assert.deepEqual([...h.tools.keys()].filter(name => /plan|goal|todo/.test(name)), ["create_plan", "update_plan"]);
	await h.emit("session_shutdown");
});

test("human queues, active watches and in-flight reservations gate automatic continuation", async () => {
	const h = createExtensionHarness({ pending: true }); await h.start(); await create(h, { max_rounds: 2 });
	assert.equal(h.sentMessages.length, 0);
	h.setPending(false); await settled(h); assert.equal(h.sentMessages.length, 1);
	await read(h); await read(h); assert.equal(h.sentMessages.length, 1);
	await h.admitLastRound();
	// pi-watch's registry: a conversation with an active watch is waiting on purpose.
	const watching = globalThis[Symbol.for("gunba.pi-watch.v1")], id = h.ctx.sessionManager.getSessionId();
	watching.set(id, 1);
	await settled(h); assert.equal(h.sentMessages.length, 1);
	watching.delete(id); await settled(h); assert.equal(h.sentMessages.length, 2);
	await h.admitLastRound(); await settled(h);
	const current = await read(h);
	assert.equal(current.phase, "blocked"); assert.equal(current.blockedReason.code, "round-limit");
	assert.equal(current.roundsStarted, 2);
	await h.emit("session_shutdown");
});

test("errors, cancellation, tree changes and missing admissions suppress extra rounds", async () => {
	for (const reason of ["error", "length", "aborted"]) {
		const h = createExtensionHarness(); await h.start(); await create(h); await h.admitLastRound();
		await settled(h, reason);
		assert.equal(h.sentMessages.length, 1); assert.equal((await read(h)).activation, "disarmed");
		assert.equal((await read(h)).phase, reason === "aborted" ? "paused" : "active");
		await h.emit("session_shutdown");
	}
	const h = createExtensionHarness(); await h.start(); await create(h);
	await settled(h); assert.equal(h.sentMessages.length, 1); assert.equal((await read(h)).activation, "disarmed");
	await h.emit("session_tree"); await settled(h); assert.equal(h.sentMessages.length, 1);
	await h.emit("session_shutdown");
	await assert.rejects(update(h, { action: "pause" }), /retired session/);
});

test("admission is independent of visible context; blocker threshold and completion wrap-up remain", async () => {
	const h = createExtensionHarness({ persistSentMessages: false }); await h.start(); await create(h);
	await h.admitLastRound();
	await assert.rejects(update(h, { action: "blocked", blocked_reason: "Missing access" }), /at least 3/);
	await update(h, { action: "edit", steps: [{ content: "Verify", status: "completed" }] });
	await update(h, { action: "complete" });
	assert.equal((await read(h)).roundsStarted, 1);
	const context = await h.emit("context", { messages: [] });
	assert.match(context.find(Boolean).messages.at(-1).content[0].text, /Automatic continuation has stopped/);
	await settled(h); assert.equal(h.sentMessages.length, 1);
	await h.emit("session_shutdown");
});

test("managed children own their plan but never start a second continuation driver", async () => {
	const h = createExtensionHarness({ managedChild: true }); await h.start(); await create(h);
	await settled(h); assert.equal(h.sentMessages.length, 0);
	await update(h, { action: "edit", steps: [{ content: "Child work", status: "pending" }] });
	assert.equal((await read(h)).steps[0].content, "Child work");
	await h.emit("session_shutdown");
});

test("native UI editing keeps continuation idle and rejects a result from a retired branch", async () => {
	const h = createExtensionHarness({ pending: true }), remote = new DeskPresentation(() => {}, () => {});
	// The normal discovery bus is also used by terminal-only test contexts.
	const originalStart = h.start;
	h.ctx.ui.editor = () => new Promise(resolve => { h.resolveEditor = resolve; });
	h.ctx.ui.select = async () => "Off · manual checklist";
	h.ctx.ui.confirm = async () => true;
	// Harness exposes the real event facade for presentation discovery.
	h.events.on(PRESENTATION_DISCOVER, probe => { probe.presentation = remote; });
	await originalStart(); await create(h);
	h.setPending(false);
	const view = remote.snapshot().views.find(view => view.id === "plan");
	await remote.act(view.id, view.revision, "objective", null);
	await new Promise(setImmediate); await settled(h);
	assert.equal(h.sentMessages.length, 0, "human edit blocks the continuation driver");
	await h.emit("session_tree");
	h.resolveEditor("Wrong branch");
	await new Promise(setImmediate);
	assert.equal((await read(h)).objective, "Finish");
	assert.match(remote.snapshot().views.find(view => view.id === "plan").actionError ?? "", /session changed/i);
	await h.emit("session_shutdown");
});

test("tool argument preparation rejects coercion and invalid conditional fields", async () => {
	for (const input of [{ objective: 7 }, { steps: [{ content: false, status: "pending" }] }, { auto_continue: "true" }, { max_rounds: "3" }])
		assert.throws(() => preparePlanArguments(input));
	const h = createExtensionHarness(); await h.start(); await create(h, { auto_continue: false });
	await assert.rejects(update(h, { action: "edit", blocked_reason: "not editing" }), /only valid with action blocked/);
	await h.emit("session_shutdown");
});

test("complete records open steps; definition fields apply with any action; create supersedes an unfinished plan", async () => {
	// In two weeks of sessions, 27 update_plan calls failed as completions with open steps, 9 as definition fields sent
	// with pause, resume or blocked, and 15 create_plan calls as an unfinished plan already existing.
	const h = createExtensionHarness({ persistSentMessages: false }); await h.start();
	await executeTool(h, "create_plan", { objective: "Ship", steps: [{ content: "Build", status: "in_progress" }] });
	await update(h, { action: "pause", objective: "Ship it", steps: [{ content: "Build", status: "completed" }, { content: "Release", status: "pending" }] });
	let plan = await read(h);
	assert.equal(plan.phase, "paused"); assert.equal(plan.objective, "Ship it");
	assert.deepEqual(plan.steps.map(step => step.status), ["completed", "pending"]);
	await update(h, { action: "complete" });
	plan = await read(h);
	assert.equal(plan.phase, "complete");
	assert.deepEqual(plan.steps.map(step => step.status), ["completed", "pending"]);
	await executeTool(h, "create_plan", { objective: "Next", steps: [{ content: "Plan", status: "pending" }] });
	await executeTool(h, "create_plan", { objective: "Replacement", steps: [{ content: "Do", status: "in_progress" }] });
	plan = await read(h);
	assert.equal(plan.objective, "Replacement"); assert.equal(plan.phase, "active"); assert.equal(plan.revision, 1);
	const changes = h.branch.filter(entry => entry.customType === "pi-plan-change/v1").map(entry => [entry.data.operation, entry.data.plan?.objective]);
	assert.deepEqual(changes.slice(-3), [["create", "Next"], ["complete", "Next"], ["create", "Replacement"]]);
	await h.emit("session_shutdown");
});

test("an edit that changes nothing, or a resume of a running plan, returns the plan without a new revision", async () => {
	// In a week of sessions, 6 update_plan calls failed as empty edits (models looking at the plan) and 8 as resumes.
	const h = createExtensionHarness({ persistSentMessages: false }); await h.start();
	await create(h, { auto_continue: false, steps: [{ content: "Build", status: "in_progress" }] });
	const before = await read(h);
	const shown = JSON.parse((await update(h, { action: "edit" })).content[0].text);
	assert.equal(shown.plan.revision, before.revision);
	assert.equal(JSON.parse((await update(h, { action: "resume" })).content[0].text).plan.revision, before.revision);
	assert.equal((await read(h)).revision, before.revision);
	await h.emit("session_shutdown");
});

test("an active plan untouched for 25 of the model's tool calls is recalled in the next result, and again while it stays untouched", async () => {
	// Past 300k tokens of context the gap between plan updates doubled: nothing showed the model its plan but its own old calls.
	const h = createExtensionHarness(); await h.start();
	await executeTool(h, "create_plan", { objective: "Ship the fix", steps: [{ content: "Write it", status: "completed" }, { content: "Test it", status: "in_progress" }, { content: "Release it", status: "pending" }] });
	const plan = await read(h);
	const call = async (extra = {}) => (await h.emit("tool_result", { toolName: "bash", toolCallId: `c${Math.random()}`, content: [{ type: "text", text: "ok" }], isError: false, ...extra }))
		.find(result => result !== undefined);
	for (let index = 1; index < 25; index++) assert.equal(await call(), undefined, `no reminder after ${index} calls`);
	assert.equal(await call({ parentToolCallId: "script" }), undefined, "a script's own calls do not count");
	const nudged = await call({ structuredContent: { output: "ok" } });
	assert.equal(nudged.content[0].text, "ok", "the result itself is kept");
	assert.equal(nudged.content[1].text, `\n[Plan check] 25 tool calls since the plan was last updated. 1 of 3 steps are marked done; current: "Test it". Compare that with the work so far and, if it is behind, update the plan now with update_plan.`);
	assert.deepEqual(nudged.structuredContent, { output: "ok" }, "its structured form is kept");
	// An update starts the count again; a plan left alone is recalled every 25 calls.
	await update(h, { action: "edit", steps: [{ content: "Test it", status: "completed" }, { content: "Release it", status: "in_progress" }] });
	await h.emit("tool_result", { toolName: "update_plan", toolCallId: "u", content: [], isError: false });
	for (let index = 1; index < 25; index++) assert.equal(await call(), undefined);
	assert.match((await call()).content[1].text, /^\n\[Plan check\] 25 tool calls .* 1 of 2 steps are marked done; current: "Release it"/);
	for (let index = 1; index < 25; index++) await call();
	assert.match((await call()).content[1].text, /^\n\[Plan check\] 50 tool calls/);
	// A paused plan is not recalled.
	await update(h, { action: "pause" });
	for (let index = 0; index < 30; index++) assert.equal(await call(), undefined);
	await h.emit("session_shutdown");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";
import { getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { preparePlanArguments } from "../src/tools.ts";
import { DeskPresentation } from "../../pi-desk/src/host/presentation.ts";
import { PRESENTATION_DISCOVER } from "../../pi-ui/index.ts";

const read = async h => (await executeTool(h, "get_plan")).details.plan;
const create = (h, options = {}) => executeTool(h, "create_plan", { objective: "Finish", auto_continue: true, ...options });
const update = async (h, args) => { const plan = await read(h); return executeTool(h, "update_plan", { plan_id: plan.id, revision: plan.revision, ...args }); };
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
	assert.deepEqual([...h.tools.keys()].filter(name => /plan|goal|todo/.test(name)), ["get_plan", "create_plan", "update_plan"]);
	await h.emit("session_shutdown");
});

test("human queues, explicit waits and in-flight reservations gate automatic continuation", async () => {
	const h = createExtensionHarness({ pending: true }); await h.start(); await create(h, { max_rounds: 2 });
	assert.equal(h.sentMessages.length, 0);
	h.setPending(false); await settled(h); assert.equal(h.sentMessages.length, 1);
	await read(h); await read(h); assert.equal(h.sentMessages.length, 1);
	await h.admitLastRound();
	const coordinator = getWorkCoordinator(h.ctx.sessionManager.getSessionId());
	coordinator.register({ kind: "process", id: "test" });
	coordinator.begin([{ kind: "process", id: "test" }], "all");
	await settled(h); assert.equal(h.sentMessages.length, 1);
	coordinator.cancel("test"); await settled(h); assert.equal(h.sentMessages.length, 2);
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
	await assert.rejects(read(h), /retired session/);
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
	await assert.rejects(update(h, { action: "pause", steps: [] }), /only valid with action edit/);
	await assert.rejects(update(h, { action: "edit", blocked_reason: "not editing" }), /only valid with action blocked/);
	await h.emit("session_shutdown");
});

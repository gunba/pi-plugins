import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import {
	GOAL_CHANGE_ENTRY,
	GOAL_COMMAND_ENTRY,
	GOAL_ROUND_ADMISSION_ENTRY,
	GOAL_ROUND_MESSAGE,
} from "../src/constants.ts";
import {
	emptyGoalFoldState,
	planCreate,
} from "../src/domain.ts";
import {
	createExtensionHarness,
	executeTool,
	textOf,
} from "./helpers.mjs";

function successfulAgentMessages() {
	return [{ role: "assistant", content: [], stopReason: "stop" }];
}

test("extension registers the exact command, three sequential tools, and presentation renderers", () => {
	const harness = createExtensionHarness();
	assert.deepEqual([...harness.commands.keys()], ["goal"]);
	assert.deepEqual([...harness.tools.keys()], ["wait_for_work", "cancel_work_wait", "get_goal", "create_goal", "update_goal"]);
	const goalTools = ["get_goal", "create_goal", "update_goal"].map((name) => harness.tools.get(name));
	for (const tool of goalTools) assert.equal(tool.executionMode, "sequential");
	assert.equal(harness.entryRenderers.has(GOAL_COMMAND_ENTRY), true);
	assert.equal(harness.messageRenderers.has(GOAL_ROUND_MESSAGE), true);
	const goalGuidelines = goalTools.map((tool) => tool.promptGuidelines);
	assert.equal(goalGuidelines.every((guidelines) => guidelines?.length === 1), true);
	assert.equal(new Set(goalGuidelines.map((guidelines) => guidelines[0])).size, 1);
	assert.match(goalGuidelines[0][0], /at least 3 consecutive goal rounds/);

	const update = harness.tools.get("update_goal");
	assert.equal(update.parameters.additionalProperties, false);
	assert.deepEqual(update.parameters.required.sort(), ["action", "goal_id", "revision"]);
});

test("goal policy survives active-tool filtering without get_goal", () => {
	const harness = createExtensionHarness();
	for (const toolName of ["create_goal", "update_goal"]) {
		const tool = harness.tools.get(toolName);
		const prompt = buildSystemPrompt({
			cwd: "C:/workspace",
			selectedTools: [toolName],
			toolSnippets: { [toolName]: tool.promptSnippet },
			promptGuidelines: tool.promptGuidelines,
		});
		assert.match(prompt, /at least 3 consecutive goal rounds/);
		assert.match(prompt, /Call get_goal before update_goal/);
	}
});

test("/goal persists mutation before model-isolated command output and dispatches one round", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("finish the release", harness.ctx);
	assert.equal(harness.branch[0].customType, GOAL_CHANGE_ENTRY);
	assert.equal(harness.branch[1].customType, GOAL_COMMAND_ENTRY);
	assert.equal(harness.branch[2].customType, GOAL_ROUND_MESSAGE);
	assert.equal(harness.sentMessages.length, 1);
	assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(harness.sentMessages[0].message.content, /Round: 1\/256/);
	assert.equal(harness.sentMessages[0].message.display, true);

	const renderer = harness.entryRenderers.get(GOAL_COMMAND_ENTRY);
	const card = renderer(harness.branch[1], { expanded: false }, harness.theme);
	assert.match(textOf(card), /Goal created/);
	assert.match(textOf(card), /Activation: armed/);
});

test("round admission follows Pi's message_end-before-session-persistence order", async () => {
	const harness = createExtensionHarness({ persistSentMessages: false });
	await harness.start();
	await harness.commands.get("goal").handler("persist in production order", harness.ctx);
	assert.equal(harness.branch.some((entry) => entry.customType === GOAL_ROUND_MESSAGE), false);
	await harness.admitLastRound();
	const admissionIndex = harness.branch.findIndex((entry) => entry.customType === GOAL_ROUND_ADMISSION_ENTRY);
	const messageIndex = harness.branch.findIndex((entry) => entry.customType === GOAL_ROUND_MESSAGE);
	assert.notEqual(admissionIndex, -1);
	assert.ok(messageIndex > admissionIndex, "Pi persists the custom message after extension message_end handlers");
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 1);
});

test("status command is model-isolated and exact controls do not trigger agent runs", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	const command = harness.commands.get("goal");
	await command.handler("", harness.ctx);
	await command.handler("clear", harness.ctx);
	assert.equal(harness.sentMessages.length, 0);
	const commandEntries = harness.branch.filter((entry) => entry.customType === GOAL_COMMAND_ENTRY);
	assert.equal(commandEntries.length, 2);
	assert.equal(commandEntries[0].data.result.text,
		"No goal is currently set.\nUsage: /goal [<objective>|clear|edit <objective>|pause|resume]");
	assert.equal(commandEntries[1].data.result.text, "No goal to clear.");
});

test("restored active goals are disarmed until an explicit resume", async () => {
	const state = emptyGoalFoldState();
	const create = planCreate(state, { objective: "resume me", maxGoalRounds: 4 }, "goal-restored", 1, 256);
	const harness = createExtensionHarness({
		branch: [{ type: "custom", customType: GOAL_CHANGE_ENTRY, data: create.change }],
	});
	await harness.start("resume");
	assert.equal(harness.sentMessages.length, 0);
	await harness.commands.get("goal").handler("", harness.ctx);
	const status = harness.branch.filter((entry) => entry.customType === GOAL_COMMAND_ENTRY).at(-1).data.result.text;
	assert.match(status, /Status: active/);
	assert.match(status, /Activation: disarmed/);
	assert.match(status, /Commands: .*\/goal resume/);
	await harness.commands.get("goal").handler("resume", harness.ctx);
	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0].message.details.revision, 2);
});

test("direct top-level human turns may create, edit, pause, and resume through tools", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput("Please keep working until this is complete.");
	let result = await executeTool(harness, "create_goal", { objective: "complete the feature", max_goal_rounds: 8 });
	let goal = result.details.goal;
	assert.deepEqual([goal.phase, goal.revision, goal.maxGoalRounds], ["active", 1, 8]);
	result = await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: goal.revision,
		action: "edit",
		objective: "complete and verify the feature",
	});
	goal = result.details.goal;
	assert.equal(goal.revision, 2);
	assert.equal(goal.objective, "complete and verify the feature");
	result = await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: goal.revision,
		action: "pause",
	});
	goal = result.details.goal;
	assert.equal(goal.phase, "paused");
	result = await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: goal.revision,
		action: "resume",
	});
	assert.equal(result.details.goal.phase, "active");
	assert.equal(result.details.activation, "armed");
	assert.equal(harness.sentMessages.length, 0, "active human run must settle before continuation");
});

test("model mutations without direct-human or exact-round authority fail closed", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "unauthorized" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

const userMessage = (text, timestamp = 1, images = []) => ({
	role: "user", content: [{ type: "text", text }, ...images], timestamp,
});
const peerMessage = {
	role: "custom", customType: "pi-party/message", content: "Peer findings",
	display: true, timestamp: 1,
};
const deniedCreate = harness => assert.rejects(
	executeTool(harness, "create_goal", { objective: "not authorized" }),
	/GOAL_TOOL_AUTHORITY_REQUIRED/,
);

test("input and prepared user context cannot authorize tools before message admission", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "direct request", source: "interactive" });
	await harness.emit("before_agent_start", { prompt: "direct request" });
	await harness.emit("context", { messages: [userMessage("direct request")] });
	await deniedCreate(harness);
	await harness.deliver([userMessage("direct request")]);
	assert.equal((await executeTool(harness, "create_goal", { objective: "admitted request" })).details.goal.objective, "admitted request");
});

test("immediate expanded skills and image attachments retain human authority", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	const images = [{ type: "image", mimeType: "image/png", data: "fixture-only" }];
	await harness.emit("input", { text: "/skill:long-task", images, source: "interactive" });
	await harness.emit("before_agent_start", { prompt: "Expanded instructions", images });
	await harness.deliver([userMessage("Expanded instructions", 1, images)]);
	assert.equal((await executeTool(harness, "create_goal", { objective: "expanded request" })).details.goal.objective, "expanded request");
});

test("a delivered compaction batch with one human marker authorizes the run", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "first human message", source: "interactive" });
	await harness.deliver([userMessage("first human message"), userMessage("second human message", 2)]);
	assert.equal((await executeTool(harness, "create_goal", { objective: "batched request" })).details.goal.objective, "batched request");
});

test("queued human input authorizes only its later delivery, not the current party run", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "human follow-up", source: "interactive", streamingBehavior: "followUp" });
	await harness.deliver([peerMessage]);
	await deniedCreate(harness);
	await harness.deliver([userMessage("human follow-up", 2)]);
	assert.equal((await executeTool(harness, "create_goal", { objective: "authorized later" })).details.goal.objective, "authorized later");
});

test("extension steering cannot consume earlier human follow-ups, including identical text", async () => {
	for (const extensionText of ["extension steer", "human follow-up"]) {
		const harness = createExtensionHarness({ idle: false });
		await harness.start();
		await harness.emit("input", { text: "human follow-up", source: "interactive", streamingBehavior: "followUp" });
		await harness.emit("input", { text: extensionText, source: "extension", streamingBehavior: "steer" });
		await harness.deliver([userMessage(extensionText)]);
		await deniedCreate(harness);
		await harness.deliver([userMessage("human follow-up", 2)]);
		assert.equal((await executeTool(harness, "create_goal", { objective: "human authority" })).details.goal.objective, "human authority");
	}
});

test("transformed queued input fails closed without a matching expansion boundary", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "/skill:long-task", source: "interactive", streamingBehavior: "followUp" });
	await harness.deliver([userMessage("Expanded instructions")]);
	await deniedCreate(harness);
});

test("handled input cannot authorize a peer turn or same-text extension input", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "same text", source: "interactive" });
	await harness.deliver([peerMessage]);
	await deniedCreate(harness);
	await harness.emit("input", { text: "same text", source: "extension" });
	await harness.emit("before_agent_start", { prompt: "same text" });
	await harness.deliver([userMessage("same text", 2)]);
	await deniedCreate(harness);
});

test("restored human history and unmatched extension messages grant no authority", async () => {
	const message = userMessage("past human request");
	const harness = createExtensionHarness({ idle: false, branch: [{ type: "message", message }] });
	await harness.start();
	await harness.emit("context", { messages: [message] });
	await harness.deliver([peerMessage, userMessage("extension without an input marker", 3)]);
	await deniedCreate(harness);
});

test("direct-human authority survives the user's tool-call turns", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput("use tools to finish this");
	await harness.emit("context", {
		messages: [
			{ role: "assistant", content: [], stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], isError: false, timestamp: 3 },
		],
	});
	const created = await executeTool(harness, "create_goal", { objective: "tool-backed work" });
	assert.equal(created.details.goal.objective, "tool-backed work");
});

test("direct-human authority survives unrelated custom messages in the same agent run", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput("establish authority");
	await harness.emit("context", {
		messages: [{
			role: "custom",
			customType: "other-extension",
			content: "subagent settlement notice",
			display: true,
			timestamp: 2,
		}],
	});
	const created = await executeTool(harness, "create_goal", { objective: "notice-safe authority" });
	assert.equal(created.details.goal.objective, "notice-safe authority");
});

test("admitted authority expires when the agent run settles", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput("establish authority");
	await harness.emit("agent_settled");
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "expired authority" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

test("context normalization is never inspected for input authority", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "pending human", source: "rpc" });
	const details = new Proxy({}, { ownKeys() { assert.fail("context must not be fingerprinted"); } });
	for (let i = 0; i < 3; i++) await harness.emit("context", { messages: [
		{ role: "user", content: `changing checkpoint ${i}`, timestamp: 0, details },
		{ ...peerMessage, details },
	] });
	await deniedCreate(harness);
	await harness.deliver([userMessage("pending human", 2)]);
	await executeTool(harness, "create_goal", { objective: "context-independent authority" });
	await harness.emit("agent_settled");
	await deniedCreate(harness);
});

test("a mismatched image or malformed user payload consumes its marker without granting authority", async () => {
	for (const content of [
		[{ type: "text", text: "request" }, { type: "image", mimeType: "image/png", data: "different" }],
		[{ type: "unknown" }],
	]) {
		const harness = createExtensionHarness({ idle: false });
		await harness.start();
		await harness.emit("input", { text: "request", source: "interactive", images: [{ type: "image", mimeType: "image/png", data: "original" }] });
		await harness.deliver([{ role: "user", content, timestamp: 1 }]);
		await deniedCreate(harness);
		await harness.deliver([userMessage("request", 2, [{ type: "image", mimeType: "image/png", data: "original" }])]);
		await deniedCreate(harness);
	}
});

test("arbitrary cyclic context cannot suppress an already pending goal wrap-up", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("finish with robust wrap-up", harness.ctx);
	await harness.admitLastRound();
	const current = await executeTool(harness, "get_goal");
	await executeTool(harness, "update_goal", {
		goal_id: current.details.goal.id,
		revision: current.details.goal.revision,
		action: "complete",
	});
	const details = { count: 1n };
	details.self = details;
	const outcome = await harness.emitContained("context", {
		messages: [{
			role: "custom",
			customType: "other-extension",
			content: "cyclic",
			details,
			timestamp: 2,
		}],
	});
	assert.deepEqual(outcome.errors, []);
	assert.equal(outcome.results.length, 1);
	assert.match(outcome.results[0].messages.at(-1).content[0].text, /<goal_complete>/);
});

test("managed SDK children cannot acquire human goal authority from an apparent interactive input", async () => {
	const harness = createExtensionHarness({ idle: false, managedChild: true });
	await harness.start();
	await harness.directInput();
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "child goal" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
	assert.equal((await executeTool(harness, "get_goal")).details.goal, null);
	await harness.emit("session_shutdown");
});

test("Pi Subagents child processes do not receive direct-human goal authority", async () => {
	const harness = createExtensionHarness({ idle: false, topLevel: false });
	await harness.start();
	await harness.directInput();
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "child goal" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

test("goal tools return compact values and enforce read-before-update CAS", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput();
	const empty = await executeTool(harness, "get_goal");
	assert.deepEqual(empty.details, { goal: null });
	const created = await executeTool(harness, "create_goal", { objective: "CAS" });
	const goal = created.details.goal;
	assert.equal(JSON.parse(created.content[0].text).goal.id, goal.id);
	await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: 1,
		action: "edit",
		objective: "CAS revised",
	});
	await assert.rejects(executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: 1,
		action: "pause",
	}), /stale goal ref/);
});

test("conditional update fields match DSH empty-filler rules", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput();
	let result = await executeTool(harness, "create_goal", { objective: "conditional" });
	let goal = result.details.goal;
	result = await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: goal.revision,
		action: "edit",
		objective: "edited",
		max_goal_rounds: 0,
		blocked_reason: "",
	});
	goal = result.details.goal;
	assert.equal(goal.objective, "edited");
	result = await executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: goal.revision,
		action: "pause",
		objective: "",
		max_goal_rounds: 0,
		blocked_reason: "",
	});
	assert.equal(result.details.goal.phase, "paused");
	await assert.rejects(executeTool(harness, "update_goal", {
		goal_id: goal.id,
		revision: result.details.goal.revision,
		action: "resume",
		objective: "not allowed",
	}), /GOAL_TOOL_INVALID_UPDATE/);
});

test("an exact admitted goal round may complete and receives one wrap-up model step", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("ship verified support", harness.ctx);
	await harness.admitLastRound();
	await harness.admitLastRound();
	const admissions = harness.branch.filter((entry) => entry.customType === GOAL_ROUND_ADMISSION_ENTRY);
	assert.equal(admissions.length, 1, "duplicate message events must not duplicate admissions");
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 1);
	const completed = await executeTool(harness, "update_goal", {
		goal_id: current.details.goal.id,
		revision: current.details.goal.revision,
		action: "complete",
	});
	assert.equal(completed.details.goal.phase, "complete");
	assert.equal(completed.terminate, undefined);
	const results = await harness.emit("context", { messages: [] });
	assert.equal(results.length, 1);
	assert.equal(results[0].messages.length, 1);
	assert.match(results[0].messages[0].content[0].text, /<goal_complete>/);
	assert.match(results[0].messages[0].content[0].text, /Do not call any more tools/);
});

test("goal-round authority survives unrelated custom messages in the same agent run", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("finish despite notices", harness.ctx);
	await harness.admitLastRound();
	await harness.emit("context", {
		messages: [{
			role: "custom",
			customType: "pi-subagents/notice",
			content: "A child settled while this round was running.",
			display: true,
			timestamp: 2,
		}],
	});
	const current = await executeTool(harness, "get_goal");
	const completed = await executeTool(harness, "update_goal", {
		goal_id: current.details.goal.id,
		revision: current.details.goal.revision,
		action: "complete",
	});
	assert.equal(completed.details.goal.phase, "complete");
});

test("reconcile disarms when durable roundsStarted differs", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("reconcile counters", harness.ctx);
	await harness.admitLastRound();
	const admissionIndex = harness.branch.findIndex((entry) => entry.customType === GOAL_ROUND_ADMISSION_ENTRY);
	assert.notEqual(admissionIndex, -1);
	harness.branch.splice(admissionIndex, 1);
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 0);
	assert.equal(current.details.activation, "disarmed");
});

test("direct-human completion does not inject autonomous wrap-up context", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.directInput();
	const created = await executeTool(harness, "create_goal", { objective: "finish now" });
	await executeTool(harness, "update_goal", {
		goal_id: created.details.goal.id,
		revision: 1,
		action: "complete",
	});
	const results = await harness.emit("context", { messages: [] });
	assert.deepEqual(results, [undefined]);
});

test("autonomous blocked reports require three admitted rounds and then wrap up", async () => {
	const harness = createExtensionHarness();
	await harness.start();
	await harness.commands.get("goal").handler("wait for credential", harness.ctx);
	for (let round = 1; round <= 2; round += 1) {
		await harness.admitLastRound();
		const current = await executeTool(harness, "get_goal");
		assert.equal(current.details.goal.roundsStarted, round);
		await assert.rejects(executeTool(harness, "update_goal", {
			goal_id: current.details.goal.id,
			revision: current.details.goal.revision,
			action: "blocked",
			blocked_reason: "The required credential is unavailable.",
		}), /GOAL_TOOL_BLOCK_THRESHOLD/);
		await harness.emit("agent_end", { messages: successfulAgentMessages() });
		await harness.emit("agent_settled");
	}
	await harness.admitLastRound();
	const current = await executeTool(harness, "get_goal");
	assert.equal(current.details.goal.roundsStarted, 3);
	const blocked = await executeTool(harness, "update_goal", {
		goal_id: current.details.goal.id,
		revision: current.details.goal.revision,
		action: "blocked",
		blocked_reason: "The required credential is unavailable.",
	});
	assert.equal(blocked.details.goal.phase, "blocked");
	assert.deepEqual(blocked.details.goal.blockedReason, {
		code: "model-reported",
		message: "The required credential is unavailable.",
	});
	const results = await harness.emit("context", { messages: [] });
	assert.match(results[0].messages[0].content[0].text, /<goal_blocked>/);
});

test("corrupt selected-branch state blocks tools and renders a command error", async () => {
	const harness = createExtensionHarness({
		branch: [{
			type: "custom",
			customType: GOAL_CHANGE_ENTRY,
			data: { kind: "goal/change", version: 1, operation: "create", extra: true },
		}],
	});
	await harness.start();
	await assert.rejects(executeTool(harness, "get_goal"), /goal history is corrupt/);
	await harness.commands.get("goal").handler("", harness.ctx);
	const entry = harness.branch.filter((candidate) => candidate.customType === GOAL_COMMAND_ENTRY).at(-1);
	assert.equal(entry.data.result.kind, "error");
	assert.match(entry.data.result.text, /branch history is corrupt/);
	assert.match(harness.widgets.get("pi-work")({ terminal: { rows: 40 }, requestRender() {} }, harness.theme).render(120).join("\n"), /Goal ! corrupt/);
});

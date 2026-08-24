import assert from "node:assert/strict";
import test from "node:test";

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
	assert.deepEqual([...harness.tools.keys()], ["get_goal", "create_goal", "update_goal"]);
	for (const tool of harness.tools.values()) assert.equal(tool.executionMode, "sequential");
	assert.equal(harness.entryRenderers.has(GOAL_COMMAND_ENTRY), true);
	assert.equal(harness.messageRenderers.has(GOAL_ROUND_MESSAGE), true);
	assert.match(harness.tools.get("get_goal").promptGuidelines[0], /at least 3 consecutive goal rounds/);

	const update = harness.tools.get("update_goal");
	assert.equal(update.parameters.additionalProperties, false);
	assert.deepEqual(update.parameters.required.sort(), ["action", "goal_id", "revision"]);
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

test("input alone does not grant authority before its user message reaches context", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "direct request", source: "interactive" });
	await harness.emit("before_agent_start", {
		prompt: "direct request",
		systemPrompt: "",
		systemPromptOptions: {},
	});
	await harness.emit("context", { messages: [] });
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "not admitted" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

test("expanded skill or template text retains direct-human authority", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "/skill:long-task", source: "interactive" });
	await harness.emit("before_agent_start", {
		prompt: "Expanded long-running task instructions",
		systemPrompt: "",
		systemPromptOptions: {},
	});
	await harness.emit("context", {
		messages: [{
			role: "user",
			content: [{ type: "text", text: "Expanded long-running task instructions" }],
			timestamp: 1,
		}],
	});
	const created = await executeTool(harness, "create_goal", { objective: "expanded request" });
	assert.equal(created.details.goal.objective, "expanded request");
});

test("queued human input authorizes only the later context that contains it", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	const current = {
		role: "custom",
		customType: "other-extension",
		content: "current extension turn",
		display: false,
		timestamp: 1,
	};
	await harness.emit("input", {
		text: "queued human follow-up",
		source: "interactive",
		streamingBehavior: "followUp",
	});
	await harness.emit("context", { messages: [current] });
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "too early" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
	await harness.emit("context", {
		messages: [
			current,
			{
				role: "user",
				content: [{ type: "text", text: "queued human follow-up" }],
				timestamp: 2,
			},
		],
	});
	const created = await executeTool(harness, "create_goal", { objective: "authorized later" });
	assert.equal(created.details.goal.objective, "authorized later");
});

test("handled or stale input cannot authorize an extension custom turn", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "handled elsewhere", source: "interactive" });
	await harness.emit("context", {
		messages: [{
			role: "custom",
			customType: "other-extension",
			content: "extension-triggered work",
			display: false,
			timestamp: 1,
		}],
	});
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "stale authority" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

test("extension user context without direct input is rejected", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "extension request", source: "extension" });
	await harness.emit("context", {
		messages: [{
			role: "user",
			content: [{ type: "text", text: "extension request" }],
			timestamp: 1,
		}],
	});
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "extension authority" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
});

test("extension user input cannot claim a handled human input with the same text", async () => {
	const harness = createExtensionHarness({ idle: false });
	await harness.start();
	await harness.emit("input", { text: "same text", source: "interactive" });
	await harness.emit("input", { text: "same text", source: "extension" });
	await harness.emit("before_agent_start", {
		prompt: "same text",
		systemPrompt: "",
		systemPromptOptions: {},
	});
	await harness.emit("context", {
		messages: [{
			role: "user",
			content: [{ type: "text", text: "same text" }],
			timestamp: 1,
		}],
	});
	await assert.rejects(
		executeTool(harness, "create_goal", { objective: "stale extension authority" }),
		/GOAL_TOOL_AUTHORITY_REQUIRED/,
	);
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
	assert.match(harness.statuses.get("pi-goal"), /goal corrupt/);
});

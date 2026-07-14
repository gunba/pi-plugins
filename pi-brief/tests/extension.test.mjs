import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import briefExtension from "../extensions/brief.ts";

function completeBrief() {
	return {
		title: "Precise task",
		mission: "Complete the intended outcome.",
		motivation: "The current behaviour does not meet the user's need.",
		userVisibleOutcome: "The requested capability works end to end.",
		definitions: [],
		scope: {
			included: ["The requested capability"],
			excluded: [],
			assumptions: [],
		},
		requirements: {
			must: ["Meet the stated intent"],
			should: [],
			may: [],
			mustNot: ["Silently narrow scope"],
		},
		acceptanceCriteria: ["The intended outcome is demonstrably complete"],
		nonGoals: ["Nearby substitutes do not count"],
		edgeCases: ["Boundary inputs"],
		constraintsAndTradeoffs: [],
		openQuestions: [],
		process: ["Clarify", "Execute", "Audit"],
		timeHorizon: {
			expectedDuration: "One focused day",
			minimumEffort: "Complete every process and audit stage",
			persistenceRules: [
				"Try a materially different approach after a blocked route",
			],
			returnPolicy: "Return only after all acceptance checks pass.",
		},
		verification: ["Challenge every acceptance criterion adversarially"],
		deliverables: ["Completed outcome and verification evidence"],
		interactionRules: [
			"Ask when an unforeseen conflict requires a user decision",
		],
		completion: {
			successConditions: ["All acceptance criteria pass"],
			stopConditions: [
				"Complete success",
				"A user-owned conflict blocks further work",
			],
			blockerPolicy: "Ask the user rather than contradict the brief.",
			partialWorkPolicy: "Do not return partial work or a nearby substitute.",
		},
		sourcesAndTools: [],
	};
}

function createHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-brief-test-"));
	const commands = new Map();
	const tools = new Map();
	const entries = [];
	const userMessages = [];
	const newSessions = [];
	const registerToolCalls = [];
	const setActiveToolsCalls = [];
	let activeTools = ["read", "edit", "write", "ask_user"];
	let extensionInitializing = true;

	const pi = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			assert.equal(
				extensionInitializing,
				true,
				`${tool.name} was registered after extension initialization`,
			);
			registerToolCalls.push(tool.name);
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		registerEntryRenderer() {},
		on() {},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			setActiveToolsCalls.push([...names]);
			activeTools = [...names];
		},
		sendUserMessage(message, options) {
			userMessages.push({ message, options });
		},
	};

	const theme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return text;
		},
		bold(text) {
			return text;
		},
	};
	const sessionManager = {
		getSessionFile() {
			return "/sessions/parent.jsonl";
		},
		getBranch() {
			return [];
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		model: { id: "test-model" },
		sessionManager,
		ui: {
			theme,
			async confirm() {
				return true;
			},
			notify() {},
			setStatus() {},
			setWidget() {},
		},
		async waitForIdle() {},
		async newSession(options) {
			const setupNames = [];
			const sent = [];
			await options.setup?.({
				appendSessionInfo(name) {
					setupNames.push(name);
				},
			});
			await options.withSession?.({
				async sendUserMessage(message) {
					sent.push(message);
				},
			});
			newSessions.push({ options, setupNames, sent });
			return { cancelled: false };
		},
	};

	briefExtension(pi);
	extensionInitializing = false;
	return {
		commands,
		tools,
		entries,
		userMessages,
		newSessions,
		registerToolCalls,
		setActiveToolsCalls,
		ctx,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
		getActiveTools: () => [...activeTools],
	};
}

test("/brief keeps provider tool registration and active membership stable", async (t) => {
	const harness = createHarness();
	t.after(harness.cleanup);
	const command = harness.commands.get("brief");
	assert.ok(command);
	assert.deepEqual(harness.registerToolCalls, ["present_brief"]);
	assert.equal(harness.tools.has("present_brief"), true);
	assert.deepEqual(harness.getActiveTools(), [
		"read",
		"edit",
		"write",
		"ask_user",
		"present_brief",
	]);
	assert.deepEqual(harness.setActiveToolsCalls, []);

	const tool = harness.tools.get("present_brief");
	await assert.rejects(
		tool.execute(
			"call-inactive",
			{ action: "draft", brief: completeBrief() },
			undefined,
			undefined,
			harness.ctx,
		),
		/No active brief/,
	);

	await command.handler("Build the intended capability", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), [
		"read",
		"edit",
		"write",
		"ask_user",
		"present_brief",
	]);
	assert.deepEqual(harness.registerToolCalls, ["present_brief"]);
	assert.deepEqual(harness.setActiveToolsCalls, []);
	assert.match(
		harness.userMessages[0].message[0].text,
		/Build the intended capability/,
	);
	const result = await tool.execute(
		"call-1",
		{ action: "draft", brief: completeBrief() },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.match(result.content[0].text, /Rendered brief revision 1/);
	assert.equal(result.details.revision, 1);
	assert.equal(result.details.status, "draft");
	assert.match(result.details.filePath, /\.pi\/briefs\/.*-precise-task\.md$/);
	assert.match(
		readFileSync(result.details.filePath, "utf8"),
		/^# Precise task/m,
	);

	await tool.execute(
		"call-2",
		{
			action: "approve",
			approvalEvidence: "Approved, continue.",
			brief: completeBrief(),
		},
		undefined,
		undefined,
		harness.ctx,
	);
	await command.handler("__approve-current-brief", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), [
		"read",
		"edit",
		"write",
		"ask_user",
		"present_brief",
	]);
	assert.deepEqual(harness.registerToolCalls, ["present_brief"]);
	assert.deepEqual(harness.setActiveToolsCalls, []);
	assert.equal(harness.newSessions.length, 1);
	assert.equal(
		Object.hasOwn(harness.newSessions[0].options, "parentSession"),
		false,
	);
	assert.deepEqual(harness.newSessions[0].setupNames, ["Precise task"]);
	assert.match(harness.newSessions[0].sent[0], /^# Precise task/m);
	assert.match(
		harness.newSessions[0].sent[0],
		/## Time horizon and persistence/,
	);
	assert.match(harness.newSessions[0].sent[0], /Do not return partial work/);
});

test("tool approval requires explicit evidence and queues conversation replacement", async (t) => {
	const harness = createHarness();
	t.after(harness.cleanup);
	const command = harness.commands.get("brief");
	await command.handler("Build the intended capability", harness.ctx);
	const tool = harness.tools.get("present_brief");

	await assert.rejects(
		tool.execute(
			"call-1",
			{ action: "approve", brief: completeBrief() },
			undefined,
			undefined,
			harness.ctx,
		),
		/approvalEvidence/,
	);

	const result = await tool.execute(
		"call-2",
		{
			action: "approve",
			approvalEvidence: "Approved, send it.",
			brief: completeBrief(),
		},
		undefined,
		undefined,
		harness.ctx,
	);

	assert.equal(result.details.status, "approved");
	assert.deepEqual(harness.userMessages.at(-1), {
		message: "/brief __approve-current-brief",
		options: { deliverAs: "followUp" },
	});
});

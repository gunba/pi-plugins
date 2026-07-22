import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import briefExtension from "../extensions/brief.ts";

initTheme("dark", false);

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
	const branchEntries = [];
	const userMessages = [];
	const newSessions = [];
	const notifications = [];
	const registerToolCalls = [];
	const setActiveToolsCalls = [];
	let activeTools = ["read", "edit", "write", "ask_user"];
	let extensionInitializing = true;
	let agentIdle = false;
	let nextEntryId = 1;
	let idleWaiters = [];

	const appendBranchEntry = (entry) => {
		branchEntries.push({
			id: `entry-${nextEntryId++}`,
			parentId: branchEntries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			...entry,
		});
	};

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
			appendBranchEntry({ type: "custom", customType, data });
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
			appendBranchEntry({
				type: "message",
				message: { role: "user", content: message, timestamp: Date.now() },
			});
			agentIdle = false;
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
			return branchEntries;
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
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
			setWidget() {},
		},
		async waitForIdle() {
			if (agentIdle) return;
			await new Promise((resolve) => idleWaiters.push(resolve));
		},
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
		notifications,
		ctx,
		theme,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
		getActiveTools: () => [...activeTools],
		addUserMessage(text) {
			appendBranchEntry({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				},
			});
			agentIdle = false;
		},
		async settleAgent() {
			agentIdle = true;
			const waiters = idleWaiters;
			idleWaiters = [];
			for (const resolve of waiters) resolve();
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
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
	assert.match(result.content[0].text, /rendered in the review card/);
	assert.equal(result.details.revision, 1);
	assert.equal(result.details.status, "draft");
	assert.equal(result.details.handoff, "none");
	assert.equal(result.terminate, true);
	assert.match(result.details.filePath, /\.pi[\\/]briefs[\\/].*-precise-task\.md$/);
	assert.match(
		readFileSync(result.details.filePath, "utf8"),
		/^# Precise task/m,
	);
	const compactCard = tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		harness.theme,
	);
	const compactText = compactCard.render(120).join("\n");
	assert.match(compactText, /DRAFT/);
	assert.match(compactText, /Mission/);
	assert.match(compactText, /Key requirements/);
	assert.match(compactText, /Acceptance checks/);
	assert.doesNotMatch(compactText, /Draft file|\.pi[\\/]briefs/);
	const expandedCard = tool.renderResult(
		result,
		{ expanded: true, isPartial: false },
		harness.theme,
	);
	const expandedText = expandedCard.render(120).join("\n");
	assert.match(expandedText, /Required process/);
	assert.match(expandedText, /Verification and adversarial audit/);
	assert.doesNotMatch(expandedText, /Draft file|\.pi[\\/]briefs/);

	harness.addUserMessage("Approved, continue.");
	const approval = await tool.execute(
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
	assert.equal(approval.details.status, "approved");
	assert.equal(approval.details.revision, 1);
	assert.equal(approval.details.handoff, "automatic");
	assert.equal(approval.terminate, true);
	const approvedCard = tool.renderResult(
		approval,
		{ expanded: false, isPartial: false },
		harness.theme,
	);
	const approvedText = approvedCard.render(120).join("\n");
	assert.match(approvedText, /APPROVED/);
	assert.match(approvedText, /starting a fresh execution conversation/);
	assert.doesNotMatch(approvedText, /Draft file|\.pi[\\/]briefs/);
	assert.equal(harness.newSessions.length, 0);
	assert.equal(harness.userMessages.length, 1);
	assert.equal(
		harness.userMessages.some(({ message }) =>
			typeof message === "string" && message.includes("__approve-current-brief"),
		),
		false,
	);

	await harness.settleAgent();

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

test("changed briefs must be rendered before a later approval", async (t) => {
	const harness = createHarness();
	t.after(harness.cleanup);
	const command = harness.commands.get("brief");
	await command.handler("Build the intended capability", harness.ctx);
	const tool = harness.tools.get("present_brief");
	const firstDraft = completeBrief();
	await tool.execute(
		"call-draft-1",
		{ action: "draft", brief: firstDraft },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.addUserMessage("Change the outcome to be clearer, then proceed.");

	await assert.rejects(
		tool.execute(
			"call-1",
			{ action: "approve", brief: firstDraft },
			undefined,
			undefined,
			harness.ctx,
		),
		/approvalEvidence/,
	);

	const revisedBrief = completeBrief();
	revisedBrief.userVisibleOutcome = "The requested capability works clearly from end to end.";
	await assert.rejects(
		tool.execute(
			"call-2",
			{
				action: "approve",
				approvalEvidence: "then proceed",
				brief: revisedBrief,
			},
			undefined,
			undefined,
			harness.ctx,
		),
		/differs from the latest rendered draft/,
	);

	const revision = await tool.execute(
		"call-3",
		{ action: "draft", brief: revisedBrief },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.equal(revision.details.status, "draft");
	assert.equal(revision.details.revision, 2);
	assert.equal(revision.terminate, true);
	assert.equal(harness.newSessions.length, 0);

	harness.addUserMessage("Approved, send it.");
	await assert.rejects(
		tool.execute(
			"call-4",
			{
				action: "approve",
				approvalEvidence: "approved earlier",
				brief: revisedBrief,
			},
			undefined,
			undefined,
			harness.ctx,
		),
		/complete latest message/,
	);

	const result = await tool.execute(
		"call-2",
		{
			action: "approve",
			approvalEvidence: "Approved, send it.",
			brief: revisedBrief,
		},
		undefined,
		undefined,
		harness.ctx,
	);

	assert.equal(result.details.status, "approved");
	assert.equal(result.details.revision, 2);
	assert.equal(result.details.handoff, "automatic");
	assert.equal(result.terminate, true);
	assert.equal(harness.userMessages.length, 1);
	assert.equal(harness.newSessions.length, 0);
	await harness.settleAgent();
	assert.equal(harness.newSessions.length, 1);
});

test("/brief approve directly retries an approved-session handoff", async (t) => {
	const harness = createHarness();
	t.after(harness.cleanup);
	const command = harness.commands.get("brief");
	const tool = harness.tools.get("present_brief");
	await command.handler("Build the intended capability", harness.ctx);
	await tool.execute(
		"call-draft",
		{ action: "draft", brief: completeBrief() },
		undefined,
		undefined,
		harness.ctx,
	);
	await harness.settleAgent();
	await command.handler("approve", harness.ctx);

	assert.equal(harness.newSessions.length, 1);
	assert.deepEqual(harness.newSessions[0].setupNames, ["Precise task"]);
	assert.match(harness.newSessions[0].sent[0], /^# Precise task/m);
});

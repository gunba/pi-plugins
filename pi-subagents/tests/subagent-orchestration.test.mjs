import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SubagentDashboard,
	flattenDashboardAgents,
	orchestrationSummary,
	taskPathLabel,
} from "../extensions/subagent-dashboard.ts";

delete process.env.PI_SUBAGENT_TASK_PATH;
delete process.env.PI_SUBAGENT_PARENT_PATH;
delete process.env.PI_SUBAGENT_RUN;
const {
	default: subagents,
	childTaskPath,
	normalizeTaskName,
	taskStorageKey,
	taskSummary,
} = await import("../extensions/subagents.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
};

function parseJson(value) {
	try {
		return JSON.parse(value);
	} catch (error) {
		assert.fail(`Invalid JSON: ${String(error)}`);
	}
}

function toolPayload(result) {
	return parseJson(result.content[0].text);
}

function agents(count, deep = false) {
	const out = [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
	];
	for (let index = 0; index < count; index++) {
		let state = "running";
		if (index % 7 === 0) state = "completed";
		else if (index % 11 === 0) state = "hard_killed";
		const name = deep
			? `/root/${Array.from({ length: index + 1 }, (_, depth) => `agent_${depth}`).join("/")}`
			: `/root/agent_${index}`;
		const parent =
			deep && index > 0 ? name.slice(0, name.lastIndexOf("/")) : "/root";
		out.push({
			name,
			taskId: `task-${String(index).padStart(4, "0")}`,
			parent,
			taskName: `Investigate orchestration case ${index}`,
			state,
			startedAt: index + 2,
			updatedAt: index + 2,
			thinking: "medium",
		});
	}
	return out;
}

test("Codex task names form canonical hierarchical paths", () => {
	assert.equal(normalizeTaskName("auth_race"), "auth_race");
	assert.equal(normalizeTaskName("agent42"), "agent42");
	assert.equal(childTaskPath("/root", "auth_race"), "/root/auth_race");
	assert.equal(
		childTaskPath("/root/auth_race", "reproduce"),
		"/root/auth_race/reproduce",
	);
	assert.throws(() => normalizeTaskName("auth-race"), /task_name/i);
	assert.throws(() => normalizeTaskName("AuthRace"), /task_name/i);
	assert.throws(() => normalizeTaskName("root"), /task_name/i);
	assert.equal(
		taskSummary("  Inspect\n\nall   nested agents  "),
		"Inspect all nested agents",
	);
});

test("dashboard tree labels show only each task's local path segment", () => {
	assert.equal(taskPathLabel("/root/oalcc_dataset"), "oalcc_dataset");
	assert.equal(
		taskPathLabel("/root/oalcc_dataset/license_sources"),
		"license_sources",
	);
	assert.equal(taskPathLabel("/root"), "/root");
});

test("deep canonical paths use fixed-size storage keys", () => {
	const deepPath = `/root/${Array.from({ length: 100 }, (_, index) => `task_${index}`).join("/")}`;
	assert.equal(taskStorageKey(deepPath).length, 43);
	assert.equal(taskStorageKey(deepPath), taskStorageKey(deepPath));
	assert.notEqual(
		taskStorageKey(`${deepPath}_other`),
		taskStorageKey(deepPath),
	);
});

test("root registration exposes only the five orchestration primitives", () => {
	const tools = [];
	const handlers = [];
	subagents({
		getThinkingLevel: () => {
			throw new Error("Extension runtime not initialized");
		},
		registerTool: (tool) => tools.push(tool),
		on: (event, handler) => handlers.push({ event, handler }),
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[
			"spawn_agent",
			"send_message",
			"restart_agent",
			"wait_agent",
			"kill_agent",
		],
	);
	assert.ok(handlers.some(({ event }) => event === "agent_settled"));
	assert.ok(handlers.some(({ event }) => event === "thinking_level_select"));
	assert.equal(
		handlers.some(({ event }) => event === "context"),
		false,
	);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	assert.equal(
		byName.get("spawn_agent").promptSnippet,
		"Start an isolated child agent; ordinary tools are blocked until delegated work completes",
	);
	assert.deepEqual(byName.get("spawn_agent").promptGuidelines, [
		"After the final spawn_agent call, call wait_agent next. Do not batch or call ordinary tools while delegated work is pending; only spawn_agent, send_message, restart_agent, wait_agent, and kill_agent are allowed.",
	]);
	assert.equal(
		byName.get("wait_agent").promptSnippet,
		"Wait for delegated work; repeat while delegation_pending is true",
	);
	assert.equal(byName.get("wait_agent").promptGuidelines, undefined);
	for (const name of ["send_message", "restart_agent", "kill_agent"]) {
		assert.equal(byName.get(name).promptSnippet, undefined);
		assert.equal(byName.get(name).promptGuidelines, undefined);
	}
	assert.deepEqual(
		Object.keys(byName.get("spawn_agent").parameters.properties),
		["task_name", "message", "thinking"],
	);
	assert.deepEqual(
		Object.keys(byName.get("send_message").parameters.properties),
		["target", "message", "approve_spawn"],
	);
	assert.deepEqual(
		Object.keys(byName.get("restart_agent").parameters.properties),
		["target", "message"],
	);
	assert.deepEqual(
		Object.keys(byName.get("wait_agent").parameters.properties),
		[],
	);
	assert.equal(byName.get("wait_agent").prepareArguments, undefined);
	assert.equal(
		byName.get("spawn_agent").parameters.additionalProperties,
		false,
	);
	assert.equal(typeof byName.get("spawn_agent").renderCall, "function");
	assert.equal(typeof byName.get("spawn_agent").renderResult, "function");
});

test("child registration exposes the same five orchestration primitives", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	process.env.PI_SUBAGENT_TASK_PATH = "/root/research";
	process.env.PI_SUBAGENT_PARENT_PATH = "/root";
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: childSubagents } = await import(
		`../extensions/subagents.ts?child-surface=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_TASK_PATH;
	delete process.env.PI_SUBAGENT_PARENT_PATH;
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	childSubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[
			"spawn_agent",
			"send_message",
			"restart_agent",
			"wait_agent",
			"kill_agent",
		],
	);
	rmSync(runDir, { recursive: true, force: true });
});

test("structured nested spawn denial leaves no child task storage", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-approval-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
		{
			name: "/root/research",
			taskId: "task-research",
			parent: "/root",
			taskName: "Research",
			state: "running",
			startedAt: 2,
			updatedAt: 2,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	process.env.PI_SUBAGENT_TASK_PATH = "/root/research";
	process.env.PI_SUBAGENT_PARENT_PATH = "/root";
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: approvalSubagents } = await import(
		`../extensions/subagents.ts?approval=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_TASK_PATH;
	delete process.env.PI_SUBAGENT_PARENT_PATH;
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	approvalSubagents({
		getThinkingLevel: () => "high",
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const spawn = tools.find((tool) => tool.name === "spawn_agent");
	const controller = new AbortController();
	const keepAlive = setTimeout(() => controller.abort(), 1000);
	const pending = spawn.execute(
		"spawn",
		{ task_name: "extra", message: "Duplicate the investigation" },
		controller.signal,
		undefined,
		{},
	);
	const rootInbox = join(runDir, "tasks", taskStorageKey("/root"), "inbox");
	const requestFile = readdirSync(rootInbox)[0];
	const request = parseJson(readFileSync(join(rootInbox, requestFile), "utf8"));
	assert.equal(request.approval.thinking, "high");
	const researchDir = join(runDir, "tasks", taskStorageKey("/root/research"));
	const waitingBeacon = parseJson(
		readFileSync(join(researchDir, "beacon.json"), "utf8"),
	);
	assert.equal(waitingBeacon.state, "waiting");
	assert.equal(waitingBeacon.activity, "awaiting 1 spawn approval");
	const childInbox = join(researchDir, "inbox");
	writeFileSync(
		join(childInbox, "reply.json"),
		JSON.stringify({
			id: "reply",
			from: "/root",
			to: "/root/research",
			body: "duplicate work",
			replyTo: request.id,
			kind: "notice",
			approved: false,
			ts: Date.now(),
		}),
	);
	const result = await pending;
	clearTimeout(keepAlive);
	assert.equal(
		toolPayload(result).error,
		"Spawn denied by root: duplicate work",
	);
	const resumedBeacon = parseJson(
		readFileSync(join(researchDir, "beacon.json"), "utf8"),
	);
	assert.equal(resumedBeacon.state, "running");
	assert.equal(resumedBeacon.activity, "");
	const childrenDir = join(
		runDir,
		"tasks",
		taskStorageKey("/root/research"),
		"children",
	);
	assert.equal(existsSync(childrenDir), false);
	rmSync(runDir, { recursive: true, force: true });
});

test("root decides nested spawn approval through send_message", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-agent-approval-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
		{
			name: "/root/research",
			taskId: "task-research",
			parent: "/root",
			taskName: "Research",
			state: "waiting",
			startedAt: 2,
			updatedAt: 2,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(join(dir, "inbox"), { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: approvalExtension } = await import(
		`../extensions/subagents.ts?agent-approval=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	approvalExtension({
		getThinkingLevel: () => "high",
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const request = {
		id: "request",
		from: "/root/research",
		to: "/root",
		body: "nested spawn request",
		kind: "request",
		approval: {
			type: "spawn",
			taskName: "evidence",
			taskPath: "/root/research/evidence",
			message: "Gather the evidence",
			thinking: "high",
		},
		ts: Date.now(),
	};
	const rootInbox = join(runDir, "tasks", taskStorageKey("/root"), "inbox");
	writeFileSync(join(rootInbox, "request.json"), JSON.stringify(request));
	const wait = tools.find((tool) => tool.name === "wait_agent");
	const event = await wait.execute("wait", {}, undefined, undefined, {});
	const eventPayload = toolPayload(event);
	assert.ok(eventPayload.message.includes("nested spawn request"));
	assert.equal(
		eventPayload.request.approval.taskPath,
		"/root/research/evidence",
	);
	const send = tools.find((tool) => tool.name === "send_message");
	const missingDecision = await send.execute(
		"send",
		{ target: "/root/research", message: "Useful decomposition" },
		undefined,
		undefined,
		{},
	);
	assert.equal(
		toolPayload(missingDecision).error,
		"approve_spawn is required for this nested spawn request",
	);
	const decision = await send.execute(
		"send",
		{
			target: "/root/research",
			message: "Useful decomposition",
			approve_spawn: true,
		},
		undefined,
		undefined,
		{},
	);
	assert.equal(toolPayload(decision).approved, true);
	const childInbox = join(
		runDir,
		"tasks",
		taskStorageKey("/root/research"),
		"inbox",
	);
	const replyFile = readdirSync(childInbox)[0];
	const reply = parseJson(readFileSync(join(childInbox, replyFile), "utf8"));
	assert.equal(reply.replyTo, request.id);
	assert.equal(reply.approved, true);
	assert.equal(reply.body, "approve");
	rmSync(runDir, { recursive: true, force: true });
});

test("upward messages block for an automatic parent reply", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-query-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	const queryNow = Date.now();
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: queryNow,
			updatedAt: queryNow,
		},
		{
			name: "/root/research",
			taskId: "task-research",
			parent: "/root",
			taskName: "Research",
			state: "running",
			startedAt: queryNow,
			updatedAt: queryNow,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(process.pid));
		}
	}

	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: rootSubagents } = await import(
		`../extensions/subagents.ts?query-root=${Date.now()}`
	);
	process.env.PI_SUBAGENT_TASK_PATH = "/root/research";
	process.env.PI_SUBAGENT_PARENT_PATH = "/root";
	const { default: childSubagents } = await import(
		`../extensions/subagents.ts?query-child=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_TASK_PATH;
	delete process.env.PI_SUBAGENT_PARENT_PATH;
	delete process.env.PI_SUBAGENT_RUN;

	const rootTools = [];
	rootSubagents({ registerTool: (tool) => rootTools.push(tool), on: () => {} });
	const childTools = [];
	childSubagents({
		registerTool: (tool) => childTools.push(tool),
		on: () => {},
	});
	const rootByName = new Map(rootTools.map((tool) => [tool.name, tool]));
	const childByName = new Map(childTools.map((tool) => [tool.name, tool]));
	const controller = new AbortController();
	const keepAlive = setTimeout(() => controller.abort(), 1000);
	const pendingReply = childByName
		.get("send_message")
		.execute(
			"question",
			{ target: "/root", message: "Which source should I use?" },
			controller.signal,
			undefined,
			{},
		);
	const question = await rootByName
		.get("wait_agent")
		.execute("wait", {}, undefined, undefined, {});
	assert.match(toolPayload(question).message, /Which source should I use/);
	const sent = await rootByName
		.get("send_message")
		.execute(
			"answer",
			{ target: "/root/research", message: "Use the primary source." },
			undefined,
			undefined,
			{},
		);
	assert.match(sent.details.display, /Replied/);
	const answer = await pendingReply;
	clearTimeout(keepAlive);
	assert.deepEqual(toolPayload(answer), { message: "Use the primary source." });
	rmSync(runDir, { recursive: true, force: true });
});

test("model tools route exclusively by canonical task path", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-runtime-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	const runtimeNow = Date.now();
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: runtimeNow,
			updatedAt: runtimeNow,
		},
		{
			name: "/root/research",
			taskId: "task-secret",
			parent: "/root",
			taskName: "Research the implementation",
			state: "interrupted",
			startedAt: runtimeNow,
			updatedAt: runtimeNow,
		},
		{
			name: "/root/branch/deep",
			taskId: "task-deep",
			parent: "/root/branch",
			taskName: "Deep running task",
			state: "running",
			startedAt: runtimeNow,
			updatedAt: runtimeNow,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.state === "running" && beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(process.pid));
		}
	}
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: runtimeSubagents } = await import(
		`../extensions/subagents.ts?root-runtime=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	const handlers = [];
	runtimeSubagents({
		registerTool: (tool) => tools.push(tool),
		on: (event, handler) => handlers.push({ event, handler }),
	});
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const gate = handlers
		.find(({ event }) => event === "tool_call")
		.handler({
			toolName: "read",
		});
	assert.equal(gate.block, true);

	const rejected = await byName
		.get("send_message")
		.execute(
			"send-id",
			{ target: "task-secret", message: "hello" },
			undefined,
			undefined,
			{},
		);
	assert.match(toolPayload(rejected).error, /unknown/i);
	const delivered = await byName
		.get("send_message")
		.execute(
			"send-path",
			{ target: "/root/branch/deep", message: "hello" },
			undefined,
			undefined,
			{},
		);
	assert.deepEqual(toolPayload(delivered), {});
	const inbox = join(
		runDir,
		"tasks",
		taskStorageKey("/root/branch/deep"),
		"inbox",
	);
	assert.equal(readdirSync(inbox).length, 1);
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let stallWatchdogHandle;
	let stallWatchdogCleared = false;
	globalThis.setTimeout = (callback, delay, ...args) => {
		const handle = realSetTimeout(callback, delay, ...args);
		if (delay >= 590_000) stallWatchdogHandle = handle;
		return handle;
	};
	globalThis.clearTimeout = (handle) => {
		if (handle === stallWatchdogHandle) stallWatchdogCleared = true;
		return realClearTimeout(handle);
	};
	const waitController = new AbortController();
	const abortWait = realSetTimeout(() => waitController.abort(), 20);
	let waitResult;
	try {
		waitResult = await byName
			.get("wait_agent")
			.execute("wait", {}, waitController.signal, undefined, {});
	} finally {
		realClearTimeout(abortWait);
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
	assert.ok(
		stallWatchdogHandle,
		"stall watchdog was not scheduled by blocking wait",
	);
	assert.equal(
		stallWatchdogCleared,
		true,
		"stall watchdog survived after wait ended",
	);
	assert.deepEqual(toolPayload(waitResult), {
		message: "Wait interrupted by user input.",
		delegation_pending: true,
		next_action:
			"Handle the user input with send_message, restart_agent, or kill_agent, then call wait_agent again if work remains.",
	});
	const killed = await byName
		.get("kill_agent")
		.execute("kill", { target: "/root/research" }, undefined, undefined, {});
	assert.match(toolPayload(killed).message, /already interrupted/i);
	rmSync(runDir, { recursive: true, force: true });
});

test("stalled leaf telemetry is returned to the main agent for a decision", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-stalled-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	const staleAt = Date.now() - 700_000;
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
		{
			name: "/root/stalled",
			taskId: "task-stalled",
			parent: "/root",
			taskName: "Stalled task",
			state: "running",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(process.pid));
		}
	}
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: stalledSubagents } = await import(
		`../extensions/subagents.ts?stalled=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	stalledSubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const waitAgent = tools.find((tool) => tool.name === "wait_agent");
	const result = await waitAgent.execute(
		"wait-stalled",
		{},
		undefined,
		undefined,
		{},
	);
	const payload = toolPayload(result);
	assert.equal(payload.attention.type, "stalled_agents");
	assert.deepEqual(
		payload.attention.agents.map((agent) => agent.task_path),
		["/root/stalled"],
	);
	assert.match(payload.next_action, /restart_agent.*kill_agent/i);
	assert.doesNotMatch(payload.next_action, /^Call wait_agent/);
	rmSync(runDir, { recursive: true, force: true });
});

test("stall watchdog wakes wait_agent without a separate overseer model", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-watchdog-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	const startedAt = Date.now();
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt,
			updatedAt: startedAt,
		},
		{
			name: "/root/watchdog",
			taskId: "task-watchdog",
			parent: "/root",
			taskName: "Watchdog task",
			state: "running",
			startedAt,
			updatedAt: startedAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(process.pid));
		}
	}
	process.env.PI_SUBAGENT_RUN = runDir;
	process.env.PI_SUBAGENTS_STALL_TIMEOUT_MS = "250";
	const { default: watchdogSubagents } = await import(
		`../extensions/subagents.ts?watchdog=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	delete process.env.PI_SUBAGENTS_STALL_TIMEOUT_MS;
	const tools = [];
	watchdogSubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const watchdogBeaconPath = join(
		runDir,
		"tasks",
		taskStorageKey("/root/watchdog"),
		"beacon.json",
	);
	const watchdogBeacon = parseJson(readFileSync(watchdogBeaconPath, "utf8"));
	watchdogBeacon.updatedAt = Date.now();
	writeFileSync(watchdogBeaconPath, JSON.stringify(watchdogBeacon));
	const waitAgent = tools.find((tool) => tool.name === "wait_agent");
	const controller = new AbortController();
	const safety = setTimeout(() => controller.abort(), 2000);
	const result = await waitAgent.execute(
		"wait-watchdog",
		{},
		controller.signal,
		undefined,
		{},
	);
	clearTimeout(safety);
	const payload = toolPayload(result);
	assert.equal(payload.attention.type, "stalled_agents");
	assert.deepEqual(payload.attention.task_paths, ["/root/watchdog"]);
	assert.match(payload.next_action, /restart_agent.*kill_agent/i);
	rmSync(runDir, { recursive: true, force: true });
});

test("runtime notices are delivered once without becoming pending questions", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-notice-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
		{
			name: "/root/done",
			taskId: "task-done",
			parent: "/root",
			taskName: "Finished task",
			state: "completed",
			startedAt: 2,
			updatedAt: 2,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	const rootInbox = join(runDir, "tasks", taskStorageKey("/root"), "inbox");
	mkdirSync(rootInbox, { recursive: true });
	writeFileSync(
		join(rootInbox, "notice.json"),
		JSON.stringify({
			id: "notice",
			from: "/root/done",
			to: "/root",
			body: "Finished report is ready",
			kind: "notice",
			ts: Date.now(),
		}),
	);
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: noticeSubagents } = await import(
		`../extensions/subagents.ts?notice=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	noticeSubagents({ registerTool: (tool) => tools.push(tool), on: () => {} });
	const wait = tools.find((tool) => tool.name === "wait_agent");
	const delivered = await wait.execute("deliver", {}, undefined, undefined, {});
	assert.match(toolPayload(delivered).message, /Finished report is ready/);
	const settled = await wait.execute("settled", {}, undefined, undefined, {});
	assert.equal(settled.details.display, "No agent work pending");
	rmSync(runDir, { recursive: true, force: true });
});

test("killing a terminal subtree clears its entire stale mailbox backlog", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-stale-event-"));
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	for (const beacon of [
		{
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
		{
			name: "/root/stale",
			taskId: "task-stale",
			parent: "/root",
			taskName: "Finished task with stale events",
			state: "completed",
			startedAt: 2,
			updatedAt: 2,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	const rootInbox = join(runDir, "tasks", taskStorageKey("/root"), "inbox");
	mkdirSync(rootInbox, { recursive: true });
	for (let index = 0; index < 25; index++)
		writeFileSync(
			join(rootInbox, `${index}.json`),
			JSON.stringify({
				id: `stale-${index}`,
				from: "/root/stale",
				to: "/root",
				body: `Stale report ${index}`,
				kind: "notice",
				ts: Date.now() + index,
			}),
		);
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: staleEventSubagents } = await import(
		`../extensions/subagents.ts?stale-event=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	staleEventSubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const killed = await byName
		.get("kill_agent")
		.execute("kill", { target: "*" }, undefined, undefined, {});
	assert.match(toolPayload(killed).message, /cleared 25 pending messages/i);
	assert.equal(readdirSync(rootInbox).length, 0);
	const staleBeacon = parseJson(
		readFileSync(
			join(runDir, "tasks", taskStorageKey("/root/stale"), "beacon.json"),
			"utf8",
		),
	);
	assert.equal(staleBeacon.state, "completed");
	const settled = await byName
		.get("wait_agent")
		.execute("settled", {}, undefined, undefined, {});
	assert.equal(settled.details.display, "No agent work pending");
	rmSync(runDir, { recursive: true, force: true });
});

test("a 50-level orchestration tree remains ordered and searchable", () => {
	const rows = flattenDashboardAgents(agents(50, true));
	assert.equal(rows.length, 50);
	assert.equal(rows[0].depth, 0);
	assert.equal(rows.at(-1).depth, 49);
	assert.match(rows.at(-1).agent.name, /agent_49$/);
});

test("compact status summarizes large teams without rendering every agent", () => {
	const summary = orchestrationSummary(agents(50));
	assert.match(summary, /^Subagents:/);
	assert.match(summary, /active/);
	assert.match(summary, /done/);
	assert.match(summary, /stopped/);
	assert.match(summary, /\/subagents/);
});

test("dashboard virtualizes 50 agents and obeys narrow and wide render widths", () => {
	const snapshot = {
		agents: agents(50, true),
		feed: ["/root→/root/agent_1: inspect"],
		transcript: [
			"user",
			"This is a deliberately long agent conversation line that should wrap across the full-screen transcript pane instead of being truncated before its final marker ENDMARK",
			"",
			"tool result · read",
			"ok",
		],
	};
	const dashboard = new SubagentDashboard(
		snapshot,
		"/root/agent_25",
		theme,
		() => {},
		() => {},
		() => 50,
	);
	for (const width of [20, 60, 120]) {
		const lines = dashboard.render(width);
		assert.equal(
			lines.length,
			50,
			`dashboard did not fill terminal height at width ${width}`,
		);
		assert.match(lines.join("\n"), /ENDMARK/);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`line exceeded width ${width}`,
		);
		dashboard.invalidate();
	}
});

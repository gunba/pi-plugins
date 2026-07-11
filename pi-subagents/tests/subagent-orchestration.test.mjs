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
	thinkingAtOrBelow,
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

test("deep canonical paths use fixed-size storage keys", () => {
	const deepPath = `/root/${Array.from({ length: 100 }, (_, index) => `task_${index}`).join("/")}`;
	assert.equal(taskStorageKey(deepPath).length, 43);
	assert.equal(taskStorageKey(deepPath), taskStorageKey(deepPath));
	assert.notEqual(
		taskStorageKey(`${deepPath}_other`),
		taskStorageKey(deepPath),
	);
});

test("subagent thinking cannot exceed its parent's level", () => {
	assert.equal(thinkingAtOrBelow(undefined, "high"), "high");
	assert.equal(thinkingAtOrBelow("low", "high"), "low");
	assert.equal(thinkingAtOrBelow("max", "max"), "max");
	assert.throws(() => thinkingAtOrBelow("xhigh", "high"), /exceeds/i);
	assert.throws(() => thinkingAtOrBelow("minimal", "off"), /exceeds/i);
});

test("root registration exposes tools without calling runtime actions during loading", () => {
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
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
			"inspect_agent",
			"control_agent",
		],
	);
	assert.ok(handlers.some(({ event }) => event === "agent_settled"));
	assert.ok(handlers.some(({ event }) => event === "thinking_level_select"));
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	assert.deepEqual(
		Object.keys(byName.get("spawn_agent").parameters.properties),
		["task_name", "message"],
	);
	assert.deepEqual(
		Object.keys(byName.get("send_message").parameters.properties),
		["target", "message", "reply_to"],
	);
	assert.deepEqual(
		Object.keys(byName.get("wait_agent").parameters.properties),
		["timeout_ms"],
	);
	const waitTool = byName.get("wait_agent");
	assert.equal(waitTool.parameters.properties.timeout_ms.minimum, 10_000);
	assert.equal(waitTool.parameters.properties.timeout_ms.maximum, 3_600_000);
	assert.equal(waitTool.parameters.properties.timeout_ms.default, undefined);
	assert.deepEqual(waitTool.prepareArguments({}), {});
	assert.deepEqual(waitTool.prepareArguments({ timeout_ms: 1000 }), {
		timeout_ms: 10_000,
	});
	assert.deepEqual(waitTool.prepareArguments({ timeout_ms: 9_000_000 }), {
		timeout_ms: 3_600_000,
	});
	assert.equal(
		byName.get("spawn_agent").parameters.additionalProperties,
		false,
	);
	assert.equal(typeof byName.get("spawn_agent").renderCall, "function");
	assert.equal(typeof byName.get("spawn_agent").renderResult, "function");
});

test("child registration exposes collaboration tools and keeps root controls private", async () => {
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
			"followup_task",
			"wait_agent",
			"interrupt_agent",
			"list_agents",
		],
	);
	rmSync(runDir, { recursive: true, force: true });
});

test("nested spawn denial leaves no child task storage", async () => {
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
	const childInbox = join(
		runDir,
		"tasks",
		taskStorageKey("/root/research"),
		"inbox",
	);
	writeFileSync(
		join(childInbox, "reply.json"),
		JSON.stringify({
			id: "reply",
			from: "/root",
			to: "/root/research",
			body: "deny: duplicate work",
			replyTo: request.id,
			kind: "notice",
			ts: Date.now(),
		}),
	);
	const result = await pending;
	clearTimeout(keepAlive);
	assert.match(toolPayload(result).error, /denied/i);
	const childrenDir = join(
		runDir,
		"tasks",
		taskStorageKey("/root/research"),
		"children",
	);
	assert.equal(existsSync(childrenDir), false);
	rmSync(runDir, { recursive: true, force: true });
});

test("model tools route exclusively by canonical task path", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-runtime-"));
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
			taskId: "task-secret",
			parent: "/root",
			taskName: "Research the implementation",
			state: "interrupted",
			startedAt: 2,
			updatedAt: 2,
		},
		{
			name: "/root/branch/deep",
			taskId: "task-deep",
			parent: "/root/branch",
			taskName: "Deep running task",
			state: "running",
			startedAt: 3,
			updatedAt: 3,
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
	const listed = await byName
		.get("list_agents")
		.execute("list", {}, undefined, undefined, {});
	const listPayload = toolPayload(listed);
	assert.deepEqual(
		listPayload.agents.map((agent) => agent.agent_name),
		["/root", "/root/branch/deep", "/root/research"],
	);
	assert.equal(listPayload.agents[2].agent_status, "interrupted");
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
			{ target: "/root/research", message: "hello" },
			undefined,
			undefined,
			{},
		);
	assert.deepEqual(toolPayload(delivered), {});
	const inbox = join(
		runDir,
		"tasks",
		taskStorageKey("/root/research"),
		"inbox",
	);
	assert.equal(readdirSync(inbox).length, 1);
	await assert.rejects(
		byName
			.get("wait_agent")
			.execute("wait-short", { timeout_ms: 9999 }, undefined, undefined, {}),
		/at least 10000/,
	);
	const waitController = new AbortController();
	const abortWait = setTimeout(() => waitController.abort(), 20);
	const unboundedWait = await byName
		.get("wait_agent")
		.execute("wait-unbounded", {}, waitController.signal, undefined, {});
	clearTimeout(abortWait);
	assert.deepEqual(toolPayload(unboundedWait), {
		message: "Wait interrupted by new input.",
		timed_out: false,
	});
	const interrupted = await byName
		.get("interrupt_agent")
		.execute(
			"interrupt",
			{ target: "/root/research" },
			undefined,
			undefined,
			{},
		);
	assert.equal(toolPayload(interrupted).previous_status, "interrupted");
	rmSync(runDir, { recursive: true, force: true });
});

test("interrupting a stale sender clears its claimed coordination event", async () => {
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
			taskName: "Finished task with stale event",
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
		join(rootInbox, "stale.json"),
		JSON.stringify({
			id: "stale-event",
			from: "/root/stale",
			to: "/root",
			body: "Repair this already-finished task",
			kind: "attention",
			ts: Date.now(),
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
	await byName.get("wait_agent").execute("claim", {}, undefined, undefined, {});
	const pending = await byName
		.get("wait_agent")
		.execute("pending", {}, undefined, undefined, {});
	assert.match(pending.details.display, /still pending/i);
	const interrupted = await byName
		.get("interrupt_agent")
		.execute("interrupt", { target: "/root/stale" }, undefined, undefined, {});
	assert.match(interrupted.details.display, /cleared the pending event/i);
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
	assert.match(summary, /need attention/);
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

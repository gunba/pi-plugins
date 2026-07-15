import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
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

test("child recovery continues twice, restarts, then salvages a summary", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-"));
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
			name: "/root/recovery",
			taskId: "task-recovery",
			parent: "/root",
			taskName: "Recover after random failures",
			task: "Complete the delegated work",
			state: "running",
			startedAt: 2,
			updatedAt: 2,
			recoveryStage: "idle",
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}

	process.env.PI_SUBAGENT_TASK_PATH = "/root/recovery";
	process.env.PI_SUBAGENT_PARENT_PATH = "/root";
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: recoverySubagents } = await import(
		`../extensions/subagents.ts?recovery=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_TASK_PATH;
	delete process.env.PI_SUBAGENT_PARENT_PATH;
	delete process.env.PI_SUBAGENT_RUN;

	const handlers = [];
	const followUps = [];
	recoverySubagents({
		registerTool: () => {},
		on: (event, handler) => handlers.push({ event, handler }),
		sendUserMessage: (message, options) => followUps.push({ message, options }),
	});
	const handler = (event) =>
		handlers.find((entry) => entry.event === event).handler;
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { total: 0 },
	};
	const failed = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "random provider failure",
		usage,
	};
	const successful = {
		role: "assistant",
		content: [],
		stopReason: "toolUse",
		usage,
	};
	const summary = {
		role: "assistant",
		content: [{ type: "text", text: "Best available result" }],
		stopReason: "stop",
		usage,
	};
	const settle = (message) => {
		handler("message_end")({ message });
		handler("agent_end")({ messages: [message] });
		handler("agent_settled")();
	};
	const beaconPath = join(
		runDir,
		"tasks",
		taskStorageKey("/root/recovery"),
		"beacon.json",
	);

	settle(failed);
	let beacon = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(beacon.state, "running");
	assert.equal(beacon.recoveryStage, "continued_once");
	assert.deepEqual(followUps, [
		{ message: "Continue", options: { deliverAs: "followUp" } },
	]);
	assert.equal(existsSync(join(runDir, "results")), false);
	assert.equal(
		existsSync(join(runDir, "tasks", taskStorageKey("/root"), "inbox")),
		false,
	);

	handler("message_end")({ message: successful });
	const recovered = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(recovered.recoveryStage, "idle");
	assert.equal(recovered.errorMessage, "");

	settle(failed);
	settle(failed);
	settle(failed);
	beacon = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(beacon.state, "restart_requested");
	assert.equal(beacon.recoveryStage, "continued_twice");
	assert.equal(followUps.length, 3);
	assert.equal(existsSync(join(runDir, "results")), false);
	assert.equal(
		existsSync(join(runDir, "tasks", taskStorageKey("/root"), "inbox")),
		false,
	);

	beacon.state = "running";
	beacon.generation = 2;
	beacon.recoveryStage = "restarted";
	writeFileSync(beaconPath, JSON.stringify(beacon));
	settle(failed);
	beacon = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(beacon.state, "summary_requested");
	assert.equal(beacon.recoveryStage, "restarted");
	assert.equal(followUps.length, 3);
	assert.equal(existsSync(join(runDir, "results")), false);
	assert.equal(
		existsSync(join(runDir, "tasks", taskStorageKey("/root"), "inbox")),
		false,
	);

	beacon.state = "running";
	beacon.generation = 3;
	beacon.recoveryStage = "summarizing";
	writeFileSync(beaconPath, JSON.stringify(beacon));
	settle(summary);
	const terminal = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(terminal.state, "completed");
	assert.equal(followUps.length, 3);
	const inbox = join(runDir, "tasks", taskStorageKey("/root"), "inbox");
	assert.equal(readdirSync(inbox).length, 1);
	assert.equal(readdirSync(join(runDir, "results")).length, 1);

	beacon = parseJson(readFileSync(beaconPath, "utf8"));
	beacon.state = "running";
	beacon.generation = 4;
	beacon.recoveryStage = "restarted";
	beacon.resultFile = "";
	writeFileSync(beaconPath, JSON.stringify(beacon));
	handler("agent_end")({ messages: [] });
	handler("agent_settled")();
	beacon = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(beacon.state, "summary_requested");
	assert.equal(beacon.recoveryStage, "restarted");
	assert.equal(readdirSync(inbox).length, 1);

	beacon.state = "running";
	beacon.generation = 5;
	beacon.recoveryStage = "summarizing";
	writeFileSync(beaconPath, JSON.stringify(beacon));
	settle({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "summary aborted",
		usage,
	});
	const summaryFailure = parseJson(readFileSync(beaconPath, "utf8"));
	assert.equal(summaryFailure.state, "error");
	assert.equal(readdirSync(inbox).length, 2);
	assert.equal(readdirSync(join(runDir, "results")).length, 2);
	rmSync(runDir, { recursive: true, force: true });
});

test("restart and summary requests reuse the same persisted session", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-auto-restart-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "pi-subagents-fake-cli-"));
	const fakeCli = join(fakeDir, "fake-pi.mjs");
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({ schemaVersion: 2, rootPath: "/root" }),
	);
	const rootDir = join(runDir, "tasks", taskStorageKey("/root"));
	mkdirSync(rootDir, { recursive: true });
	writeFileSync(
		join(rootDir, "beacon.json"),
		JSON.stringify({
			name: "/root",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		}),
	);
	writeFileSync(
		fakeCli,
		`import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const run = process.env.PI_SUBAGENT_RUN;
const self = process.env.PI_SUBAGENT_TASK_PATH;
const tasks = join(run, "tasks");
const dir = readdirSync(tasks).map((entry) => join(tasks, entry)).find((candidate) => {
  try { return JSON.parse(readFileSync(join(candidate, "beacon.json"), "utf8")).name === self; }
  catch { return false; }
});
const beaconPath = join(dir, "beacon.json");
const beacon = JSON.parse(readFileSync(beaconPath, "utf8"));
const countPath = join(run, "fake-count.txt");
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(count));
writeFileSync(join(run, \`fake-args-\${count}.json\`), JSON.stringify(process.argv.slice(2)));
if (count === 1) {
  const sessions = join(run, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, \`fake_\${beacon.taskId}.jsonl\`), "{}\\n");
  mkdirSync(join(dir, ".restart"));
  writeFileSync(join(dir, ".restart", "pid"), "2147483647\\n");
  beacon.state = "restart_requested";
  beacon.recoveryStage = "continued_twice";
  beacon.activity = "restarting";
} else if (count === 2) {
  const descendantName = self + "/nested";
  const descendantKey = createHash("sha256").update(descendantName, "utf8").digest("base64url");
  const descendantDir = join(tasks, descendantKey);
  mkdirSync(join(descendantDir, "inbox"), { recursive: true });
  writeFileSync(join(descendantDir, "beacon.json"), JSON.stringify({
    name: descendantName,
    taskId: "nested",
    parent: self,
    taskName: "Nested task",
    state: "queued",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));
  const parentInbox = join(dir, "inbox");
  mkdirSync(parentInbox, { recursive: true });
  writeFileSync(join(parentInbox, "nested-mail.json"), JSON.stringify({
    id: "nested-mail",
    from: descendantName,
    to: self,
    body: "unfinished nested work",
    kind: "notice",
    ts: Date.now(),
  }));
  beacon.state = "running";
  beacon.recoveryStage = "restarted";
  beacon.activity = "";
} else {
  beacon.state = "completed";
  beacon.activity = "";
  beacon.finishedAt = Date.now();
}
beacon.updatedAt = Date.now();
const beaconTemp = beaconPath + ".fake.tmp";
writeFileSync(beaconTemp, JSON.stringify(beacon));
renameSync(beaconTemp, beaconPath);
`,
	);

	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: restartSubagents } = await import(
		`../extensions/subagents.ts?auto-restart=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	restartSubagents({
		getThinkingLevel: () => "medium",
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const spawn = tools.find((tool) => tool.name === "spawn_agent");
	const originalEntry = process.argv[1];
	process.argv[1] = fakeCli;
	try {
		const result = await spawn.execute(
			"spawn",
			{ task_name: "recover", message: "Complete the original task" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		assert.equal(toolPayload(result).delegation_pending, true);
		const beaconPath = join(
			runDir,
			"tasks",
			taskStorageKey("/root/recover"),
			"beacon.json",
		);
		for (let attempt = 0; attempt < 100; attempt++) {
			const beacon = parseJson(readFileSync(beaconPath, "utf8"));
			if (beacon.state === "completed" && beacon.generation === 3) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const beacon = parseJson(readFileSync(beaconPath, "utf8"));
		assert.equal(beacon.state, "completed");
		assert.equal(beacon.generation, 3);
		assert.equal(beacon.task, "Complete the original task");
		assert.equal(readFileSync(join(runDir, "fake-count.txt"), "utf8"), "3");
		const secondArgs = parseJson(
			readFileSync(join(runDir, "fake-args-2.json"), "utf8"),
		);
		assert.equal(secondArgs[1], "Continue");
		assert.ok(secondArgs.includes("--session"));
		assert.equal(secondArgs.includes("--session-id"), false);
		const thirdArgs = parseJson(
			readFileSync(join(runDir, "fake-args-3.json"), "utf8"),
		);
		assert.match(thirdArgs[1], /best available result/i);
		assert.ok(thirdArgs.includes("--session"));
		assert.ok(thirdArgs.includes("--no-tools"));
		const descendant = parseJson(
			readFileSync(
				join(
					runDir,
					"tasks",
					taskStorageKey("/root/recover/nested"),
					"beacon.json",
				),
				"utf8",
			),
		);
		assert.equal(descendant.state, "hard_killed");
		assert.equal(
			readdirSync(
				join(
					runDir,
					"tasks",
					taskStorageKey("/root/recover"),
					"inbox",
				),
			).length,
			0,
		);
		assert.equal(existsSync(join(rootDir, "inbox")), false);
	} finally {
		process.argv[1] = originalEntry;
		rmSync(runDir, { recursive: true, force: true });
		rmSync(fakeDir, { recursive: true, force: true });
	}
});

test("the coordination gate stays closed across the restart handoff", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-restart-gate-"));
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
			name: "/root/recovering",
			taskId: "task-recovering",
			parent: "/root",
			taskName: "Recovering task",
			state: "restarting",
			recoveryStage: "restarted",
			startedAt: 2,
			updatedAt: 2,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	const children = join(
		runDir,
		"tasks",
		taskStorageKey("/root"),
		"children",
	);
	mkdirSync(children);
	writeFileSync(
		join(children, taskStorageKey("/root/recovering")),
		"/root/recovering",
	);
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: restartGateSubagents } = await import(
		`../extensions/subagents.ts?restart-gate=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const handlers = [];
	restartGateSubagents({
		registerTool: () => {},
		on: (event, handler) => handlers.push({ event, handler }),
	});
	const gate = handlers
		.find(({ event }) => event === "tool_call")
		.handler({ toolName: "read" });
	assert.equal(gate.block, true);
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

test("an exhausted stalled task is stopped before failure is reported", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-stalled-"));
	const live = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
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
			recoveryStage: "summarizing",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(live.pid));
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
	assert.deepEqual(payload.attention.task_paths, ["/root/stalled"]);
	assert.equal(payload.delegation_pending, false);
	assert.match(payload.next_action, /handle the reported task failure/i);
	assert.doesNotMatch(payload.next_action, /^Call wait_agent/);
	assert.equal(
		parseJson(
			readFileSync(
				join(
					runDir,
					"tasks",
					taskStorageKey("/root/stalled"),
					"beacon.json",
				),
				"utf8",
			),
		).state,
		"error",
	);
	rmSync(runDir, { recursive: true, force: true });
});

test("fatal nested recovery is reported to the immediate parent only", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-nested-failure-"));
	const parentProcess = spawnProcess(process.execPath, [
		"-e",
		"setInterval(() => {}, 1000)",
	]);
	const childProcess = spawnProcess(process.execPath, [
		"-e",
		"setInterval(() => {}, 1000)",
	]);
	const staleAt = Date.now() - 700_000;
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
			startedAt: staleAt,
			updatedAt: staleAt,
		},
		{
			name: "/root/parent",
			taskId: "task-parent",
			parent: "/root",
			taskName: "Parent task",
			state: "waiting",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
		{
			name: "/root/parent/child",
			taskId: "task-child",
			parent: "/root/parent",
			taskName: "Child task",
			state: "running",
			recoveryStage: "summarizing",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"));
			writeFileSync(
				join(dir, ".active", "pid"),
				String(
					beacon.name === "/root/parent"
						? parentProcess.pid
						: childProcess.pid,
				),
			);
		}
	}
	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: nestedFailureSubagents } = await import(
		`../extensions/subagents.ts?nested-failure=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	nestedFailureSubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const wait = tools.find((tool) => tool.name === "wait_agent");
	const controller = new AbortController();
	const interrupt = setTimeout(() => controller.abort(), 200);
	try {
		const result = await wait.execute(
			"wait",
			{},
			controller.signal,
			undefined,
			{ cwd: process.cwd() },
		);
		assert.equal(toolPayload(result).attention, undefined);
		const parentInbox = join(
			runDir,
			"tasks",
			taskStorageKey("/root/parent"),
			"inbox",
		);
		assert.equal(readdirSync(parentInbox).length, 1);
		const notice = parseJson(
			readFileSync(join(parentInbox, readdirSync(parentInbox)[0]), "utf8"),
		);
		assert.equal(notice.from, "/root/parent/child");
		assert.equal(notice.to, "/root/parent");
		assert.equal(notice.kind, "attention");
		const childBeacon = parseJson(
			readFileSync(
				join(
					runDir,
					"tasks",
					taskStorageKey("/root/parent/child"),
					"beacon.json",
				),
				"utf8",
			),
		);
		assert.equal(childBeacon.state, "error");
	} finally {
		clearTimeout(interrupt);
		for (const child of [parentProcess, childProcess]) {
			if (!child.pid) continue;
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {}
		}
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("watchdog recovers orphaned restart and summary requests without waking the main agent", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-stall-recovery-"));
	const fakeDir = mkdtempSync(join(tmpdir(), "pi-subagents-stall-cli-"));
	const fakeCli = join(fakeDir, "fake-pi.mjs");
	const staleAt = Date.now() - 700_000;
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
			startedAt: staleAt,
			updatedAt: staleAt,
		},
		{
			name: "/root/stalled",
			taskId: "task-stalled-auto",
			parent: "/root",
			taskName: "Stalled task",
			task: "Complete stalled work",
			state: "restart_requested",
			recoveryStage: "continued_twice",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
		{
			name: "/root/summary",
			taskId: "task-summary-auto",
			parent: "/root",
			taskName: "Summary task",
			task: "Summarize stalled work",
			state: "summary_requested",
			recoveryStage: "restarted",
			startedAt: staleAt,
			updatedAt: staleAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
	}
	const sessions = join(runDir, "sessions");
	mkdirSync(sessions, { recursive: true });
	for (const taskId of ["task-stalled-auto", "task-summary-auto"]) {
		const sessionFile = join(sessions, `fake_${taskId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		utimesSync(sessionFile, staleAt / 1000, staleAt / 1000);
	}
	const stalledDir = join(
		runDir,
		"tasks",
		taskStorageKey("/root/stalled"),
	);
	writeFileSync(
		fakeCli,
		`import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const run = process.env.PI_SUBAGENT_RUN;
const self = process.env.PI_SUBAGENT_TASK_PATH;
const tasks = join(run, "tasks");
const dir = readdirSync(tasks).map((entry) => join(tasks, entry)).find((candidate) => {
  try { return JSON.parse(readFileSync(join(candidate, "beacon.json"), "utf8")).name === self; }
  catch { return false; }
});
const beaconPath = join(dir, "beacon.json");
const beacon = JSON.parse(readFileSync(beaconPath, "utf8"));
writeFileSync(join(run, \`watchdog-args-\${beacon.taskId}.json\`), JSON.stringify(process.argv.slice(2)));
beacon.state = "completed";
beacon.activity = "";
beacon.updatedAt = Date.now();
beacon.finishedAt = Date.now();
const beaconTemp = beaconPath + ".fake.tmp";
writeFileSync(beaconTemp, JSON.stringify(beacon));
renameSync(beaconTemp, beaconPath);
`,
	);

	process.env.PI_SUBAGENT_RUN = runDir;
	const { default: stalledRecoverySubagents } = await import(
		`../extensions/subagents.ts?stall-recovery=${Date.now()}`
	);
	delete process.env.PI_SUBAGENT_RUN;
	const tools = [];
	stalledRecoverySubagents({
		registerTool: (tool) => tools.push(tool),
		on: () => {},
	});
	const wait = tools.find((tool) => tool.name === "wait_agent");
	const originalEntry = process.argv[1];
	process.argv[1] = fakeCli;
	const controller = new AbortController();
	const safety = setTimeout(() => controller.abort(), 10_000);
	try {
		const result = await wait.execute(
			"wait",
			{},
			controller.signal,
			undefined,
			{ cwd: process.cwd() },
		);
		const payload = toolPayload(result);
		assert.equal(payload.delegation_pending, false);
		assert.equal(payload.attention, undefined);
		const beacon = parseJson(
			readFileSync(join(stalledDir, "beacon.json"), "utf8"),
		);
		assert.equal(beacon.state, "completed");
		assert.equal(beacon.generation, 2);
		assert.equal(beacon.recoveryStage, "restarted");
		const args = parseJson(
			readFileSync(
				join(runDir, "watchdog-args-task-stalled-auto.json"),
				"utf8",
			),
		);
		assert.equal(args[1], "Continue");
		assert.ok(args.includes("--session"));
		const summaryDir = join(
			runDir,
			"tasks",
			taskStorageKey("/root/summary"),
		);
		const summaryBeacon = parseJson(
			readFileSync(join(summaryDir, "beacon.json"), "utf8"),
		);
		assert.equal(summaryBeacon.state, "completed");
		assert.equal(summaryBeacon.generation, 2);
		assert.equal(summaryBeacon.recoveryStage, "summarizing");
		const summaryArgs = parseJson(
			readFileSync(
				join(runDir, "watchdog-args-task-summary-auto.json"),
				"utf8",
			),
		);
		assert.match(summaryArgs[1], /best available result/i);
		assert.ok(summaryArgs.includes("--session"));
		assert.ok(summaryArgs.includes("--no-tools"));
	} finally {
		clearTimeout(safety);
		process.argv[1] = originalEntry;
		rmSync(runDir, { recursive: true, force: true });
		rmSync(fakeDir, { recursive: true, force: true });
	}
});

test("stall watchdog wakes wait_agent without a separate overseer model", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-subagents-watchdog-"));
	const live = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
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
			recoveryStage: "summarizing",
			startedAt,
			updatedAt: startedAt,
		},
	]) {
		const dir = join(runDir, "tasks", taskStorageKey(beacon.name));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
		if (beacon.name !== "/root") {
			mkdirSync(join(dir, ".active"), { recursive: true });
			writeFileSync(join(dir, ".active", "pid"), String(live.pid));
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
	assert.equal(payload.delegation_pending, false);
	assert.match(payload.next_action, /handle the reported task failure/i);
	assert.equal(
		parseJson(readFileSync(watchdogBeaconPath, "utf8")).state,
		"error",
	);
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

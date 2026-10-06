import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents.ts";
import { createSubagentToolDefinitions } from "../extensions/subagent-tools.ts";

function extensionHarness() {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-contract-"));
	const manager = SessionManager.create(root, join(root, "sessions"), {
		id: randomUUID(),
	});
	const tools = [];
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		events: createEventBus(),
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerShortcut() {},
		appendEntry(type, data) {
			manager.appendCustomEntry(type, data);
		},
		sendMessage() {},
		getActiveTools() {
			return ["read", "bash", ...tools.map((tool) => tool.name)];
		},
	};
	const ui = {
		setWidget() {},
		setStatus() {},
		notify() {},
	};
	const ctx = {
		cwd: root,
		sessionManager: manager,
		modelRegistry: { find: (provider, id) => ({ provider, id }) },
		ui,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
	};
	subagents(pi);
	return { root, manager, tools, handlers, commands, ctx };
}

test("root exposes subagent primitives and Codex-style waiting", async () => {
	const harness = extensionHarness();
	try {
		assert.equal(harness.tools.length, 6, "agent and wait tools register during discovery");
		for (const handler of harness.handlers.get("session_start")) await handler({}, harness.ctx);
		assert.deepEqual(
			harness.tools.map((tool) => tool.name),
			[
				"wait_agent",
				"spawn_agent",
				"send_message",
				"followup_task",
				"interrupt_agent",
				"list_agents",
			],
		);
		for (const removed of [
			"subagent",
			"subagent_fork",
			"restart_agent",
			"wait_for_work",
			"cancel_work_wait",
			"kill_agent",
		])
			assert.equal(harness.tools.some((tool) => tool.name === removed), false);
		assert.equal(harness.handlers.has("tool_call"), false, "no ordinary-tool gate");
		assert.equal(harness.handlers.has("agent_settled"), true, "settled hook flushes already-admitted notices without creating a wait loop");
		assert.ok(harness.commands.has("subagents"));
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("spawn schema requires task_name and message without foreground controls", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const byName = new Map(harness.tools.map((tool) => [tool.name, tool]));
		const tool = byName.get("spawn_agent");
		const schema = tool.parameters;
		assert.deepEqual(Object.keys(schema.properties), ["task_name", "message", "fork_turns", "model", "reasoning_effort"]);
		assert.deepEqual(schema.required, ["task_name", "message"]);
		assert.equal(schema.additionalProperties, false);
		assert.match(tool.description, /asynchronous/i);
		assert.match(tool.promptGuidelines.join(" "), /continue useful work/i);
		assert.doesNotMatch(tool.promptGuidelines.join(" "), /wait_agent|blocked/i);
		assert.match(schema.properties.fork_turns.description, /all \(default\).*none.*positive integer/);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("control schemas pin boundary delivery, current-turn interrupt, and discovery semantics", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const byName = new Map(harness.tools.map((tool) => [tool.name, tool]));
		assert.deepEqual(
			Object.keys(byName.get("send_message").parameters.properties),
			["target", "message"],
		);
		assert.match(byName.get("send_message").description, /parent, sibling or child/i);
		assert.match(byName.get("send_message").description, /does not start an idle agent/i);
		assert.match(byName.get("followup_task").description, /next safe boundary/i);
		assert.deepEqual(
			Object.keys(byName.get("interrupt_agent").parameters.properties),
			["target"],
		);
		assert.match(byName.get("interrupt_agent").description, /current turn/i);
		assert.match(byName.get("list_agents").description, /registered agent tree/i);
		assert.deepEqual(Object.keys(byName.get("list_agents").parameters.properties), ["path_prefix"]);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("registered root tools resolve the replacement runtime after branch navigation", async () => {
	const harness = extensionHarness();
	try {
		for (const handler of harness.handlers.get("session_start")) await handler({}, harness.ctx);
		const listTool = harness.tools.find((tool) => tool.name === "list_agents");
		for (const handler of harness.handlers.get("session_tree")) await handler({}, harness.ctx);
		const result = await listTool.execute(
			"list-after-tree",
			{},
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		assert.deepEqual(result.structuredContent.agents, [{ agent_name: "/root", agent_id: harness.manager.getSessionId(), agent_status: "idle" }]);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("root and child modes use the same messaging primitives without report", () => {
	const runtime = {};
	const binding = { getAuthority: () => ({}) };
	assert.deepEqual(
		createSubagentToolDefinitions(runtime, binding, "root").map((tool) => tool.name),
		["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents"],
	);
	assert.deepEqual(
		createSubagentToolDefinitions(runtime, binding, "one-shot").map((tool) => tool.name),
		["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents"],
	);
	const continuable = createSubagentToolDefinitions(runtime, binding, "continuable");
	assert.deepEqual(continuable.map(tool => tool.name), ["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents"]);
	assert.equal(continuable.some(tool => tool.name === "report"), false);
});

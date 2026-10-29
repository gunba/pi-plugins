import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import subagents from "../subagents/subagents.ts";
import { createSubagentToolDefinitions } from "../subagents/subagent-tools.ts";

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

test("root exposes the agent tools and none of the earlier ones", async () => {
	const harness = extensionHarness();
	try {
		assert.equal(harness.tools.length, 4, "agent tools register during discovery");
		for (const handler of harness.handlers.get("session_start")) await handler({}, harness.ctx);
		assert.deepEqual(harness.tools.map((tool) => tool.name), ["agent_start", "agent_send", "agent_list", "agent_stop"]);
		for (const removed of ["wait_agent", "spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents",
			"subagent", "subagent_fork", "restart_agent", "wait_for_work", "cancel_work_wait", "kill_agent"])
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

test("agent_start requires a task and a name and tells primary from secondary agents", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const tool = harness.tools.find((tool) => tool.name === "agent_start");
		const schema = tool.parameters;
		assert.deepEqual(Object.keys(schema.properties), ["task", "name", "primary", "context", "computer", "cwd", "model", "reasoning", "wake"]);
		assert.deepEqual(schema.required, ["task", "name"]);
		assert.equal(schema.additionalProperties, false);
		assert.match(tool.description, /background/i);
		assert.match(schema.properties.primary.description, /conversation in Jordan's Desk/);
		assert.match(tool.promptGuidelines.join(" "), /report back by themselves/i);
		assert.match(tool.promptGuidelines.join(" "), /peer context, not Jordan's instructions or approval/);
		assert.doesNotMatch(tool.promptGuidelines.join(" "), /wait_agent|polling/i);
		assert.equal(tool.exposure, undefined, "declared in every request");
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("message, list and stop schemas", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const byName = new Map(harness.tools.map((tool) => [tool.name, tool]));
		assert.deepEqual(Object.keys(byName.get("agent_send").parameters.properties), ["to", "message", "wake", "files"]);
		assert.match(byName.get("agent_send").parameters.properties.wake.description, /idle agent starts/i);
		assert.deepEqual(Object.keys(byName.get("agent_list").parameters.properties), ["query", "offline", "offset"]);
		assert.deepEqual(Object.keys(byName.get("agent_stop").parameters.properties), ["agent", "note"]);
		assert.match(byName.get("agent_stop").description, /current turn is interrupted/i);
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
		const listTool = harness.tools.find((tool) => tool.name === "agent_list");
		for (const handler of harness.handlers.get("session_tree")) await handler({}, harness.ctx);
		const result = await listTool.execute(
			"list-after-tree",
			{},
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		assert.deepEqual(result.structuredContent.secondary, [{ agent_name: "/root", agent_id: harness.manager.getSessionId(), agent_status: "idle" }]);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("root and child modes use the same agent tools", () => {
	const runtime = {};
	const binding = { getAuthority: () => ({}) };
	for (const mode of ["root", "one-shot", "continuable"])
		assert.deepEqual(createSubagentToolDefinitions(runtime, binding, mode).map((tool) => tool.name), ["agent_start", "agent_send", "agent_list", "agent_stop"]);
});

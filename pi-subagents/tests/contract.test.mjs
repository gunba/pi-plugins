import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
	};
	subagents(pi);
	return { root, manager, tools, handlers, commands, ctx };
}

test("root exposes only the DSH-standard subagent contract", async () => {
	const harness = extensionHarness();
	try {
		assert.deepEqual(harness.tools, [], "tools register after session identity is known");
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		assert.deepEqual(
			harness.tools.map((tool) => tool.name),
			[
				"subagent",
				"subagent_fork",
				"send_message",
				"interrupt_agent",
				"list_agents",
			],
		);
		for (const removed of [
			"spawn_agent",
			"restart_agent",
			"wait_agent",
			"kill_agent",
		])
			assert.equal(harness.tools.some((tool) => tool.name === removed), false);
		assert.equal(harness.handlers.has("tool_call"), false, "no ordinary-tool gate");
		assert.equal(harness.handlers.has("agent_settled"), false, "no forced wait loop");
		assert.ok(harness.commands.has("subagents"));
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("delegation schemas require description and prompt and default to background in execution", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const byName = new Map(harness.tools.map((tool) => [tool.name, tool]));
		for (const name of ["subagent", "subagent_fork"]) {
			const schema = byName.get(name).parameters;
			assert.deepEqual(Object.keys(schema.properties), [
				"description",
				"prompt",
				"run_in_background",
			]);
			assert.deepEqual(schema.required, ["description", "prompt"]);
			assert.equal(schema.additionalProperties, false);
			assert.match(byName.get(name).description, /background by default/i);
			assert.match(byName.get(name).promptGuidelines.join(" "), /continue useful work/i);
			assert.doesNotMatch(byName.get(name).promptGuidelines.join(" "), /wait_agent|blocked/i);
		}
		assert.match(
			byName.get("subagent").parameters.properties.prompt.description,
			/cannot see this conversation/i,
		);
		assert.match(
			byName.get("subagent_fork").parameters.properties.prompt.description,
			/completed parent turns/i,
		);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("control schemas pin FIFO, current-turn interrupt, and discovery semantics", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const byName = new Map(harness.tools.map((tool) => [tool.name, tool]));
		assert.deepEqual(
			Object.keys(byName.get("send_message").parameters.properties),
			["subagent_id", "message"],
		);
		assert.match(byName.get("send_message").description, /FIFO later turn/i);
		assert.match(byName.get("send_message").description, /never the child's answer/i);
		assert.deepEqual(
			Object.keys(byName.get("interrupt_agent").parameters.properties),
			["agent_id"],
		);
		assert.match(byName.get("interrupt_agent").description, /current turn/i);
		assert.match(byName.get("list_agents").description, /not polling/i);
		assert.deepEqual(
			byName.get("list_agents").parameters.properties.scope.enum,
			["children", "descendants"],
		);
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("registered root tools resolve the replacement runtime after branch navigation", async () => {
	const harness = extensionHarness();
	try {
		await harness.handlers.get("session_start")[0]({}, harness.ctx);
		const listTool = harness.tools.find((tool) => tool.name === "list_agents");
		await harness.handlers.get("session_tree")[0]({}, harness.ctx);
		const result = await listTool.execute(
			"list-after-tree",
			{},
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		assert.equal(result.content[0].text, "(no subagents)");
	} finally {
		for (const handler of harness.handlers.get("session_shutdown") ?? [])
			await handler({}, harness.ctx);
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test("report is child-scoped and appears only for continuable children", () => {
	const runtime = {};
	const binding = { getAuthority: () => ({}) };
	assert.deepEqual(
		createSubagentToolDefinitions(runtime, binding, "root").map((tool) => tool.name),
		["subagent", "subagent_fork", "send_message", "interrupt_agent", "list_agents"],
	);
	assert.deepEqual(
		createSubagentToolDefinitions(runtime, binding, "one-shot").map((tool) => tool.name),
		["subagent", "subagent_fork", "send_message", "interrupt_agent", "list_agents"],
	);
	const continuable = createSubagentToolDefinitions(runtime, binding, "continuable");
	assert.equal(continuable.at(-1).name, "report");
	assert.match(continuable.at(-1).description, /does not end this turn/i);
	assert.match(continuable.at(-1).description, /direct parent/i);
});

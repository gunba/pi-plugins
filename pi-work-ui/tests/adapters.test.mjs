import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../pi-goal/extensions/goal.ts";
import todoExtension from "../../pi-todo/extensions/todo.ts";
import { GOAL_CHANGE_ENTRY } from "../../pi-goal/src/constants.ts";
import { TODO_WRITE_ENTRY } from "../../pi-todo/model.ts";

function harness() {
	const bus = createEventBus();
	const handlers = new Map(); const tools = new Map(); const commands = new Map();
	const branch = []; const widgets = new Map();
	let toolExpansionReads = 0;
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	const ctx = {
		mode: "tui", hasUI: true,
		sessionManager: { getSessionId() { return "combined-ui-fixture"; }, getBranch() { return branch; } },
		isIdle() { return false; }, hasPendingMessages() { return false; },
		ui: {
			notify() {},
			getToolsExpanded() { toolExpansionReads++; throw Error("native tool expansion must not control the work panel"); },
			setWidget(key, factory) { widgets.get(key)?.dispose(); if (factory) widgets.set(key, factory({ requestRender() {} }, theme)); else widgets.delete(key); },
		},
	};
	const api = () => ({
		events: { on: (...args) => bus.on(...args), emit: (...args) => bus.emit(...args) },
		on(name, callback) { const callbacks = handlers.get(name) ?? []; callbacks.push(callback); handlers.set(name, callbacks); },
		registerTool(tool) { assert.ok(!tools.has(tool.name), tool.name); tools.set(tool.name, tool); },
		registerCommand(name, command) { assert.ok(!commands.has(name), name); commands.set(name, command); },
		registerEntryRenderer() {}, registerMessageRenderer() {},
		appendEntry(customType, data) { branch.push({ id: `entry-${branch.length}`, type: "custom", customType, data, timestamp: new Date().toISOString() }); },
	});
	goalExtension(api()); todoExtension(api());
	return {
		ctx, branch, widgets, commands,
		async emit(name) { for (const callback of handlers.get(name) ?? []) await callback({}, ctx); },
		async todos(todos) { return tools.get("todo_write").execute("todo", { todos }, undefined, undefined, ctx); },
		async goal(text) { await commands.get("goal").handler(text, ctx); },
		text() { return widgets.get("pi-work")?.render(100).join("\n") ?? ""; },
		reads: () => toolExpansionReads,
	};
}

test("actual goal and todo adapters share one compact panel without changing stored text or goal authority", async () => {
	const h = harness();
	await h.emit("session_start");
	assert.deepEqual([...h.commands.keys()], ["work", "goal"]);
	const objective = Array.from({ length: 80 }, (_, i) => `Complete stage ${i}`).join("\n\n");
	await h.goal(objective);
	await h.todos([{ content: "Current verification", status: "in_progress" }]);
	assert.deepEqual([...h.widgets.keys()], ["pi-work"]);
	assert.ok(h.text().split("\n").length <= 3);
	assert.match(h.text(), /Goal active/);
	assert.match(h.text(), /Todos 0\/1 done/);
	assert.doesNotMatch(h.text(), /Complete stage 79/);
	assert.equal(h.reads(), 0);
	const goalEntry = h.branch.find((entry) => entry.customType === GOAL_CHANGE_ENTRY);
	assert.ok(goalEntry);
	assert.ok(JSON.stringify(goalEntry.data).includes("Complete stage 79"));
	assert.equal(h.branch.find((entry) => entry.customType === TODO_WRITE_ENTRY).data.todos[0].content, "Current verification");
	await h.emit("session_shutdown");
	assert.equal(h.widgets.size, 0);
});

test("actual adapters restore branch-local snapshots, disarm goals and clear only todos at the next run", async () => {
	const h = harness(); await h.emit("session_start");
	await h.goal("Branch A objective");
	await h.todos([{ content: "Branch A task", status: "pending" }]);
	await h.emit("session_tree");
	assert.match(h.text(), /Goal active · disarmed/);
	assert.match(h.text(), /Branch A task/);
	await h.emit("before_agent_start");
	assert.match(h.text(), /Branch A objective/);
	assert.doesNotMatch(h.text(), /Todos/);
	h.branch.length = 0;
	await h.emit("session_tree");
	assert.equal(h.widgets.size, 0);
	await h.emit("session_shutdown");
});

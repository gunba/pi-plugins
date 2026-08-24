import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension, {
	TodoWriteParameters,
	createTodoExtension,
	todoWidgetLines,
} from "../extensions/todo.ts";
import { TODO_CLEAR_ENTRY, TODO_WRITE_ENTRY } from "../model.ts";

initTheme("dark", false);

function createHarness(extension = todoExtension) {
	const tools = new Map();
	const events = new Map();
	const appended = [];
	const branch = [];
	const widgetCalls = [];
	let nextId = 1;
	let expanded = false;

	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
			branch.push({
				type: "custom",
				id: `entry-${nextId++}`,
				parentId: branch.at(-1)?.id ?? null,
				customType,
				data,
			});
		},
	};

	const theme = {
		fg(_colour, text) { return text; },
		bg(_colour, text) { return text; },
		bold(text) { return text; },
	};
	const ctx = {
		mode: "tui",
		sessionManager: {
			getBranch() { return branch; },
		},
		ui: {
			setWidget(key, value, options) {
				widgetCalls.push({ key, value, options });
			},
			getToolsExpanded() { return expanded; },
		},
	};

	extension(pi);
	return {
		tools,
		events,
		appended,
		branch,
		widgetCalls,
		theme,
		ctx,
		setExpanded(value) { expanded = value; },
		async emit(name, event = {}) {
			for (const handler of events.get(name) ?? []) await handler(event, ctx);
		},
		currentWidget() {
			return widgetCalls.at(-1);
		},
	};
}

async function execute(tool, params, ctx) {
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("registers the exact closed todo_write schema and no separate prompt metadata", () => {
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()], ["todo_write"]);
	const tool = harness.tools.get("todo_write");
	assert.equal(tool.label, "Update todo list");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.promptSnippet, undefined);
	assert.equal(tool.promptGuidelines, undefined);

	assert.deepEqual(Object.keys(TodoWriteParameters.properties), ["todos"]);
	assert.deepEqual(TodoWriteParameters.required, ["todos"]);
	assert.equal(TodoWriteParameters.additionalProperties, false);
	const item = TodoWriteParameters.properties.todos.items;
	assert.deepEqual(Object.keys(item.properties), ["content", "status"]);
	assert.deepEqual(item.required, ["content", "status"]);
	assert.equal(item.additionalProperties, false);
	assert.deepEqual(item.properties.status.enum, ["pending", "in_progress", "completed"]);
});

test("default policy permits parallel active work and returns the exact canonical result", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const result = await execute(tool, { todos: [
		{ content: "  first  ", status: "in_progress" },
		{ content: "second", status: "in_progress" },
		{ content: "later", status: "pending" },
	] }, harness.ctx);

	assert.equal(result.content[0].text, "Updated todo list: 1 pending, 2 in progress, 0 completed.");
	assert.deepEqual(result.details, {
		todos: [
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "in_progress" },
			{ content: "later", status: "pending" },
		],
		counts: { pending: 1, inProgress: 2, completed: 0 },
	});
	assert.deepEqual(harness.appended, [{
		customType: TODO_WRITE_ENTRY,
		data: { todos: result.details.todos },
	}]);
	assert.equal(harness.currentWidget().key, "pi-todo");
	assert.deepEqual(harness.currentWidget().options, { placement: "aboveEditor" });
});

test("single-active factory rejects parallel work without appending or changing the widget", async () => {
	const harness = createHarness(createTodoExtension({ allowParallelInProgress: false }));
	const tool = harness.tools.get("todo_write");
	await assert.rejects(
		() => execute(tool, { todos: [
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "in_progress" },
		] }, harness.ctx),
		{ message: "invalid todos: at most one task may be in_progress (got 2)" },
	);
	assert.deepEqual(harness.appended, []);
	assert.deepEqual(harness.widgetCalls, []);
});

test("content validation failures append no durable write", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	await assert.rejects(
		() => execute(tool, { todos: [{ content: "   ", status: "pending" }] }, harness.ctx),
		{ message: "invalid todo: `content` must be a non-empty string" },
	);
	await assert.rejects(
		() => execute(tool, { todos: [
			{ content: "duplicate", status: "pending" },
			{ content: " duplicate ", status: "completed" },
		] }, harness.ctx),
		{ message: 'invalid todos: duplicate content "duplicate"' },
	);
	assert.deepEqual(harness.appended, []);
	assert.deepEqual(harness.widgetCalls, []);
});

test("execution without a Pi session reports the owning-session error", async () => {
	const harness = createHarness();
	await assert.rejects(
		() => execute(harness.tools.get("todo_write"), { todos: [] }, undefined),
		{ message: "todo_write requires an owning agent session" },
	);
	assert.deepEqual(harness.appended, []);
});

test("a successful second write replaces the projected widget value", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	await execute(tool, { todos: [{ content: "old", status: "pending" }] }, harness.ctx);
	await execute(tool, { todos: [{ content: "new", status: "completed" }] }, harness.ctx);
	const widget = harness.currentWidget().value(null, harness.theme);
	assert.match(widget.render(100).join("\n"), /1 completed/);
	assert.doesNotMatch(widget.render(100).join("\n"), /old/);
	harness.setExpanded(true);
	assert.match(widget.render(100).join("\n"), /new/);
});

test("next agent run appends a hidden clear and removes the standing widget", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	await execute(tool, { todos: [{ content: "done", status: "completed" }] }, harness.ctx);
	const callsBefore = harness.widgetCalls.length;
	await harness.emit("before_agent_start", { prompt: "next task" });
	assert.equal(harness.appended.at(-1).customType, TODO_CLEAR_ENTRY);
	assert.deepEqual(harness.appended.at(-1).data, {});
	assert.equal(harness.widgetCalls.length, callsBefore + 1);
	assert.equal(harness.currentWidget().value, undefined);
});

test("agent settlement and turn events do not clear the widget", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	await execute(tool, { todos: [{ content: "done", status: "completed" }] }, harness.ctx);
	const callCount = harness.widgetCalls.length;
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");
	assert.equal(harness.widgetCalls.length, callCount);
	assert.equal(harness.appended.length, 1);
});

test("session_start and session_tree restore the selected branch", async () => {
	const harness = createHarness();
	harness.branch.push({
		type: "custom",
		customType: TODO_WRITE_ENTRY,
		data: { todos: [{ content: "branch A", status: "in_progress" }] },
	});
	await harness.emit("session_start", { reason: "resume" });
	harness.setExpanded(true);
	let rendered = harness.currentWidget().value(null, harness.theme).render(100).join("\n");
	assert.match(rendered, /branch A/);

	harness.branch.push({ type: "custom", customType: TODO_CLEAR_ENTRY, data: {} });
	await harness.emit("session_tree", { newLeafId: "clear" });
	assert.equal(harness.currentWidget().value, undefined);

	harness.branch.push({
		type: "custom",
		customType: TODO_WRITE_ENTRY,
		data: { todos: [{ content: "branch B", status: "pending" }] },
	});
	await harness.emit("session_tree", { newLeafId: "branch-b" });
	rendered = harness.currentWidget().value(null, harness.theme).render(100).join("\n");
	assert.match(rendered, /branch B/);
});

test("restore rejects malformed durable writes and clears a previous widget first", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	await execute(tool, { todos: [{ content: "valid", status: "pending" }] }, harness.ctx);
	harness.branch.push({ type: "custom", customType: TODO_WRITE_ENTRY, data: { todos: [{ content: " bad ", status: "pending" }] } });
	await assert.rejects(
		() => harness.emit("session_tree"),
		{ message: "todo/write content must be non-empty and already trimmed" },
	);
	assert.equal(harness.currentWidget().value, undefined);
});

test("empty replacement is durable but hides the widget", async () => {
	const harness = createHarness();
	const result = await execute(harness.tools.get("todo_write"), { todos: [] }, harness.ctx);
	assert.deepEqual(result.details.todos, []);
	assert.equal(result.content[0].text, "Updated todo list: 0 pending, 0 in progress, 0 completed.");
	assert.equal(harness.appended.at(-1).customType, TODO_WRITE_ENTRY);
	assert.equal(harness.currentWidget().value, undefined);
});

test("standing widget starts compact, expands in item order, and respects width", () => {
	const theme = {
		fg(_colour, text) { return text; },
		bold(text) { return text; },
	};
	const todos = [
		{ content: "done", status: "completed" },
		{ content: "active", status: "in_progress" },
		{ content: "pending with a deliberately long description", status: "pending" },
	];
	const compact = todoWidgetLines(theme, 80, todos, false);
	assert.equal(compact.length, 1);
	assert.match(compact[0], /1 completed · 1 active · 1 pending/);
	assert.doesNotMatch(compact[0], /done/);
	const expanded = todoWidgetLines(theme, 24, todos, true);
	assert.match(expanded.join("\n"), /done[\s\S]*active[\s\S]*pending/);
	for (const line of expanded) assert.ok(visibleWidth(line) <= 24, line);
});

test("tool rendering is compact, preserves parallel summary, and reveals details on expansion", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const args = { todos: [
		{ content: "done", status: "completed" },
		{ content: "first active", status: "in_progress" },
		{ content: "second active", status: "in_progress" },
	] };
	const call = tool.renderCall(args, harness.theme, { expanded: false });
	assert.match(call.render(100).join("\n"), /Update todo list 1\/3 completed · first active \+1/);
	const expandedCall = tool.renderCall(args, harness.theme, { expanded: true });
	assert.match(expandedCall.render(100).join("\n"), /done[\s\S]*first active[\s\S]*second active/);

	const result = await execute(tool, args, harness.ctx);
	assert.deepEqual(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		harness.theme,
		{ isError: false },
	).render(100), []);
	assert.match(tool.renderResult(
		result,
		{ expanded: true, isPartial: false },
		harness.theme,
		{ isError: false },
	).render(100).join("\n"), /Updated todo list: 0 pending, 2 in progress, 1 completed\./);
});

test("failed result rendering stays compact until expanded", () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const result = {
		content: [{ type: "text", text: "Validation failed for tool todo_write\nReceived arguments:\n{ huge: true }" }],
		details: undefined,
	};
	const compact = tool.renderResult(result, { expanded: false }, harness.theme, { isError: true }).render(120).join("\n");
	assert.equal(compact.trimEnd(), "Validation failed for tool todo_write");
	const expanded = tool.renderResult(result, { expanded: true }, harness.theme, { isError: true }).render(120).join("\n");
	assert.match(expanded, /Received arguments/);
});

test("shutdown always removes the widget", async () => {
	const harness = createHarness();
	await execute(harness.tools.get("todo_write"), { todos: [{ content: "x", status: "pending" }] }, harness.ctx);
	await harness.emit("session_shutdown", { reason: "reload" });
	assert.equal(harness.currentWidget().key, "pi-todo");
	assert.equal(harness.currentWidget().value, undefined);
});

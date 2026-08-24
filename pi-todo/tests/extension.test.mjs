import assert from "node:assert/strict";
import test from "node:test";

import { validateToolArguments } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension, {
	TodoWriteParameters,
	createTodoExtension,
	prepareTodoWriteArguments,
	terminalSafeTodoContent,
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

function hostValidate(tool, arguments_) {
	const prepared = tool.prepareArguments?.(arguments_) ?? arguments_;
	return validateToolArguments(tool, {
		id: "call-1",
		name: tool.name,
		arguments: prepared,
	});
}

test("registers the DSH-compatible open root and closed todo item schema", () => {
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()], ["todo_write"]);
	const tool = harness.tools.get("todo_write");
	assert.equal(tool.label, "Update todo list");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.promptSnippet, undefined);
	assert.equal(tool.promptGuidelines, undefined);

	assert.deepEqual(Object.keys(TodoWriteParameters.properties), ["todos"]);
	assert.deepEqual(TodoWriteParameters.required, ["todos"]);
	assert.equal(TodoWriteParameters.additionalProperties, true);
	const item = TodoWriteParameters.properties.todos.items;
	assert.deepEqual(Object.keys(item.properties), ["content", "status"]);
	assert.deepEqual(item.required, ["content", "status"]);
	assert.equal(item.additionalProperties, false);
	assert.deepEqual(item.properties.status.enum, ["pending", "in_progress", "completed"]);
	assert.equal(tool.prepareArguments, prepareTodoWriteArguments);
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

test("the real host preparation boundary rejects primitive coercion and accepts open root fields", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	for (const content of [42, true]) {
		assert.throws(
			() => hostValidate(tool, { todos: [{ content, status: "pending" }] }),
			{ message: "invalid todo: `content` must be a non-empty string" },
		);
	}
	assert.throws(
		() => hostValidate(tool, { todos: [{ content: "x", status: 42 }] }),
		{ message: "invalid todo: `status` must be pending, in_progress, or completed" },
	);
	const validated = hostValidate(tool, {
		todos: [{ content: "root remains open", status: "pending" }],
		traceId: "accepted-by-dsh",
	});
	assert.equal(validated.traceId, "accepted-by-dsh");
	await execute(tool, validated, harness.ctx);
	assert.equal(harness.appended.length, 1);
});

test("post-validation tool interception cannot add nested todo fields", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const validated = hostValidate(tool, {
		todos: [{ content: "closed item", status: "pending" }],
	});
	validated.todos[0].children = [];
	await assert.rejects(
		() => execute(tool, validated, harness.ctx),
		{ message: 'invalid todo carries unknown field "children"' },
	);
	assert.deepEqual(harness.appended, []);
});

test("execution without a Pi session reports the owning-session error", async () => {
	const harness = createHarness();
	await assert.rejects(
		() => execute(harness.tools.get("todo_write"), { todos: [] }, undefined),
		{ message: "todo_write requires an owning agent session" },
	);
	assert.deepEqual(harness.appended, []);
});

test("durable and live snapshots cannot be changed through branch or result aliases", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const result = await execute(tool, {
		todos: [{ content: "immutable", status: "pending" }],
	}, harness.ctx);
	const write = harness.branch.find((entry) => entry.customType === TODO_WRITE_ENTRY);
	assert.ok(Object.isFrozen(write.data));
	assert.ok(Object.isFrozen(write.data.todos));
	assert.ok(Object.isFrozen(write.data.todos[0]));
	assert.throws(() => { write.data.todos[0].status = "completed"; }, TypeError);
	result.details.todos[0].content = "mutated result";
	harness.setExpanded(true);
	const rendered = harness.currentWidget().value(null, harness.theme).render(100).join("\n");
	assert.match(rendered, /immutable/);
	assert.doesNotMatch(rendered, /mutated result/);
});

test("restored widget state is detached from mutable branch-entry data", async () => {
	const harness = createHarness();
	const durable = [{ content: "restored", status: "pending" }];
	harness.branch.push({ type: "custom", customType: TODO_WRITE_ENTRY, data: { todos: durable } });
	await harness.emit("session_start", { reason: "resume" });
	assert.ok(Object.isFrozen(harness.branch[0].data));
	assert.ok(Object.isFrozen(durable));
	assert.ok(Object.isFrozen(durable[0]));
	assert.throws(() => { durable[0].content = "changed after restore"; }, TypeError);
	assert.throws(() => { durable[0].status = "completed"; }, TypeError);
	harness.setExpanded(true);
	const rendered = harness.currentWidget().value(null, harness.theme).render(100).join("\n");
	assert.match(rendered, /restored/);
	assert.match(rendered, /1 pending/);
	assert.doesNotMatch(rendered, /changed after restore|1 completed/);
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

test("terminal rendering encodes controls without changing durable todo content", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const content = "first\nsecond\u001b[2J\u009b31m\tend\u2028tail";
	const result = await execute(tool, { todos: [{ content, status: "in_progress" }] }, harness.ctx);
	assert.equal(result.details.todos[0].content, content);
	assert.equal(harness.appended[0].data.todos[0].content, content);
	assert.equal(
		terminalSafeTodoContent(content),
		"first\\nsecond\\x1b[2J\\x9b31m\\tend\\u2028tail",
	);

	harness.setExpanded(true);
	const widgetLines = harness.currentWidget().value(null, harness.theme).render(200);
	assert.equal(widgetLines.length, 2);
	assert.match(widgetLines[1], /first\\nsecond\\x1b\[2J\\x9b31m\\tend\\u2028tail/);
	assert.doesNotMatch(widgetLines[1], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);

	for (const expanded of [false, true]) {
		const rendered = tool.renderCall(
			{ todos: [{ content, status: "in_progress" }] },
			harness.theme,
			{ expanded },
		).render(200).join("|");
		assert.match(rendered, /first\\nsecond\\x1b/);
		assert.doesNotMatch(rendered, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
	}
});

test("standing widget starts compact, expands every item in order, and respects width", () => {
	const theme = {
		fg(_colour, text) { return text; },
		bold(text) { return text; },
	};
	const todos = [
		{ content: "done", status: "completed" },
		{ content: "active", status: "in_progress" },
		{ content: "pending with a deliberately long description", status: "pending" },
		...Array.from({ length: 6 }, (_, index) => ({
			content: `extra ${index + 4}`,
			status: "pending",
		})),
	];
	const compact = todoWidgetLines(theme, 80, todos, false);
	assert.equal(compact.length, 1);
	assert.match(compact[0], /1 completed · 1 active · 7 pending/);
	assert.doesNotMatch(compact[0], /done/);
	const expanded = todoWidgetLines(theme, 24, todos, true);
	assert.equal(expanded.length, todos.length + 1);
	assert.match(expanded.join("\n"), /done[\s\S]*active[\s\S]*pending[\s\S]*extra 9/);
	assert.doesNotMatch(expanded.join("\n"), /more/);
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

test("fallback result styling follows the actual error state and encodes controls", () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const colours = [];
	const theme = {
		...harness.theme,
		fg(colour, text) { colours.push(colour); return text; },
	};
	const result = {
		content: [{ type: "text", text: "Historical success\nwith control \u001b[2J" }],
		details: undefined,
	};
	const rendered = tool.renderResult(
		result,
		{ expanded: true },
		theme,
		{ isError: false },
	).render(120).join("\n");
	assert.equal(colours.at(-1), "dim");
	assert.match(rendered, /Historical success\\nwith control \\x1b\[2J/);
	assert.doesNotMatch(rendered, /[\u0000-\u001f\u007f-\u009f]/);
	tool.renderResult(result, { expanded: false }, theme, { isError: true }).render(120);
	assert.equal(colours.at(-1), "error");
});

test("failed result rendering stays compact until expanded", () => {
	const harness = createHarness();
	const tool = harness.tools.get("todo_write");
	const result = {
		content: [{ type: "text", text: "Validation failed for tool todo_write\u001b[2J\nReceived arguments:\n{ huge: true }" }],
		details: undefined,
	};
	const compact = tool.renderResult(result, { expanded: false }, harness.theme, { isError: true }).render(120).join("\n");
	assert.equal(compact.trimEnd(), "Validation failed for tool todo_write\\x1b[2J");
	assert.doesNotMatch(compact, /\u001b/);
	const expanded = tool.renderResult(result, { expanded: true }, harness.theme, { isError: true }).render(120).join("\n");
	assert.match(expanded, /Received arguments/);
	assert.doesNotMatch(expanded, /\u001b/);
});

test("shutdown always removes the widget", async () => {
	const harness = createHarness();
	await execute(harness.tools.get("todo_write"), { todos: [{ content: "x", status: "pending" }] }, harness.ctx);
	await harness.emit("session_shutdown", { reason: "reload" });
	assert.equal(harness.currentWidget().key, "pi-todo");
	assert.equal(harness.currentWidget().value, undefined);
});

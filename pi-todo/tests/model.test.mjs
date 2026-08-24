import assert from "node:assert/strict";
import test from "node:test";

import {
	TODO_CLEAR_ENTRY,
	TODO_WRITE_ENTRY,
	canonicaliseTodos,
	countTodos,
	describeTodoTool,
	planSummary,
	progressSegments,
	projectTodoState,
	summaryFromToolArguments,
	todoResultText,
	validateTodoSnapshot,
} from "../model.ts";

const parallelPolicy = { allowParallelInProgress: true };
const singlePolicy = { allowParallelInProgress: false };

test("canonicalisation trims content and enforces the closed item shape", () => {
	assert.deepEqual(canonicaliseTodos([
		{ content: "  Build it  ", status: "in_progress" },
	], parallelPolicy), [
		{ content: "Build it", status: "in_progress" },
	]);
	assert.throws(
		() => canonicaliseTodos([
			{ content: "Build it", status: "in_progress", children: [] },
		], parallelPolicy),
		{ message: 'invalid todo carries unknown field "children"' },
	);
});

test("canonicalisation accepts an empty list and imposes no size limits", () => {
	assert.deepEqual(canonicaliseTodos([], parallelPolicy), []);
	const content = "x".repeat(100_000);
	const many = Array.from({ length: 1_000 }, (_, index) => ({
		content: `${index}-${content}`,
		status: "pending",
	}));
	assert.equal(canonicaliseTodos(many, parallelPolicy).length, 1_000);
});

test("canonicalisation rejects blank and duplicate-after-trim content exactly", () => {
	assert.throws(
		() => canonicaliseTodos([{ content: " \t\n ", status: "pending" }], parallelPolicy),
		{ message: "invalid todo: `content` must be a non-empty string" },
	);
	assert.throws(
		() => canonicaliseTodos([
			{ content: "same", status: "pending" },
			{ content: " same ", status: "completed" },
		], parallelPolicy),
		{ message: 'invalid todos: duplicate content "same"' },
	);
});

test("duplicate comparison is case-sensitive", () => {
	assert.deepEqual(canonicaliseTodos([
		{ content: "Task", status: "pending" },
		{ content: "task", status: "pending" },
	], parallelPolicy).map((todo) => todo.content), ["Task", "task"]);
});

test("parallel policy accepts several active items and single policy rejects them exactly", () => {
	const todos = [
		{ content: "Agent A", status: "in_progress" },
		{ content: "Agent B", status: "in_progress" },
	];
	assert.equal(canonicaliseTodos(todos, parallelPolicy).length, 2);
	assert.throws(
		() => canonicaliseTodos(todos, singlePolicy),
		{ message: "invalid todos: at most one task may be in_progress (got 2)" },
	);
	assert.equal(canonicaliseTodos([
		{ content: "Agent A", status: "in_progress" },
		{ content: "Agent B", status: "pending" },
	], singlePolicy).length, 2);
});

test("description changes only its active-task policy clause", () => {
	const parallel = describeTodoTool(true);
	const single = describeTodoTool(false);
	assert.match(parallel, /several at once when work genuinely runs in parallel/);
	assert.doesNotMatch(parallel, /AT MOST ONE/);
	assert.match(single, /Keep AT MOST ONE todo `in_progress`/);
	assert.doesNotMatch(single, /several at once/);
	assert.equal(
		parallel.replace(/Mark every todo[\s\S]*?`in_progress`\. /, "POLICY "),
		single.replace(/Keep AT MOST ONE[\s\S]*?`in_progress`\. /, "POLICY "),
	);
});

test("counts and model-visible result text use the exact contract", () => {
	const counts = countTodos([
		{ content: "a", status: "pending" },
		{ content: "b", status: "in_progress" },
		{ content: "c", status: "completed" },
		{ content: "d", status: "completed" },
	]);
	assert.deepEqual(counts, { pending: 1, inProgress: 1, completed: 2 });
	assert.equal(todoResultText(counts), "Updated todo list: 1 pending, 1 in progress, 2 completed.");
});

test("projection is whole-list last-write-wins and clear is distinct from an empty list", () => {
	const first = [{ content: "first", status: "pending" }];
	const second = [{ content: "second", status: "completed" }];
	const base = [
		{ type: "custom", customType: TODO_WRITE_ENTRY, data: { todos: first } },
		{ type: "message", message: { role: "assistant" } },
		{ type: "custom", customType: TODO_WRITE_ENTRY, data: { todos: second } },
	];
	const projected = projectTodoState(base);
	assert.deepEqual(projected, second);
	assert.notEqual(projected, second);
	assert.ok(Object.isFrozen(projected));
	assert.ok(Object.isFrozen(projected[0]));
	assert.equal(projectTodoState([
		...base,
		{ type: "custom", customType: TODO_CLEAR_ENTRY, data: {} },
	]), null);
	assert.deepEqual(projectTodoState([
		...base,
		{ type: "custom", customType: TODO_CLEAR_ENTRY, data: {} },
		{ type: "custom", customType: TODO_WRITE_ENTRY, data: { todos: [] } },
	]), []);
});

test("durable validation accepts historical parallel items but detaches and freezes them", () => {
	const snapshot = [
		{ content: "a", status: "in_progress" },
		{ content: "b", status: "in_progress" },
	];
	const validated = validateTodoSnapshot(snapshot);
	assert.deepEqual(validated, snapshot);
	assert.notEqual(validated, snapshot);
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot[0]));
	assert.ok(Object.isFrozen(validated));
	assert.ok(Object.isFrozen(validated[0]));
});

test("durable validation rejects each malformed snapshot invariant", () => {
	const cases = [
		["no", "todo/write todos must be an array"],
		[[null], "todo/write entries must be objects"],
		[[42], "todo/write entries must be objects"],
		[[{ content: "", status: "pending" }], "todo/write content must be non-empty and already trimmed"],
		[[{ content: " padded ", status: "pending" }], "todo/write content must be non-empty and already trimmed"],
		[[{ content: "x", status: "pending" }, { content: "x", status: "completed" }], 'todo/write repeats content "x"'],
		[[{ content: "x", status: "paused" }], 'todo/write carries unknown status "paused"'],
		[[{ content: "x", status: "pending", metadata: true }], 'todo/write entry carries unknown field "metadata"'],
	];
	for (const [value, message] of cases) {
		assert.throws(() => validateTodoSnapshot(value), { message });
	}
	assert.throws(
		() => projectTodoState([{ type: "custom", customType: TODO_WRITE_ENTRY, data: {} }]),
		{ message: "todo/write todos must be an array" },
	);
});

test("plan summary names the first active item and preserves a non-shrinking extra count", () => {
	assert.deepEqual(planSummary([
		{ content: "done", status: "completed" },
		{ content: "first", status: "in_progress" },
		{ content: "second", status: "in_progress" },
		{ content: "third", status: "in_progress" },
	]), { done: 1, total: 4, activeContent: "first", activeExtra: 2 });
	assert.deepEqual(planSummary([]), { done: 0, total: 0, activeContent: null, activeExtra: 0 });
	assert.deepEqual(planSummary([
		{ content: "  ", status: "in_progress" },
		{ content: "usable later", status: "in_progress" },
	]), { done: 0, total: 2, activeContent: null, activeExtra: 0 });
});

test("tool argument summaries reject unusable roots but keep countable malformed fields", () => {
	assert.equal(summaryFromToolArguments(null), null);
	assert.equal(summaryFromToolArguments({ other: [] }), null);
	assert.equal(summaryFromToolArguments({ todos: [null] }), null);
	assert.deepEqual(summaryFromToolArguments({
		todos: [{ content: 42, status: "in_progress" }, { content: "done", status: "completed" }],
	}), { done: 1, total: 2, activeContent: null, activeExtra: 0 });
});

test("standing progress omits zero segments in completed-active-pending order", () => {
	assert.deepEqual(progressSegments([
		{ content: "done", status: "completed" },
		{ content: "active", status: "in_progress" },
		{ content: "later", status: "pending" },
	]), ["1 completed", "1 active", "1 pending"]);
	assert.deepEqual(progressSegments([{ content: "done", status: "completed" }]), ["1 completed"]);
});

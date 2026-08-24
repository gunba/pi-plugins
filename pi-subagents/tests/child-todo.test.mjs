import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createChildTodoTool } from "../extensions/child-todo-tool.ts";
import { TODO_WRITE_ENTRY } from "../../pi-todo/model.ts";
import {
	FakeDriverFactory,
	blockingPrompt,
	createHarness,
	waitUntil,
} from "./helpers.mjs";

test("isolated children receive the maintained strict Todo tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-child-todo-"));
	const manager = SessionManager.create(root, join(root, "sessions"), { id: "todo-child" });
	try {
		const tool = createChildTodoTool(manager);
		assert.equal(tool.name, "todo_write");
		assert.equal(tool.executionMode, "sequential");
		assert.throws(
			() => tool.prepareArguments({
				todos: [{ content: 42, status: "pending" }],
			}),
			/content.*string/,
		);
		const params = validateToolArguments(tool, {
			id: "todo-call",
			name: tool.name,
			arguments: {
				todos: [
					{ content: "Inspect child work", status: "in_progress" },
					{ content: "Report result", status: "pending" },
				],
			},
		});
		const result = await tool.execute(
			"todo-call",
			params,
			undefined,
			undefined,
			{ sessionManager: manager },
		);
		assert.equal(
			result.content[0].text,
			"Updated todo list: 1 pending, 1 in progress, 0 completed.",
		);
		const entry = manager.getBranch().find((candidate) =>
			candidate.type === "custom" && candidate.customType === TODO_WRITE_ENTRY);
		assert.deepEqual(entry.data.todos, result.details.todos);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Todo availability is captured in the durable child tool profile", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const harness = createHarness({ factory });
	try {
		await harness.runtime.start({
			description: "todo-enabled child",
			prompt: "plan the work",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent({
				toolNames: ["read", "todo_write", "ask_user", "unavailable_extension"],
			}),
		});
		await waitUntil(() => factory.opens.length === 1, "Todo child activation");
		assert.deepEqual(
			factory.opens[0].input.descriptor.toolNames,
			["read", "todo_write"],
		);
	} finally {
		await harness.cleanup();
	}
});

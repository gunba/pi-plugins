import {
	defineTool,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	TodoWriteParameters,
	prepareTodoWriteArguments,
} from "../../pi-todo/extensions/todo.ts";
import {
	TODO_WRITE_ENTRY,
	canonicaliseTodos,
	countTodos,
	describeTodoTool,
	freezeTodoSnapshot,
	todoResultText,
	type TodoWriteDetails,
} from "../../pi-todo/model.ts";

/** Recreate the maintained Todo tool inside an isolated SDK child session. */
export function createChildTodoTool(sessionManager: SessionManager) {
	return defineTool({
		name: "todo_write",
		label: "Update todo list",
		description: describeTodoTool(true),
		parameters: TodoWriteParameters,
		prepareArguments: prepareTodoWriteArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const canonical = canonicaliseTodos(params.todos, {
				allowParallelInProgress: true,
			});
			const snapshot = freezeTodoSnapshot(canonical);
			sessionManager.appendCustomEntry(
				TODO_WRITE_ENTRY,
				Object.freeze({ todos: snapshot }),
			);
			const details: TodoWriteDetails = {
				todos: canonical.map((todo) => ({ ...todo })),
				counts: countTodos(snapshot),
			};
			return {
				content: [{ type: "text", text: todoResultText(details.counts) }],
				details,
			};
		},
	});
}

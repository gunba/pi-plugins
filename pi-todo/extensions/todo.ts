import { StringEnum } from "@earendil-works/pi-ai";
import {
	keyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	TODO_CLEAR_ENTRY,
	TODO_WRITE_ENTRY,
	canonicaliseTodos,
	countTodos,
	describeTodoTool,
	progressSegments,
	projectTodoState,
	summaryFromToolArguments,
	todoResultText,
	type PlanItemLike,
	type TodoItem,
	type TodoStatus,
	type TodoWriteDetails,
} from "../model.ts";

const WIDGET_KEY = "pi-todo";
const WIDGET_ITEM_LIMIT = 8;

const TodoItemSchema = Type.Object(
	{
		content: Type.String({ description: "What the task is — a short imperative line." }),
		status: StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "pending (not started) | in_progress (now) | completed (done).",
		}),
	},
	{ additionalProperties: false },
);

export const TodoWriteParameters = Type.Object(
	{
		todos: Type.Array(TodoItemSchema, {
			description: "The COMPLETE task list, replacing any previous list.",
		}),
	},
	{ additionalProperties: false },
);

export interface TodoExtensionOptions {
	allowParallelInProgress: boolean;
}

function statusGlyph(status: TodoStatus, theme: Theme): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("accent", "◉");
	return theme.fg("dim", "○");
}

function expansionHint(expanded: boolean): string {
	try {
		return keyHint("app.tools.expand", expanded ? "collapse" : "expand");
	} catch {
		return `ctrl+o ${expanded ? "collapse" : "expand"}`;
	}
}

export function todoWidgetLines(
	theme: Theme,
	width: number,
	todos: readonly TodoItem[],
	expanded: boolean,
): string[] {
	const availableWidth = Math.max(1, width);
	const summary = progressSegments(todos).join(" · ");
	const header = [
		theme.bold(theme.fg("accent", "Todos")),
		theme.fg("dim", "·"),
		theme.fg("muted", summary),
		theme.fg("dim", `· ${expansionHint(expanded)}`),
	].join(" ");
	const lines = [truncateToWidth(header, availableWidth)];
	if (!expanded) return lines;

	for (const todo of todos.slice(0, WIDGET_ITEM_LIMIT)) {
		const content = todo.status === "completed"
			? theme.fg("dim", todo.content)
			: theme.fg("text", todo.content);
		lines.push(truncateToWidth(`  ${statusGlyph(todo.status, theme)} ${content}`, availableWidth));
	}
	if (todos.length > WIDGET_ITEM_LIMIT) {
		lines.push(truncateToWidth(
			`  ${theme.fg("dim", `… ${todos.length - WIDGET_ITEM_LIMIT} more`)}`,
			availableWidth,
		));
	}
	return lines;
}

function toolSummaryText(summary: ReturnType<typeof summaryFromToolArguments>): string | null {
	if (!summary) return null;
	let text = `${summary.done}/${summary.total} completed`;
	if (summary.activeContent !== null) text += ` · ${summary.activeContent}`;
	if (summary.activeExtra > 0) text += ` +${summary.activeExtra}`;
	return text;
}

function expandedCallLines(args: unknown, theme: Theme): string[] {
	if (typeof args !== "object" || args === null) return [];
	const todos = (args as { todos?: unknown }).todos;
	if (!Array.isArray(todos)) return [];
	const lines: string[] = [];
	for (const candidate of todos) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const todo = candidate as PlanItemLike;
		const content = typeof todo.content === "string" ? todo.content : JSON.stringify(todo.content);
		const glyph = todo.status === "completed"
			? theme.fg("success", "✓")
			: todo.status === "in_progress"
				? theme.fg("accent", "◉")
				: theme.fg("dim", "○");
		lines.push(`  ${glyph} ${theme.fg("muted", content ?? "")}`);
	}
	return lines;
}

function resultText(result: { content?: readonly { type: string; text?: string }[] }): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

function isTodoWriteDetails(value: unknown): value is TodoWriteDetails {
	if (typeof value !== "object" || value === null) return false;
	const details = value as Partial<TodoWriteDetails>;
	return Array.isArray(details.todos)
		&& typeof details.counts?.pending === "number"
		&& typeof details.counts?.inProgress === "number"
		&& typeof details.counts?.completed === "number";
}

export function createTodoExtension(options: TodoExtensionOptions) {
	return function todoExtension(pi: ExtensionAPI): void {
		let currentTodos: TodoItem[] | null = null;

		const refreshWidget = (ctx: ExtensionContext): void => {
			if (ctx.mode !== "tui") return;
			if (currentTodos === null || currentTodos.length === 0) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const snapshot = currentTodos;
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme): Component => ({
				render: (width: number) => todoWidgetLines(
					theme,
					width,
					snapshot,
					ctx.ui.getToolsExpanded(),
				),
				invalidate() {},
			}), { placement: "aboveEditor" });
		};

		const restore = (ctx: ExtensionContext): void => {
			currentTodos = null;
			refreshWidget(ctx);
			currentTodos = projectTodoState(ctx.sessionManager.getBranch());
			refreshWidget(ctx);
		};

		pi.registerTool({
			name: "todo_write",
			label: "Update todo list",
			description: describeTodoTool(options.allowParallelInProgress),
			parameters: TodoWriteParameters,
			executionMode: "sequential",

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!ctx?.sessionManager) {
					throw new Error("todo_write requires an owning agent session");
				}
				const canonical = canonicaliseTodos(params.todos, options);
				const snapshot = canonical.map((todo) => ({ ...todo }));
				pi.appendEntry(TODO_WRITE_ENTRY, { todos: snapshot });
				currentTodos = snapshot;
				refreshWidget(ctx);

				const details: TodoWriteDetails = {
					todos: snapshot.map((todo) => ({ ...todo })),
					counts: countTodos(snapshot),
				};
				return {
					content: [{ type: "text", text: todoResultText(details.counts) }],
					details,
				};
			},

			renderCall(args, theme, context) {
				const summary = toolSummaryText(summaryFromToolArguments(args));
				let text = theme.fg("toolTitle", theme.bold("Update todo list"));
				if (summary) text += ` ${theme.fg("muted", summary)}`;
				if (context.expanded) {
					const rows = expandedCallLines(args, theme);
					if (rows.length > 0) text += `\n${rows.join("\n")}`;
				}
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded }, theme, context) {
				if (isTodoWriteDetails(result.details)) {
					if (!expanded) return new Container();
					return new Text(theme.fg("dim", todoResultText(result.details.counts)), 0, 0);
				}

				const raw = resultText(result);
				const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "Todo list not updated";
				const compact = context.isError ? firstLine : raw;
				const displayed = expanded && raw ? raw : compact;
				return new Text(theme.fg("error", displayed || "Todo list not updated"), 0, 0);
			},
		});

		pi.on("session_start", (_event, ctx) => restore(ctx));
		pi.on("session_tree", (_event, ctx) => restore(ctx));

		pi.on("before_agent_start", (_event, ctx) => {
			pi.appendEntry(TODO_CLEAR_ENTRY, {});
			currentTodos = null;
			refreshWidget(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			currentTodos = null;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		});
	};
}

export default createTodoExtension({ allowParallelInProgress: true });

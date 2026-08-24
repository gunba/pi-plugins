import { StringEnum } from "@earendil-works/pi-ai";
import {
	keyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
	TODO_CLEAR_ENTRY,
	TODO_WRITE_ENTRY,
	canonicaliseTodos,
	countTodos,
	describeTodoTool,
	freezeTodoSnapshot,
	progressSegments,
	projectTodoState,
	summaryFromToolArguments,
	todoResultText,
	type PlanItemLike,
	type TodoItem,
	type TodoSnapshot,
	type TodoStatus,
	type TodoWriteDetails,
} from "../model.ts";

const WIDGET_KEY = "pi-todo";

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
	{ additionalProperties: true },
);

type TodoWriteArguments = Static<typeof TodoWriteParameters>;

/** Reject primitive coercion before Pi applies TypeBox Value.Convert. */
export function prepareTodoWriteArguments(args: unknown): TodoWriteArguments {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return args as TodoWriteArguments;
	}
	const todos = (args as { todos?: unknown }).todos;
	if (!Array.isArray(todos)) return args as TodoWriteArguments;
	for (const candidate of todos) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
		const item = candidate as Record<string, unknown>;
		if (Object.hasOwn(item, "content") && typeof item.content !== "string") {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (Object.hasOwn(item, "status") && typeof item.status !== "string") {
			throw new Error("invalid todo: `status` must be pending, in_progress, or completed");
		}
	}
	return args as TodoWriteArguments;
}

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

/** Encode terminal controls while leaving the durable task text unchanged. */
export function terminalSafeTodoContent(content: string): string {
	let safe = "";
	for (const character of content) {
		const codePoint = character.codePointAt(0)!;
		if (character === "\n") safe += "\\n";
		else if (character === "\r") safe += "\\r";
		else if (character === "\t") safe += "\\t";
		else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
			safe += codePoint <= 0xff
				? `\\x${codePoint.toString(16).padStart(2, "0")}`
				: `\\u${codePoint.toString(16).padStart(4, "0")}`;
		} else if (codePoint === 0x2028 || codePoint === 0x2029) {
			safe += `\\u${codePoint.toString(16)}`;
		} else {
			safe += character;
		}
	}
	return safe;
}

function terminalSafeUnknown(value: unknown): string {
	if (typeof value === "string") return terminalSafeTodoContent(value);
	try {
		return terminalSafeTodoContent(JSON.stringify(value) ?? "");
	} catch {
		return terminalSafeTodoContent(String(value));
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

	for (const todo of todos) {
		const safeContent = terminalSafeTodoContent(todo.content);
		const content = todo.status === "completed"
			? theme.fg("dim", safeContent)
			: theme.fg("text", safeContent);
		lines.push(truncateToWidth(`  ${statusGlyph(todo.status, theme)} ${content}`, availableWidth));
	}
	return lines;
}

function toolSummaryText(summary: ReturnType<typeof summaryFromToolArguments>): string | null {
	if (!summary) return null;
	let text = `${summary.done}/${summary.total} completed`;
	if (summary.activeContent !== null) text += ` · ${terminalSafeTodoContent(summary.activeContent)}`;
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
		const content = terminalSafeUnknown(todo.content);
		const glyph = todo.status === "completed"
			? theme.fg("success", "✓")
			: todo.status === "in_progress"
				? theme.fg("accent", "◉")
				: theme.fg("dim", "○");
		lines.push(`  ${glyph} ${theme.fg("muted", content)}`);
	}
	return lines;
}

function resultText(result: { content?: readonly { type: string; text?: string }[] }): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.split("\n")
		.map((line) => terminalSafeTodoContent(line))
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
		let currentTodos: TodoSnapshot | null = null;

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
			prepareArguments: prepareTodoWriteArguments,
			executionMode: "sequential",

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!ctx?.sessionManager) {
					throw new Error("todo_write requires an owning agent session");
				}
				const canonical = canonicaliseTodos(params.todos, options);
				const durableSnapshot = freezeTodoSnapshot(canonical);
				const liveSnapshot = freezeTodoSnapshot(canonical);
				pi.appendEntry(TODO_WRITE_ENTRY, Object.freeze({ todos: durableSnapshot }));
				currentTodos = liveSnapshot;
				refreshWidget(ctx);

				const details: TodoWriteDetails = {
					todos: canonical.map((todo) => ({ ...todo })),
					counts: countTodos(liveSnapshot),
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
				const safeDisplayed = terminalSafeTodoContent(displayed || "Todo list not updated");
				const colour = context.isError ? "error" : "dim";
				return new Text(theme.fg(colour, safeDisplayed), 0, 0);
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

export const TODO_WRITE_ENTRY = "pi-todo-write";
export const TODO_CLEAR_ENTRY = "pi-todo-turn-start";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

export interface TodoCounts {
	pending: number;
	inProgress: number;
	completed: number;
}

export interface TodoWriteDetails {
	todos: TodoItem[];
	counts: TodoCounts;
}

export interface TodoPolicy {
	allowParallelInProgress: boolean;
}

export interface BranchEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export interface PlanItemLike {
	content?: unknown;
	status?: unknown;
}

export interface PlanSummary {
	done: number;
	total: number;
	activeContent: string | null;
	activeExtra: number;
}

const DESCRIPTION_START =
	"Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. ";
const PARALLEL_GUIDANCE =
	"Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be `in_progress`. ";
const SINGLE_GUIDANCE =
	"Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active task should be `in_progress`. ";
const DESCRIPTION_END =
	"Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).";

export function describeTodoTool(allowParallelInProgress: boolean): string {
	return DESCRIPTION_START
		+ (allowParallelInProgress ? PARALLEL_GUIDANCE : SINGLE_GUIDANCE)
		+ DESCRIPTION_END;
}

export function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

export function canonicaliseTodos(
	rawTodos: readonly { content: string; status: TodoStatus }[],
	policy: TodoPolicy,
): TodoItem[] {
	if (!Array.isArray(rawTodos)) {
		throw new Error("invalid todos: expected an array");
	}

	const canonical: TodoItem[] = [];
	const contents = new Set<string>();
	let activeCount = 0;

	for (const raw of rawTodos) {
		if (!raw || typeof raw.content !== "string") {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (!isTodoStatus(raw.status)) {
			throw new Error("invalid todo: `status` must be pending, in_progress, or completed");
		}

		const content = raw.content.trim();
		if (content.length === 0) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (contents.has(content)) {
			throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
		}

		contents.add(content);
		if (raw.status === "in_progress") activeCount += 1;
		canonical.push({ content, status: raw.status });
	}

	if (!policy.allowParallelInProgress && activeCount > 1) {
		throw new Error(`invalid todos: at most one task may be in_progress (got ${activeCount})`);
	}
	return canonical;
}

/** Validate durable snapshots without applying the current active-task policy. */
export function validateTodoSnapshot(value: unknown): TodoItem[] {
	if (!Array.isArray(value)) {
		throw new Error("todo/write todos must be an array");
	}

	const contents = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "object" || candidate === null) {
			throw new Error("todo/write entries must be objects");
		}
		const item = candidate as Record<string, unknown>;
		const content = item.content;
		if (typeof content !== "string" || content.length === 0 || content.trim() !== content) {
			throw new Error("todo/write content must be non-empty and already trimmed");
		}
		if (contents.has(content)) {
			throw new Error(`todo/write repeats content ${JSON.stringify(content)}`);
		}
		contents.add(content);
		if (!isTodoStatus(item.status)) {
			throw new Error(`todo/write carries unknown status ${JSON.stringify(item.status)}`);
		}
	}

	return value as TodoItem[];
}

export function projectTodoState(entries: readonly BranchEntryLike[]): TodoItem[] | null {
	let projected: TodoItem[] | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === TODO_CLEAR_ENTRY) {
			projected = null;
			continue;
		}
		if (entry.customType !== TODO_WRITE_ENTRY) continue;
		const data = entry.data as { todos?: unknown } | null | undefined;
		projected = validateTodoSnapshot(data?.todos);
	}
	return projected;
}

export function countTodos(todos: readonly TodoItem[]): TodoCounts {
	const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0 };
	for (const todo of todos) {
		if (todo.status === "pending") counts.pending += 1;
		else if (todo.status === "in_progress") counts.inProgress += 1;
		else counts.completed += 1;
	}
	return counts;
}

export function todoResultText(counts: TodoCounts): string {
	return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`;
}

export function planSummary(todos: readonly PlanItemLike[]): PlanSummary {
	const active = todos.filter((todo) => todo.status === "in_progress");
	const firstContent = active[0]?.content;
	const hasUsableName = typeof firstContent === "string" && firstContent.trim().length > 0;
	return {
		done: todos.filter((todo) => todo.status === "completed").length,
		total: todos.length,
		activeContent: hasUsableName ? firstContent : null,
		activeExtra: hasUsableName ? active.length - 1 : 0,
	};
}

export function summaryFromToolArguments(args: unknown): PlanSummary | null {
	if (typeof args !== "object" || args === null) return null;
	const todos = (args as { todos?: unknown }).todos;
	if (!Array.isArray(todos)) return null;
	if (!todos.every((todo) => typeof todo === "object" && todo !== null)) return null;
	return planSummary(todos as PlanItemLike[]);
}

export function progressSegments(todos: readonly TodoItem[]): string[] {
	const counts = countTodos(todos);
	return [
		...(counts.completed > 0 ? [`${counts.completed} completed`] : []),
		...(counts.inProgress > 0 ? [`${counts.inProgress} active`] : []),
		...(counts.pending > 0 ? [`${counts.pending} pending`] : []),
	];
}

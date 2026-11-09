import { Type, type Static } from "typebox";
import { planSteps, type PlanStep } from "./steps.ts";

// A plain string is a pending step: agents write a fresh plan's steps as a list of strings.
const Step = Type.Union([Type.String(), Type.Object({
	content: Type.String(),
	status: Type.Enum(["pending", "in_progress", "completed"] as const, { type: "string" }),
	detail: Type.Optional(Type.String({ description: "Notes for doing this step: how, files, commands, findings. Shown to you again while it is current." })),
}, { additionalProperties: false })]);
const Definition = {
	objective: Type.Optional(Type.String()),
	steps: Type.Optional(Type.Array(Step, { description: "The whole list; replaces the old one. A string is a pending step. A step keeps its detail unless you send one (\"\" removes it)." })),
	auto_continue: Type.Optional(Type.Boolean({ description: "Keep working in automatic rounds." })),
	max_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
};
export const CreateParameters = Type.Object({
	...Definition, objective: Type.String({ description: "What done means." }),
}, { additionalProperties: false });
export const UpdateParameters = Type.Object({
	action: Type.Enum(["edit", "pause", "resume", "complete", "blocked"] as const, { type: "string" }),
	...Definition,
	blocked_reason: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type CreateParams = Static<typeof CreateParameters>;
export type UpdateParams = Static<typeof UpdateParameters>;

/**
 * Validate scalar fields before Pi's schema conversion can coerce them. update_plan once took plan_id and revision;
 * conversations that used it may still send them, so they are dropped rather than refused.
 */
const pending = <T>(step: T | string): T | PlanStep => typeof step === "string" ? { content: step, status: "pending" } : step;

/** Where agents put a step's text, its notes, and the words they use for its status, in the order they are trusted. */
const TEXT = ["content", "title", "text", "step", "task", "name", "description"];
const NOTES = ["detail", "details", "notes", "note", "description"];
const STATUS: Record<string, PlanStep["status"]> = { pending: "pending", todo: "pending", to_do: "pending", not_started: "pending", open: "pending",
	in_progress: "in_progress", active: "in_progress", current: "in_progress", doing: "in_progress", started: "in_progress", working: "in_progress",
	completed: "completed", complete: "completed", done: "completed", finished: "completed" };
/**
 * A step as agents write it without the schema in front of them (from a program they see only "steps"): its text under
 * title, step or text, its status as done: true or a synonym, or none, which is pending; and notes for detail. Other
 * fields mean nothing to a plan and are dropped. What can't be read this way is left for planSteps to refuse.
 */
function looseStep(value: unknown): unknown {
	if (typeof value === "string" || !value || typeof value !== "object" || Array.isArray(value)) return value;
	const item = value as Record<string, unknown>;
	const textKey = TEXT.find(key => typeof item[key] === "string" && (item[key] as string).trim());
	if (!textKey) return value;
	const done = [item.done, item.completed, item.checked].find(flag => typeof flag === "boolean");
	const status = typeof item.status === "string" ? STATUS[item.status.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? item.status
		: typeof done === "boolean" ? done ? "completed" : "pending" : "pending";
	const detail = NOTES.find(key => key !== textKey && typeof item[key] === "string");
	return { content: item[textKey], status, ...(detail ? { detail: item[detail] } : {}) };
}
/** update_plan's action as agents name it. */
const ACTIONS: Record<string, string> = { update: "edit", change: "edit", set: "edit", replace: "edit", modify: "edit", done: "complete", finish: "complete", block: "blocked" };

export function preparePlanArguments<T extends CreateParams | UpdateParams>(value: unknown): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value as T;
	const { plan_id: _id, revision: _revision, ...input } = value as Record<string, unknown>;
	for (const field of ["objective", "action", "blocked_reason"])
		if (field in input && typeof input[field] !== "string") throw new Error(`${field} must be a string`);
	for (const field of ["max_rounds"])
		if (field in input && (typeof input[field] !== "number" || !Number.isSafeInteger(input[field]) || (input[field] as number) < 1))
			throw new Error(`${field} must be a positive safe integer`);
	if ("auto_continue" in input && typeof input.auto_continue !== "boolean") throw new Error("auto_continue must be a boolean");
	// A model calling the tool directly, not from a program, has no schema for it and may send the list as JSON text.
	if (typeof input.steps === "string" && input.steps.trim().startsWith("[")) {
		try { input.steps = JSON.parse(input.steps); } catch { throw new Error("steps is text that isn't a JSON array; send an array of step texts or {content, status} objects"); }
	}
	if (typeof input.action === "string") input.action = ACTIONS[input.action.trim().toLowerCase()] ?? input.action;
	if (Array.isArray(input.steps)) input.steps = input.steps.map(looseStep);
	if ("steps" in input) planSteps(Array.isArray(input.steps) ? input.steps.map(pending) : input.steps, true);
	return input as T;
}
/** The plan fields a call sets; a step sent without detail keeps the detail it had in previous, matched by its text. */
export function definition(params: CreateParams | UpdateParams, previous: readonly PlanStep[] = []) {
	const kept = new Map(previous.flatMap(step => step.detail ? [[step.content, step.detail] as const] : []));
	const withDetail = (step: PlanStep): PlanStep => {
		const detail = step.detail ?? kept.get(step.content.trim());
		return detail === undefined ? { content: step.content, status: step.status } : { ...step, detail };
	};
	return {
		...(params.objective === undefined ? {} : { objective: params.objective }),
		...(params.steps === undefined ? {} : { steps: params.steps.map(step => withDetail(pending<PlanStep>(step))) }),
		...(params.auto_continue === undefined ? {} : { autoContinue: params.auto_continue }),
		...(params.max_rounds === undefined ? {} : { maxRounds: params.max_rounds }),
	};
}

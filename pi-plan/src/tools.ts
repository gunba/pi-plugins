import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { planSteps } from "./steps.ts";

const Step = Type.Object({
	content: Type.String({ description: "A concrete step." }),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
}, { additionalProperties: false });
const Definition = {
	objective: Type.Optional(Type.String({ description: "Concise objective." })),
	steps: Type.Optional(Type.Array(Step, { description: "Complete ordered step list; replaces the previous steps. Parallel work is allowed." })),
	auto_continue: Type.Optional(Type.Boolean({ description: "Enable automatic continuation. False keeps a manual checklist." })),
	max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};
export const CreateParameters = Type.Object({
	...Definition, objective: Type.String({ description: "The plan's completion objective." }),
}, { additionalProperties: false });
export const UpdateParameters = Type.Object({
	plan_id: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	action: StringEnum(["edit", "pause", "resume", "complete", "blocked"] as const),
	...Definition,
	blocked_reason: Type.Optional(Type.String({ description: "Concrete blocking condition; only for action blocked." })),
}, { additionalProperties: false });
export type CreateParams = Static<typeof CreateParameters>;
export type UpdateParams = Static<typeof UpdateParameters>;

/** Validate scalar fields before Pi's schema conversion can coerce them. */
export function preparePlanArguments<T extends CreateParams | UpdateParams>(value: unknown): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value as T;
	const input = value as Record<string, unknown>;
	for (const field of ["objective", "plan_id", "action", "blocked_reason"])
		if (field in input && typeof input[field] !== "string") throw new Error(`${field} must be a string`);
	for (const field of ["revision", "max_rounds"])
		if (field in input && (typeof input[field] !== "number" || !Number.isSafeInteger(input[field]) || (input[field] as number) < 1))
			throw new Error(`${field} must be a positive safe integer`);
	if ("auto_continue" in input && typeof input.auto_continue !== "boolean") throw new Error("auto_continue must be a boolean");
	if ("steps" in input) planSteps(input.steps, true);
	return value as T;
}
export function definition(params: CreateParams | UpdateParams) {
	return {
		...(params.objective === undefined ? {} : { objective: params.objective }),
		...(params.steps === undefined ? {} : { steps: params.steps }),
		...(params.auto_continue === undefined ? {} : { autoContinue: params.auto_continue }),
		...(params.max_rounds === undefined ? {} : { maxRounds: params.max_rounds }),
	};
}

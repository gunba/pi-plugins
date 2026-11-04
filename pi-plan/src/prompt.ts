import type { PlanSnapshot, PlanView } from "./domain.ts";
import { currentSteps, stepSummary } from "./steps.ts";

/**
 * The model's own tool calls an active plan may go without an update before it is reminded of the plan: about twice
 * the usual gap (a median of 13 calls), which more than doubles once a conversation's context passes 300k tokens.
 */
export const PLAN_CHECK_EVERY = 25;

/** The reminder added to a tool result: where the plan stands, so the model can bring it up to date. */
export function renderPlanCheck(plan: PlanSnapshot, calls: number): string {
	const summary = stepSummary(plan.steps), short = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}…` : text);
	// After 48 of 139 completed plans in two weeks, models went on for 25 or more calls with no plan, after 23 for over 100.
	if (plan.phase === "complete")
		return `[Plan check] ${calls} tool calls since the plan ${short(plan.objective)} was completed; the work since is in no plan. If it has more than one step, create_plan for it now.`;
	// An instruction naming the cases, not a remark: asked whether the plan was "out of date" or "behind", models
	// answered about half the checks, and seldom when the user had since asked for something else.
	const where = !summary.total ? `Objective: ${short(plan.objective)}. If that is not what you are working on now, update the plan now with update_plan`
		: summary.completed === summary.total ? `All ${summary.total} steps are marked done. If the objective is met, complete the plan now with update_plan; if not, or you are working on something else, add that work as steps`
		: `${summary.completed} of ${summary.total} steps are marked done${summary.current ? `; current: ${short(summary.current)}` : ""}. If that is done, or you are working on something else (something the user asked for since, say), update the plan now with update_plan: mark what is done and add the work you are on`;
	const notes = renderStepNotes(plan);
	return `[Plan check] ${calls} tool calls since the plan was last updated. ${where}.${notes ? `\n${notes}` : ""}`;
}

/** The notes the model wrote for the steps it is on, which it is shown when it reaches them; empty when there are none. */
export function renderStepNotes(plan: Pick<PlanSnapshot, "steps" | "phase">): string {
	if (plan.phase === "complete") return "";
	return currentSteps(plan.steps).flatMap(step => step.detail
		? [`[Plan] Now on ${JSON.stringify(step.content.length > 120 ? `${step.content.slice(0, 117)}…` : step.content)}. Your notes for it:\n${step.detail}`] : []).join("\n");
}

/**
 * The message that starts an automatic round. Round admissions record it, and replay checks a recorded one against
 * this or the earlier format (renderPlanRoundPromptV1).
 */
export function renderPlanRoundPrompt(plan: PlanSnapshot, round: number): string {
	const current = currentSteps(plan.steps);
	// The objective and steps are JSON strings, so that line breaks in them cannot be taken for the message's own.
	return [
		`<plan_round>Round ${round} of ${plan.maxRounds}. Objective: ${JSON.stringify(plan.objective)}`,
		...(current.length ? [`Current: ${JSON.stringify(current.slice(0, 3).map(step => step.content.slice(0, 400)))}`] : []),
		...current.slice(0, 3).flatMap(step => step.detail ? [`Notes for ${JSON.stringify(step.content.slice(0, 400))}: ${JSON.stringify(step.detail)}`] : []),
		"Continue: make concrete, verified progress. The workspace and tool results are authoritative. Complete the plan only when its whole objective is met; otherwise leave it active.</plan_round>",
	].join("\n");
}

/** The round message before November 2026, still accepted in recorded admissions. */
export function renderPlanRoundPromptV1(plan: PlanSnapshot, round: number): string {
	const active = plan.steps.filter(step => step.status === "in_progress");
	const current = active.length ? active : plan.steps.filter(step => step.status === "pending").slice(0, 1);
	return [
		"<plan_round>",
		`Objective: ${JSON.stringify(plan.objective)}`,
		`Round: ${round}/${plan.maxRounds}`,
		`Plan: ${JSON.stringify(plan.id)} revision ${plan.revision}`,
		...(current.length ? [`Current steps: ${JSON.stringify(current.slice(0, 3).map(step => step.content.slice(0, 400)))}`] : []),
		"",
		"Continue the plan in this session. Treat workspace, tool results and durable session state as authoritative. Make concrete progress and verify it. Read the current plan before updating its objective or steps. Mark it complete only when its whole objective is achieved. If work remains, leave it active. Follow the plan-tool policy before reporting a blocker.",
		"</plan_round>",
	].join("\n");
}

export function renderPlanWrapup(plan: Pick<PlanView, "objective">, blockedReason?: string): string {
	return [
		blockedReason === undefined ? "<plan_complete>" : "<plan_blocked>",
		`Objective: ${JSON.stringify(plan.objective)}`,
		...(blockedReason === undefined ? [] : [`Blocked: ${JSON.stringify(blockedReason)}`]),
		"Automatic continuation has stopped. Summarize the outcome, verification, relevant artifacts and any remaining work or blocking condition.",
		blockedReason === undefined ? "</plan_complete>" : "</plan_blocked>",
	].join("\n");
}

export function renderPlanGuidance(blockedAfter: number): string {
	return `Finishing a plan's steps doesn't complete its objective. Report blocked only after the same condition persists for ${blockedAfter} rounds.`;
}

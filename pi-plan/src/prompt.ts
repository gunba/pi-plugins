import type { PlanSnapshot, PlanView } from "./domain.ts";
import { stepSummary } from "./steps.ts";

/**
 * The model's own tool calls an active plan may go without an update before it is reminded of the plan: about twice
 * the usual gap (a median of 13 calls), which more than doubles once a conversation's context passes 300k tokens.
 */
export const PLAN_CHECK_EVERY = 25;

/** The reminder added to a tool result: where the plan stands, and its id and revision, so update_plan needs no get_plan first. */
export function renderPlanCheck(plan: PlanSnapshot, calls: number): string {
	const summary = stepSummary(plan.steps), short = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}…` : text);
	// An instruction, not a remark: worded as "if it is out of date", models read it as a reminder and moved on.
	const where = !summary.total ? `Objective: ${short(plan.objective)}. If it no longer describes the work, update it now`
		: summary.completed === summary.total ? `All ${summary.total} steps are marked done. If the objective is met, complete the plan now; if not, add what remains`
		: `${summary.completed} of ${summary.total} steps are marked done${summary.current ? `; current: ${short(summary.current)}` : ""}. Compare that with the work so far and, if it is behind, update the plan now`;
	return `[Plan check] ${calls} tool calls since the plan was last updated. ${where} (update_plan with plan_id ${JSON.stringify(plan.id)}, revision ${plan.revision}).`;
}

/** Part of the v1 round ledger; format changes require a replay-version migration. */
export function renderPlanRoundPrompt(plan: PlanSnapshot, round: number): string {
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
	return "One plan per branch: a concise objective and concrete steps. auto_continue keeps working across automatic rounds; "
		+ "a resume, reload or fork pauses that until action resume. Call get_plan before update_plan and copy its id and revision. "
		+ `Finishing the steps does not by itself complete the objective. Report blocked only after the same condition persists for ${blockedAfter} rounds.`;
}

import type { PlanSnapshot, PlanView } from "./domain.ts";

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
	return "Use one branch-local plan with a concise objective and actionable steps. Ordinary checklists have automatic continuation off. "
		+ "Enable auto_continue for sustained work across automatic rounds. Read get_plan before update_plan and use its exact plan_id and revision. "
		+ "After resume, reload, or fork, automatic plans are disarmed; action resume rearms them. "
		+ "Completing every step does not itself complete the objective. "
		+ `During automatic work, report blocked only after the same concrete condition persists for at least ${blockedAfter} consecutive rounds.`;
}

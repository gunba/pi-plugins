import type { GoalSnapshot, GoalView } from "./domain.ts";

interface GoalPromptState extends Pick<GoalSnapshot, "objective" | "maxGoalRounds"> {}

export function renderGoalRoundPrompt(goal: GoalPromptState, round: number): string {
	return [
		"<goal_round>",
		`Objective: ${JSON.stringify(goal.objective)}`,
		`Round: ${round}/${goal.maxGoalRounds}`,
		"",
		"Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.",
		"</goal_round>",
	].join("\n");
}

export function renderGoalWrapup(goal: Pick<GoalView, "objective">, blockedReason?: string): string {
	const objective = `Objective: ${JSON.stringify(goal.objective)}\n`;
	if (blockedReason === undefined) {
		return [
			"<goal_complete>",
			objective.trimEnd(),
			"Automatic continuation has stopped. Summarize the outcome, verification, relevant artifacts and any next steps for the user.",
			"</goal_complete>",
		].join("\n");
	}
	return [
		"<goal_blocked>",
		objective.trimEnd(),
		`Blocked: ${JSON.stringify(blockedReason)}`,
		"Automatic continuation has stopped. Summarize progress, the blocking condition, attempts to resolve it and what would allow work to resume.",
		"</goal_blocked>",
	].join("\n");
}

export function renderGoalGuidance(blockedAfter: number): string {
	return "Use goal tools for one long-running completion objective in the current session. "
		+ "Create, edit, pause, resume, complete, or block it as the task requires. "
		+ "Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: use update_goal action resume to rearm it when continuing the task. "
		+ "Mark complete only when the objective is actually achieved. "
		+ `Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`;
}

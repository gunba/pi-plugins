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

const GROUNDING =
	"Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. ";

export function renderGoalWrapup(goal: Pick<GoalView, "objective">, blockedReason?: string): string {
	const objective = `Objective: ${JSON.stringify(goal.objective)}\n`;
	if (blockedReason === undefined) {
		return [
			"<goal_complete>",
			objective.trimEnd(),
			"The goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). "
				+ GROUNDING
				+ "Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.",
			"</goal_complete>",
		].join("\n");
	}
	return [
		"<goal_blocked>",
		objective.trimEnd(),
		`Blocked: ${JSON.stringify(blockedReason)}`,
		"The goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. "
			+ GROUNDING
			+ "Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.",
		"</goal_blocked>",
	].join("\n");
}

export function renderGoalGuidance(blockedAfter: number): string {
	return "Use goal tools for one long-running completion objective in the current session. "
		+ "create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. "
		+ "Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. "
		+ "Mark complete only when the objective is actually achieved. "
		+ `Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`;
}

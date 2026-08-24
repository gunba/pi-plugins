import {
	GoalError,
	type CreateGoalRequest,
	type EditGoalRequest,
	type GoalRef,
	type GoalView,
} from "./domain.ts";

export const GOAL_USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";

export type GoalCommand =
	| { kind: "show" }
	| { kind: "create"; objective: string }
	| { kind: "edit"; objective: string }
	| { kind: "invalid-edit" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "clear" };

export interface GoalCommandResult {
	kind: "success" | "error";
	text: string;
}

export interface GoalCommandOperations {
	get(): GoalView | undefined;
	create(request: CreateGoalRequest): GoalView;
	edit(ref: GoalRef, request: EditGoalRequest): GoalView;
	pause(ref: GoalRef): GoalView;
	resume(ref: GoalRef): GoalView;
	clear(ref: GoalRef): GoalRef;
}

export function parseGoalCommand(rawInput: string): GoalCommand {
	const input = rawInput.trim();
	if (input.length === 0) return { kind: "show" };
	const control = input.toLowerCase();
	if (control === "clear") return { kind: "clear" };
	if (control === "pause") return { kind: "pause" };
	if (control === "resume") return { kind: "resume" };
	if (control === "edit") return { kind: "invalid-edit" };
	if (/^edit(?=\s)/iu.test(input)) return { kind: "edit", objective: input.slice(4).trim() };
	return { kind: "create", objective: input };
}

function commandHint(goal: GoalView): string {
	if (goal.phase === "active") {
		return goal.activation === "armed"
			? "/goal edit <objective>, /goal pause, /goal clear"
			: "/goal edit <objective>, /goal resume, /goal clear";
	}
	if (goal.phase === "paused" || goal.phase === "blocked") {
		return "/goal edit <objective>, /goal resume, /goal clear";
	}
	return "/goal <objective>, /goal clear";
}

export function renderGoal(title: string, goal: GoalView): GoalCommandResult {
	const blocker = goal.phase === "blocked"
		? [`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`]
		: [];
	return {
		kind: "success",
		text: [
			title,
			`Status: ${goal.phase}`,
			...blocker,
			`Objective: ${goal.objective}`,
			`Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
			`Activation: ${goal.activation}`,
			"",
			`Commands: ${commandHint(goal)}`,
		].join("\n"),
	};
}

function ref(goal: GoalView): GoalRef {
	return { id: goal.id, revision: goal.revision };
}

function missingGoal(action: string): GoalCommandResult {
	return {
		kind: "error",
		text: `No goal is currently set; /goal ${action} requires one. ${GOAL_USAGE}`,
	};
}

export function executeGoalCommand(rawInput: string, operations: GoalCommandOperations): GoalCommandResult {
	const command = parseGoalCommand(rawInput);
	try {
		const current = operations.get();
		switch (command.kind) {
			case "show":
				return current === undefined
					? { kind: "success", text: `No goal is currently set.\n${GOAL_USAGE}` }
					: renderGoal("Goal", current);
			case "invalid-edit":
				return { kind: "error", text: `Goal editing requires a replacement objective.\n${GOAL_USAGE}` };
			case "create":
				if (current !== undefined && current.phase !== "complete") {
					return {
						kind: "error",
						text: `A goal is already ${current.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
					};
				}
				return renderGoal("Goal created", operations.create({ objective: command.objective }));
			case "edit":
				if (current === undefined) return missingGoal("edit");
				if (current.phase === "complete") {
					return renderGoal("Goal created", operations.create({ objective: command.objective }));
				}
				return renderGoal("Goal updated", operations.edit(ref(current), { objective: command.objective }));
			case "pause":
				if (current === undefined) return missingGoal("pause");
				return renderGoal("Goal paused", operations.pause(ref(current)));
			case "resume":
				if (current === undefined) return missingGoal("resume");
				return renderGoal("Goal resumed", operations.resume(ref(current)));
			case "clear":
				if (current === undefined) return { kind: "success", text: "No goal to clear." };
				operations.clear(ref(current));
				return { kind: "success", text: "Goal cleared." };
		}
	} catch (error) {
		if (error instanceof GoalError) {
			return {
				kind: "error",
				text: "The goal command is not valid for the current state. Run /goal to view available commands.",
			};
		}
		throw error;
	}
}

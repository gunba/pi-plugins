import { createHash } from "node:crypto";
import { DEFAULT_MAX_PLAN_ROUNDS } from "./constants.ts";
import { applyPlanChange, applyPlanRound, decodePlanChange, emptyPlanFoldState, exactKeys, integer,
	planCreate, record, type PlanFoldState } from "./domain.ts";
import { planSteps, type PlanStep } from "./steps.ts";

/** Read-only cutover. Nothing in this module writes the retired formats. */
export const LEGACY_ENTRIES = new Set([
	"pi-goal-change/v1", "pi-goal-round-admission/v1", "pi-todo-write", "pi-todo-turn-start",
]);

function legacyPrompt(objective: string, maxRounds: number, round: number): string {
	return [
		"<goal_round>",
		`Objective: ${JSON.stringify(objective)}`,
		`Round: ${round}/${maxRounds}`,
		"",
		"Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.",
		"</goal_round>",
	].join("\n");
}

export function legacyPlan(entries: readonly unknown[]): { state: PlanFoldState; found: boolean } {
	const state = emptyPlanFoldState();
	let steps: PlanStep[] = [], lastTodo: Record<string, unknown> | undefined, found = false;
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "custom" || !LEGACY_ENTRIES.has(entry.customType as string)) continue;
		found = true;
		if (entry.customType === "pi-todo-turn-start") { steps = []; lastTodo = undefined; continue; }
		if (entry.customType === "pi-todo-write") {
			steps = planSteps(record(entry.data, "legacy todo data").todos);
			lastTodo = entry; continue;
		}
		const data = record(entry.data, "legacy goal entry");
		if (entry.customType === "pi-goal-change/v1") {
			if (data.kind !== "goal/change" || data.version !== 1) throw new Error("unsupported legacy goal change");
			if (data.operation === "clear") {
				exactKeys(data, ["kind", "version", "operation", "cleared", "clearedAt"], "legacy clear");
				applyPlanChange(state, decodePlanChange({ ...data, kind: "plan/change" }));
			} else {
				exactKeys(data, ["kind", "version", "operation", "goal", "roundsStarted", "createdAt", "updatedAt"], "legacy change");
				const goal = record(data.goal, "legacy goal");
				exactKeys(goal, ["id", "revision", "objective", "phase", "maxGoalRounds", ...(goal.phase === "blocked" ? ["blockedReason"] : [])], "legacy goal");
				const { goal: _goal, ...change } = data;
				const { maxGoalRounds, ...definition } = goal;
				applyPlanChange(state, decodePlanChange({ ...change, kind: "plan/change",
					plan: { ...definition, maxRounds: maxGoalRounds, steps: [], autoContinue: true } }));
			}
			continue;
		}
		exactKeys(data, ["kind", "version", "goalId", "revision", "round", "content"], "legacy admission");
		if (data.kind !== "goal/round-admission" || data.version !== 1 || !state.plan)
			throw new Error("invalid legacy round admission");
		const round = integer(data.round, 1, "legacy round"), revision = integer(data.revision, 1, "legacy revision");
		if (typeof data.goalId !== "string" || !data.goalId || data.content !== legacyPrompt(state.plan.objective, state.plan.maxRounds, round))
			throw new Error("legacy round does not match its goal");
		applyPlanRound(state, { planId: data.goalId, revision, round });
	}
	if (state.plan) {
		state.plan.steps = steps;
	} else if (steps.length) {
		// Entry identity keeps projection deterministic before the import is appended.
		// Native forks re-chain parentId when removing label entries.
		const identity = createHash("sha256").update(JSON.stringify({
			entry: lastTodo?.id ?? null, timestamp: lastTodo?.timestamp ?? null, steps,
		})).digest("hex");
		const date = typeof lastTodo?.timestamp === "string" ? Date.parse(lastTodo.timestamp) : 0;
		const now = Number.isSafeInteger(date) && date >= 0 ? date : 0;
		const created = planCreate(state, { objective: "Session plan", steps }, `plan-import-${identity}`, now, DEFAULT_MAX_PLAN_ROUNDS);
		applyPlanChange(state, created.change);
	}
	return { state, found };
}

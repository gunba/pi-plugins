import {
	applyGoalChange,
	applyGoalRound,
	decodeGoalChange,
	emptyGoalFoldState,
	type GoalFoldState,
	type GoalRoundIdentity,
} from "./domain.ts";
import {
	GOAL_CHANGE_ENTRY,
	GOAL_ROUND_ADMISSION_ENTRY,
	GOAL_ROUND_ADMISSION_VERSION,
	GOAL_ROUND_VERSION,
} from "./constants.ts";
import { renderGoalRoundPrompt } from "./prompt.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort().join(",");
	const expected = [...keys].sort().join(",");
	if (actual !== expected) throw new Error(`${label} must have exactly ${expected} fields`);
}

export interface GoalRoundDetails extends GoalRoundIdentity {
	version: typeof GOAL_ROUND_VERSION;
}

export interface GoalRoundAdmission extends GoalRoundIdentity {
	kind: "goal/round-admission";
	version: typeof GOAL_ROUND_ADMISSION_VERSION;
	content: string;
}

export function decodeGoalRoundDetails(value: unknown): GoalRoundDetails {
	if (!isRecord(value)) throw new Error("goal round details must be a record");
	exactKeys(value, ["goalId", "revision", "round", "version"], "goal round details");
	if (value.version !== GOAL_ROUND_VERSION) {
		throw new Error(`unsupported goal round version ${String(value.version)}`);
	}
	if (typeof value.goalId !== "string" || value.goalId.length === 0) {
		throw new Error("goal round goalId must be a non-empty string");
	}
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
		throw new Error("goal round revision must be a positive safe integer");
	}
	if (typeof value.round !== "number" || !Number.isSafeInteger(value.round) || value.round < 1) {
		throw new Error("goal round number must be a positive safe integer");
	}
	return {
		version: GOAL_ROUND_VERSION,
		goalId: value.goalId,
		revision: value.revision,
		round: value.round,
	};
}

export function decodeGoalRoundAdmission(value: unknown): GoalRoundAdmission {
	if (!isRecord(value)) throw new Error("goal round admission must be a record");
	exactKeys(
		value,
		["content", "goalId", "kind", "revision", "round", "version"],
		"goal round admission",
	);
	if (value.kind !== "goal/round-admission") {
		throw new Error("goal round admission has an invalid kind");
	}
	if (value.version !== GOAL_ROUND_ADMISSION_VERSION) {
		throw new Error(`unsupported goal round admission version ${String(value.version)}`);
	}
	if (typeof value.goalId !== "string" || value.goalId.length === 0) {
		throw new Error("goal round admission goalId must be a non-empty string");
	}
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
		throw new Error("goal round admission revision must be a positive safe integer");
	}
	if (typeof value.round !== "number" || !Number.isSafeInteger(value.round) || value.round < 1) {
		throw new Error("goal round admission number must be a positive safe integer");
	}
	if (typeof value.content !== "string") {
		throw new Error("goal round admission content must be a string");
	}
	return {
		kind: "goal/round-admission",
		version: GOAL_ROUND_ADMISSION_VERSION,
		goalId: value.goalId,
		revision: value.revision,
		round: value.round,
		content: value.content,
	};
}

export function createGoalRoundAdmission(
	identity: GoalRoundIdentity,
	content: string,
): GoalRoundAdmission {
	return decodeGoalRoundAdmission({
		kind: "goal/round-admission",
		version: GOAL_ROUND_ADMISSION_VERSION,
		goalId: identity.goalId,
		revision: identity.revision,
		round: identity.round,
		content,
	});
}

export function applyGoalRoundAdmission(
	state: GoalFoldState,
	admission: GoalRoundAdmission,
): void {
	const current = state.goal;
	if (current === undefined) throw new Error("goal round requires a current goal");
	const expected = renderGoalRoundPrompt(current, admission.round);
	if (admission.content !== expected) {
		throw new Error("goal round content does not match its durable goal snapshot");
	}
	applyGoalRound(state, admission);
}

export function replayGoalBranch(entries: readonly unknown[]): GoalFoldState {
	const state = emptyGoalFoldState();
	for (const candidate of entries) {
		if (!isRecord(candidate)) continue;
		if (candidate.type === "custom" && candidate.customType === GOAL_CHANGE_ENTRY) {
			const change = decodeGoalChange(candidate.data);
			if (change === undefined) throw new Error("goal change entry has an invalid kind");
			applyGoalChange(state, change);
			continue;
		}
		if (candidate.type === "custom" && candidate.customType === GOAL_ROUND_ADMISSION_ENTRY) {
			applyGoalRoundAdmission(state, decodeGoalRoundAdmission(candidate.data));
		}
	}
	return state;
}

export function branchContainsRound(
	entries: readonly unknown[],
	identity: GoalRoundIdentity,
): boolean {
	replayGoalBranch(entries);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const candidate = entries[index];
		if (!isRecord(candidate)) continue;
		if (candidate.type !== "custom" || candidate.customType !== GOAL_ROUND_ADMISSION_ENTRY) continue;
		const admission = decodeGoalRoundAdmission(candidate.data);
		if (
			admission.goalId === identity.goalId &&
			admission.revision === identity.revision &&
			admission.round === identity.round
		) return true;
	}
	return false;
}

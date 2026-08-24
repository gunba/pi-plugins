import { GOAL_CHANGE_VERSION } from "./constants.ts";

export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalActivation = "armed" | "disarmed";

export interface GoalRef {
	id: string;
	revision: number;
}

export interface GoalBlockReason {
	code: string;
	message: string;
}

interface GoalSnapshotBase extends GoalRef {
	objective: string;
	maxGoalRounds: number;
}

export type GoalSnapshot =
	| (GoalSnapshotBase & { phase: "active" | "paused" | "complete" })
	| (GoalSnapshotBase & { phase: "blocked"; blockedReason: GoalBlockReason });

export type GoalView = GoalSnapshot & {
	roundsStarted: number;
	createdAt: number;
	updatedAt: number;
	activation: GoalActivation;
};

export type GoalOperation =
	| "create"
	| "edit"
	| "pause"
	| "resume"
	| "complete"
	| "block"
	| "clear";

export interface GoalSnapshotChange {
	kind: "goal/change";
	version: typeof GOAL_CHANGE_VERSION;
	operation: Exclude<GoalOperation, "clear">;
	goal: GoalSnapshot;
	roundsStarted: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalClearChange {
	kind: "goal/change";
	version: typeof GOAL_CHANGE_VERSION;
	operation: "clear";
	cleared: GoalRef;
	clearedAt: number;
}

export type GoalChange = GoalSnapshotChange | GoalClearChange;

export interface GoalRoundIdentity {
	goalId: string;
	revision: number;
	round: number;
}

export interface GoalFoldState {
	goal: GoalSnapshot | undefined;
	roundsStarted: number;
	createdAt: number | undefined;
	updatedAt: number | undefined;
	lastRef: GoalRef | undefined;
	seenGoalIds: Set<string>;
}

export type GoalErrorCode =
	| "GOAL_NOT_FOUND"
	| "GOAL_ALREADY_EXISTS"
	| "GOAL_STALE_REVISION"
	| "GOAL_INVALID_OBJECTIVE"
	| "GOAL_INVALID_MAX_ROUNDS"
	| "GOAL_INVALID_BLOCK_REASON"
	| "GOAL_INVALID_EDIT"
	| "GOAL_INVALID_TRANSITION";

export class GoalError extends Error {
	readonly code: GoalErrorCode;

	constructor(message: string, code: GoalErrorCode) {
		super(message);
		this.name = "GoalError";
		this.code = code;
	}
}

export function emptyGoalFoldState(): GoalFoldState {
	return {
		goal: undefined,
		roundsStarted: 0,
		createdAt: undefined,
		updatedAt: undefined,
		lastRef: undefined,
		seenGoalIds: new Set(),
	};
}

export function cloneGoalFoldState(state: GoalFoldState): GoalFoldState {
	return {
		goal: state.goal === undefined ? undefined : structuredClone(state.goal),
		roundsStarted: state.roundsStarted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		lastRef: state.lastRef === undefined ? undefined : { ...state.lastRef },
		seenGoalIds: new Set(state.seenGoalIds),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort().join(",");
	const expected = [...keys].sort().join(",");
	if (actual !== expected) throw new Error(`${label} must have exactly ${expected} fields`);
}

function positiveSafeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive safe integer`);
	}
	return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function decodeRef(value: unknown, label: string): GoalRef {
	if (!isRecord(value)) throw new Error(`${label} must be a record`);
	exactKeys(value, ["id", "revision"], label);
	if (typeof value.id !== "string" || value.id.length === 0) {
		throw new Error(`${label}.id must be a non-empty string`);
	}
	return { id: value.id, revision: positiveSafeInteger(value.revision, `${label}.revision`) };
}

function decodeBlockReason(value: unknown): GoalBlockReason {
	if (!isRecord(value)) throw new Error("goal.blockedReason must be a record");
	exactKeys(value, ["code", "message"], "goal.blockedReason");
	if (typeof value.code !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.code)) {
		throw new Error("goal.blockedReason.code must be lower-kebab-case");
	}
	if (
		typeof value.message !== "string" ||
		value.message.trim().length === 0 ||
		value.message !== value.message.trim()
	) {
		throw new Error("goal.blockedReason.message must be non-empty and normalized");
	}
	return { code: value.code, message: value.message };
}

function decodeSnapshot(value: unknown): GoalSnapshot {
	if (!isRecord(value)) throw new Error("goal must be a record");
	if (typeof value.phase !== "string" || !["active", "paused", "blocked", "complete"].includes(value.phase)) {
		throw new Error("goal.phase is invalid");
	}
	const phase = value.phase as GoalPhase;
	const expected = phase === "blocked"
		? ["blockedReason", "id", "maxGoalRounds", "objective", "phase", "revision"]
		: ["id", "maxGoalRounds", "objective", "phase", "revision"];
	exactKeys(value, expected, `goal for phase ${phase}`);
	if (typeof value.id !== "string" || value.id.length === 0) {
		throw new Error("goal.id must be a non-empty string");
	}
	if (
		typeof value.objective !== "string" ||
		value.objective.trim().length === 0 ||
		value.objective !== value.objective.trim()
	) {
		throw new Error("goal.objective must be non-empty and normalized");
	}
	const base: GoalSnapshotBase = {
		id: value.id,
		revision: positiveSafeInteger(value.revision, "goal.revision"),
		objective: value.objective,
		maxGoalRounds: positiveSafeInteger(value.maxGoalRounds, "goal.maxGoalRounds"),
	};
	if (phase === "blocked") {
		return { ...base, phase, blockedReason: decodeBlockReason(value.blockedReason) };
	}
	return { ...base, phase };
}

export function decodeGoalChange(value: unknown): GoalChange | undefined {
	if (!isRecord(value) || value.kind !== "goal/change") return undefined;
	if (value.version !== GOAL_CHANGE_VERSION) {
		throw new Error(`unsupported goal change version ${String(value.version)}`);
	}
	if (value.operation === "clear") {
		exactKeys(value, ["cleared", "clearedAt", "kind", "operation", "version"], "goal clear change");
		return {
			kind: "goal/change",
			version: GOAL_CHANGE_VERSION,
			operation: "clear",
			cleared: decodeRef(value.cleared, "goal clear tombstone"),
			clearedAt: nonNegativeSafeInteger(value.clearedAt, "clearedAt"),
		};
	}
	const operations: readonly string[] = ["create", "edit", "pause", "resume", "complete", "block"];
	if (typeof value.operation !== "string" || !operations.includes(value.operation)) {
		throw new Error("goal change operation is invalid");
	}
	exactKeys(
		value,
		["createdAt", "goal", "kind", "operation", "roundsStarted", "updatedAt", "version"],
		"goal snapshot change",
	);
	const createdAt = nonNegativeSafeInteger(value.createdAt, "createdAt");
	const updatedAt = nonNegativeSafeInteger(value.updatedAt, "updatedAt");
	if (updatedAt < createdAt) throw new Error("goal change updatedAt cannot precede createdAt");
	return {
		kind: "goal/change",
		version: GOAL_CHANGE_VERSION,
		operation: value.operation as Exclude<GoalOperation, "clear">,
		goal: decodeSnapshot(value.goal),
		roundsStarted: nonNegativeSafeInteger(value.roundsStarted, "roundsStarted"),
		createdAt,
		updatedAt,
	};
}

function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
	if (next.id !== current.id || next.revision !== current.revision + 1) {
		throw new Error(`goal ${operation} must advance the current goal by one revision`);
	}
}

function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
	if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
		throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);
	}
}

function sameBlockReason(left: GoalSnapshot, right: GoalSnapshot): boolean {
	if (left.phase !== "blocked" || right.phase !== "blocked") {
		return left.phase !== "blocked" && right.phase !== "blocked";
	}
	return left.blockedReason.code === right.blockedReason.code
		&& left.blockedReason.message === right.blockedReason.message;
}

function validateTransition(
	state: GoalFoldState,
	change: GoalSnapshotChange,
	current: GoalSnapshot,
): void {
	const next = change.goal;
	requireNextRevision(current, next, change.operation);
	if (
		state.updatedAt === undefined ||
		change.createdAt !== state.createdAt ||
		change.updatedAt < state.updatedAt ||
		change.roundsStarted !== state.roundsStarted
	) {
		throw new Error(`goal ${change.operation} does not preserve the current counters and timestamps`);
	}
	switch (change.operation) {
		case "edit":
			if (next.phase !== current.phase || !sameBlockReason(next, current)) {
				throw new Error("goal edit cannot change phase or blocked reason");
			}
			return;
		case "pause":
			requireSameDefinition(current, next, change.operation);
			if (current.phase !== "active" || next.phase !== "paused") {
				throw new Error("goal pause has an invalid phase transition");
			}
			return;
		case "resume":
			requireSameDefinition(current, next, change.operation);
			if (
				!["active", "paused", "blocked"].includes(current.phase) ||
				next.phase !== "active" ||
				state.roundsStarted >= next.maxGoalRounds
			) {
				throw new Error("goal resume has an invalid phase transition or exhausted round budget");
			}
			return;
		case "complete":
			requireSameDefinition(current, next, change.operation);
			if (current.phase === "complete" || next.phase !== "complete") {
				throw new Error("goal complete has an invalid phase transition");
			}
			return;
		case "block":
			requireSameDefinition(current, next, change.operation);
			if (current.phase !== "active" || next.phase !== "blocked") {
				throw new Error("goal block has an invalid phase transition");
			}
			return;
		case "create":
			throw new Error("goal create cannot be applied as a current-goal transition");
	}
}

export function goalChangeRef(change: GoalChange): GoalRef {
	return change.operation === "clear"
		? { ...change.cleared }
		: { id: change.goal.id, revision: change.goal.revision };
}

export function applyGoalChange(state: GoalFoldState, change: GoalChange): void {
	const ref = goalChangeRef(change);
	if (change.operation === "clear") {
		const current = state.goal;
		if (current === undefined) throw new Error("goal clear requires a current goal");
		requireNextRevision(current, change.cleared, "clear");
		if (state.updatedAt === undefined || change.clearedAt < state.updatedAt) {
			throw new Error("goal clear timestamp cannot precede the current goal update");
		}
		state.goal = undefined;
		state.roundsStarted = 0;
		state.createdAt = undefined;
		state.updatedAt = undefined;
		state.lastRef = ref;
		return;
	}
	if (change.operation === "create") {
		if (
			change.goal.revision !== 1 ||
			change.goal.phase !== "active" ||
			change.roundsStarted !== 0 ||
			(state.goal !== undefined && state.goal.phase !== "complete") ||
			state.seenGoalIds.has(change.goal.id)
		) {
			throw new Error("goal create requires a fresh active revision-one goal with zero rounds");
		}
		state.seenGoalIds.add(change.goal.id);
	} else {
		if (state.goal === undefined) throw new Error(`goal ${change.operation} requires a current goal`);
		validateTransition(state, change, state.goal);
	}
	state.goal = structuredClone(change.goal);
	state.roundsStarted = change.roundsStarted;
	state.createdAt = change.createdAt;
	state.updatedAt = change.updatedAt;
	state.lastRef = ref;
}

export function applyGoalRound(state: GoalFoldState, source: GoalRoundIdentity): void {
	if (
		typeof source.goalId !== "string" ||
		source.goalId.length === 0 ||
		!Number.isSafeInteger(source.revision) ||
		source.revision < 1 ||
		!Number.isSafeInteger(source.round) ||
		source.round < 1
	) {
		throw new Error("goal round identity is invalid");
	}
	const current = state.goal;
	if (
		current === undefined ||
		current.phase !== "active" ||
		source.goalId !== current.id ||
		source.revision !== current.revision ||
		source.round !== state.roundsStarted + 1 ||
		source.round > current.maxGoalRounds
	) {
		throw new Error("goal round is not the next admitted round of the active goal");
	}
	state.roundsStarted = source.round;
}

export function goalView(state: GoalFoldState, activation: GoalActivation): GoalView | undefined {
	if (state.goal === undefined) return undefined;
	if (state.createdAt === undefined || state.updatedAt === undefined) {
		throw new Error(`goal ${state.goal.id} lacks durable timestamps`);
	}
	return {
		...structuredClone(state.goal),
		roundsStarted: state.roundsStarted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		activation,
	};
}

export interface CreateGoalRequest {
	objective: string;
	maxGoalRounds?: number;
}

export interface EditGoalRequest {
	objective?: string;
	maxGoalRounds?: number;
}

export interface PlannedGoalChange {
	change: GoalChange;
	activation: GoalActivation;
}

export function normalizeObjective(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GoalError("goal objective must be a non-empty string", "GOAL_INVALID_OBJECTIVE");
	}
	return value.trim();
}

export function normalizeMaxGoalRounds(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new GoalError("maxGoalRounds must be a positive safe integer", "GOAL_INVALID_MAX_ROUNDS");
	}
	return value;
}

export function normalizeBlockReason(value: unknown): GoalBlockReason {
	if (!isRecord(value)) {
		throw new GoalError("goal block reason is invalid", "GOAL_INVALID_BLOCK_REASON");
	}
	const code = value.code;
	const message = value.message;
	if (
		typeof code !== "string" ||
		!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) ||
		typeof message !== "string" ||
		message.trim().length === 0
	) {
		throw new GoalError(
			"goal block reason requires a lower-kebab-case code and a non-empty message",
			"GOAL_INVALID_BLOCK_REASON",
		);
	}
	return { code, message: message.trim() };
}

function currentGoal(state: GoalFoldState): GoalSnapshot {
	if (state.goal === undefined) throw new GoalError("no current goal", "GOAL_NOT_FOUND");
	return state.goal;
}

function expectRef(state: GoalFoldState, ref: GoalRef): GoalSnapshot {
	const current = currentGoal(state);
	if (ref.id !== current.id || ref.revision !== current.revision) {
		throw new GoalError(
			`stale goal ref ${JSON.stringify(ref.id)} revision ${ref.revision}; current is ${JSON.stringify(current.id)} revision ${current.revision}`,
			"GOAL_STALE_REVISION",
		);
	}
	return current;
}

function nextTime(state: GoalFoldState, now: number): number {
	if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");
	if (state.updatedAt === undefined) throw new Error("current goal lacks updatedAt");
	return Math.max(now, state.updatedAt);
}

function snapshotChange(
	state: GoalFoldState,
	operation: Exclude<GoalOperation, "create" | "clear">,
	goal: GoalSnapshot,
	now: number,
	activation: GoalActivation,
): PlannedGoalChange {
	if (state.createdAt === undefined) throw new Error("current goal lacks createdAt");
	return {
		change: {
			kind: "goal/change",
			version: GOAL_CHANGE_VERSION,
			operation,
			goal,
			roundsStarted: state.roundsStarted,
			createdAt: state.createdAt,
			updatedAt: nextTime(state, now),
		},
		activation,
	};
}

function phaseSnapshot(current: GoalSnapshot, phase: "active" | "paused" | "complete"): GoalSnapshot {
	return {
		id: current.id,
		revision: current.revision + 1,
		objective: current.objective,
		phase,
		maxGoalRounds: current.maxGoalRounds,
	};
}

export function planCreate(
	state: GoalFoldState,
	request: CreateGoalRequest,
	id: string,
	now: number,
	defaultMaxGoalRounds: number,
): PlannedGoalChange {
	if (state.goal !== undefined && state.goal.phase !== "complete") {
		throw new GoalError(
			`goal ${JSON.stringify(state.goal.id)} already exists with phase ${JSON.stringify(state.goal.phase)}`,
			"GOAL_ALREADY_EXISTS",
		);
	}
	if (typeof id !== "string" || id.length === 0 || state.seenGoalIds.has(id)) {
		throw new TypeError("goal id must be fresh and non-empty");
	}
	if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");
	const goal: GoalSnapshot = {
		id,
		revision: 1,
		objective: normalizeObjective(request.objective),
		phase: "active",
		maxGoalRounds: normalizeMaxGoalRounds(request.maxGoalRounds ?? defaultMaxGoalRounds),
	};
	return {
		change: {
			kind: "goal/change",
			version: GOAL_CHANGE_VERSION,
			operation: "create",
			goal,
			roundsStarted: 0,
			createdAt: now,
			updatedAt: now,
		},
		activation: "armed",
	};
}

export function planEdit(
	state: GoalFoldState,
	ref: GoalRef,
	request: EditGoalRequest,
	now: number,
	activation: GoalActivation,
): PlannedGoalChange {
	const current = expectRef(state, ref);
	if (request.objective === undefined && request.maxGoalRounds === undefined) {
		throw new GoalError("goal edit requires objective and/or maxGoalRounds", "GOAL_INVALID_EDIT");
	}
	const definition = {
		id: current.id,
		revision: current.revision + 1,
		objective: request.objective === undefined ? current.objective : normalizeObjective(request.objective),
		maxGoalRounds: request.maxGoalRounds === undefined
			? current.maxGoalRounds
			: normalizeMaxGoalRounds(request.maxGoalRounds),
	};
	const goal: GoalSnapshot = current.phase === "blocked"
		? { ...definition, phase: "blocked", blockedReason: { ...current.blockedReason } }
		: { ...definition, phase: current.phase };
	return snapshotChange(state, "edit", goal, now, activation);
}

export function planPause(state: GoalFoldState, ref: GoalRef, now: number): PlannedGoalChange {
	const current = expectRef(state, ref);
	if (current.phase !== "active") {
		throw new GoalError(`cannot pause goal from phase ${current.phase}`, "GOAL_INVALID_TRANSITION");
	}
	return snapshotChange(state, "pause", phaseSnapshot(current, "paused"), now, "disarmed");
}

export function planResume(
	state: GoalFoldState,
	ref: GoalRef,
	now: number,
	activation: GoalActivation,
): PlannedGoalChange {
	const current = expectRef(state, ref);
	if (!["active", "paused", "blocked"].includes(current.phase)) {
		throw new GoalError(`cannot resume goal from phase ${current.phase}`, "GOAL_INVALID_TRANSITION");
	}
	if (current.phase === "active" && activation === "armed") {
		throw new GoalError("goal is already active and armed", "GOAL_INVALID_TRANSITION");
	}
	if (state.roundsStarted >= current.maxGoalRounds) {
		throw new GoalError("goal round budget is exhausted", "GOAL_INVALID_TRANSITION");
	}
	return snapshotChange(state, "resume", phaseSnapshot(current, "active"), now, "armed");
}

export function planComplete(state: GoalFoldState, ref: GoalRef, now: number): PlannedGoalChange {
	const current = expectRef(state, ref);
	if (current.phase === "complete") {
		throw new GoalError("goal is already complete", "GOAL_INVALID_TRANSITION");
	}
	return snapshotChange(state, "complete", phaseSnapshot(current, "complete"), now, "disarmed");
}

export function planBlock(
	state: GoalFoldState,
	ref: GoalRef,
	reason: GoalBlockReason,
	now: number,
): PlannedGoalChange {
	const current = expectRef(state, ref);
	if (current.phase !== "active") {
		throw new GoalError(`cannot block goal from phase ${current.phase}`, "GOAL_INVALID_TRANSITION");
	}
	const goal: GoalSnapshot = {
		id: current.id,
		revision: current.revision + 1,
		objective: current.objective,
		phase: "blocked",
		blockedReason: normalizeBlockReason(reason),
		maxGoalRounds: current.maxGoalRounds,
	};
	return snapshotChange(state, "block", goal, now, "disarmed");
}

export function planClear(state: GoalFoldState, ref: GoalRef, now: number): PlannedGoalChange {
	const current = expectRef(state, ref);
	return {
		change: {
			kind: "goal/change",
			version: GOAL_CHANGE_VERSION,
			operation: "clear",
			cleared: { id: current.id, revision: current.revision + 1 },
			clearedAt: nextTime(state, now),
		},
		activation: "disarmed",
	};
}

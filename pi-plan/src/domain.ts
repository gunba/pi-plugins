import { isDeepStrictEqual } from "node:util";
import { planSteps, type PlanStep } from "./steps.ts";

export type PlanPhase = "active" | "paused" | "blocked" | "complete";
export type PlanActivation = "armed" | "disarmed";
export interface PlanRef { id: string; revision: number }
export interface PlanBlockReason { code: string; message: string }
interface PlanDefinition extends PlanRef {
	objective: string;
	steps: PlanStep[];
	autoContinue: boolean;
	maxRounds: number;
}
export type PlanSnapshot = PlanDefinition & (
	{ phase: "active" | "paused" | "complete" } | { phase: "blocked"; blockedReason: PlanBlockReason }
);
export type PlanView = PlanSnapshot & {
	roundsStarted: number; createdAt: number; updatedAt: number; activation: PlanActivation;
};
export type PlanOperation = "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";
export type PlanChange =
	| { kind: "plan/change"; version: 1; operation: "clear"; cleared: PlanRef; clearedAt: number }
	| { kind: "plan/change"; version: 1; operation: Exclude<PlanOperation, "clear">;
		plan: PlanSnapshot; roundsStarted: number; createdAt: number; updatedAt: number };
export interface PlanRoundIdentity { planId: string; revision: number; round: number }
export interface PlanFoldState {
	plan: PlanSnapshot | undefined;
	roundsStarted: number;
	createdAt: number | undefined;
	updatedAt: number | undefined;
	lastRef: PlanRef | undefined;
	seenPlanIds: Set<string>;
}
export interface CreatePlanRequest {
	objective: string; steps?: PlanStep[]; autoContinue?: boolean; maxRounds?: number;
}
export interface EditPlanRequest {
	objective?: string; steps?: PlanStep[]; autoContinue?: boolean; maxRounds?: number;
}
export interface PlannedPlanChange { change: PlanChange; activation: PlanActivation }

export class PlanError extends Error {
	readonly code: string;
	constructor(message: string, code: string) { super(message); this.name = "PlanError"; this.code = code; }
}
export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a record`);
	return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${label} has invalid fields`);
}
export function integer(value: unknown, minimum: number, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
	return value;
}
export function normalizeObjective(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new PlanError("plan objective must be a non-empty string", "PLAN_INVALID_OBJECTIVE");
	return value.trim();
}
function automatic(value: unknown): boolean {
	if (typeof value !== "boolean") throw new PlanError("autoContinue must be a boolean", "PLAN_INVALID_MODE");
	return value;
}
export function normalizeBlockReason(value: unknown): PlanBlockReason {
	const reason = record(value, "block reason");
	exactKeys(reason, ["code", "message"], "block reason");
	if (typeof reason.code !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reason.code))
		throw new PlanError("block reason code must be lower-kebab-case", "PLAN_INVALID_BLOCK_REASON");
	if (typeof reason.message !== "string" || !reason.message.trim())
		throw new PlanError("block reason must be a non-empty string", "PLAN_INVALID_BLOCK_REASON");
	return { code: reason.code, message: reason.message.trim() };
}
function decodeRef(value: unknown): PlanRef {
	const ref = record(value, "plan reference");
	exactKeys(ref, ["id", "revision"], "plan reference");
	if (typeof ref.id !== "string" || !ref.id.length) throw new Error("plan id must be non-empty");
	return { id: ref.id, revision: integer(ref.revision, 1, "revision") };
}
export function decodePlanSnapshot(value: unknown): PlanSnapshot {
	const input = record(value, "plan");
	if (!["active", "paused", "blocked", "complete"].includes(input.phase as string)) throw new Error("invalid plan phase");
	exactKeys(input, ["id", "revision", "objective", "steps", "autoContinue", "maxRounds", "phase",
		...(input.phase === "blocked" ? ["blockedReason"] : [])], "plan");
	const base: PlanDefinition = {
		...decodeRef({ id: input.id, revision: input.revision }), objective: normalizeObjective(input.objective),
		steps: planSteps(input.steps), autoContinue: automatic(input.autoContinue), maxRounds: integer(input.maxRounds, 1, "maxRounds"),
	};
	if (base.objective !== input.objective) throw new Error("plan objective must be normalized");
	if (input.phase === "blocked") {
		const reason = normalizeBlockReason(input.blockedReason);
		if (!isDeepStrictEqual(reason, input.blockedReason)) throw new Error("block reason must be normalized");
		return { ...base, phase: "blocked", blockedReason: reason };
	}
	return { ...base, phase: input.phase as "active" | "paused" | "complete" };
}
export function decodePlanChange(value: unknown): PlanChange {
	const input = record(value, "plan change");
	if (input.kind !== "plan/change" || input.version !== 1) throw new Error("unsupported plan change");
	if (input.operation === "clear") {
		exactKeys(input, ["kind", "version", "operation", "cleared", "clearedAt"], "plan clear");
		return { kind: "plan/change", version: 1, operation: "clear", cleared: decodeRef(input.cleared),
			clearedAt: integer(input.clearedAt, 0, "clearedAt") };
	}
	if (!["create", "edit", "pause", "resume", "complete", "block"].includes(input.operation as string)) throw new Error("invalid plan operation");
	exactKeys(input, ["kind", "version", "operation", "plan", "roundsStarted", "createdAt", "updatedAt"], "plan change");
	const createdAt = integer(input.createdAt, 0, "createdAt"), updatedAt = integer(input.updatedAt, 0, "updatedAt");
	if (updatedAt < createdAt) throw new Error("updatedAt precedes createdAt");
	return { kind: "plan/change", version: 1, operation: input.operation as Exclude<PlanOperation, "clear">,
		plan: decodePlanSnapshot(input.plan), roundsStarted: integer(input.roundsStarted, 0, "roundsStarted"), createdAt, updatedAt };
}
export function emptyPlanFoldState(): PlanFoldState {
	return { plan: undefined, roundsStarted: 0, createdAt: undefined, updatedAt: undefined, lastRef: undefined, seenPlanIds: new Set() };
}
export function clonePlanFoldState(state: PlanFoldState): PlanFoldState { return structuredClone(state); }
function definition(plan: PlanSnapshot) {
	return { objective: plan.objective, steps: plan.steps, autoContinue: plan.autoContinue, maxRounds: plan.maxRounds };
}
function nextRef(current: PlanSnapshot, next: PlanRef): void {
	if (next.id !== current.id || next.revision !== current.revision + 1) throw new Error("plan change must advance one revision of the current plan");
}
export function applyPlanChange(state: PlanFoldState, change: PlanChange): void {
	const current = state.plan;
	if (change.operation === "clear") {
		if (!current) throw new Error("clear requires a current plan");
		nextRef(current, change.cleared);
		if (state.updatedAt === undefined || change.clearedAt < state.updatedAt) throw new Error("clear timestamp regressed");
		state.plan = undefined; state.roundsStarted = 0; state.createdAt = undefined; state.updatedAt = undefined;
		state.lastRef = { ...change.cleared }; return;
	}
	const next = change.plan;
	if (change.operation === "create") {
		if (next.revision !== 1 || next.phase !== "active" || change.roundsStarted !== 0
			|| (current && current.phase !== "complete") || state.seenPlanIds.has(next.id))
			throw new Error("create requires a fresh active revision-one plan with zero rounds");
		state.seenPlanIds.add(next.id);
	} else {
		if (!current) throw new Error(`${change.operation} requires a current plan`);
		nextRef(current, next);
		if (state.updatedAt === undefined || change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt || change.roundsStarted !== state.roundsStarted)
			throw new Error("plan change must preserve counters and timestamps");
		if (change.operation === "edit") {
			if (next.phase !== current.phase || !isDeepStrictEqual(
				next.phase === "blocked" ? next.blockedReason : undefined, current.phase === "blocked" ? current.blockedReason : undefined))
				throw new Error("edit cannot change phase or blocked reason");
		} else {
			if (!isDeepStrictEqual(definition(current), definition(next))) throw new Error(`${change.operation} cannot change the plan definition`);
			const valid = change.operation === "pause" ? current.phase === "active" && next.phase === "paused"
				: change.operation === "resume" ? ["active", "paused", "blocked"].includes(current.phase) && next.phase === "active"
					&& (!next.autoContinue || state.roundsStarted < next.maxRounds)
				: change.operation === "complete" ? current.phase !== "complete" && next.phase === "complete"
					&& next.steps.every(step => step.status === "completed")
				: current.phase === "active" && next.phase === "blocked";
			if (!valid) throw new Error(`invalid ${change.operation} transition`);
		}
	}
	state.plan = structuredClone(next); state.roundsStarted = change.roundsStarted;
	state.createdAt = change.createdAt; state.updatedAt = change.updatedAt; state.lastRef = { id: next.id, revision: next.revision };
}
/** A complete retained change can anchor a branch whose native ancestors are missing. */
export function restorePlanCheckpoint(change: PlanChange): PlanFoldState {
	const state = emptyPlanFoldState();
	if (change.operation === "create") { applyPlanChange(state, change); return state; }
	const ref = change.operation === "clear" ? change.cleared : change.plan;
	if (ref.revision < 2) throw new Error("plan checkpoint must follow an earlier revision");
	state.seenPlanIds.add(ref.id);
	state.lastRef = { id: ref.id, revision: ref.revision };
	if (change.operation === "clear") return state;
	const next = change.plan;
	const valid = change.operation === "edit"
		|| change.operation === "pause" && next.phase === "paused"
		|| change.operation === "resume" && next.phase === "active" && (!next.autoContinue || change.roundsStarted < next.maxRounds)
		|| change.operation === "complete" && next.phase === "complete" && next.steps.every(step => step.status === "completed")
		|| change.operation === "block" && next.phase === "blocked";
	if (!valid) throw new Error("plan checkpoint does not match its operation");
	state.plan = structuredClone(next); state.roundsStarted = change.roundsStarted;
	state.createdAt = change.createdAt; state.updatedAt = change.updatedAt;
	return state;
}
export function applyPlanRound(state: PlanFoldState, source: PlanRoundIdentity): void {
	const current = state.plan;
	if (!current || !current.autoContinue || current.phase !== "active" || source.planId !== current.id
		|| source.revision !== current.revision || !Number.isSafeInteger(source.round) || source.round !== state.roundsStarted + 1
		|| source.round > current.maxRounds) throw new Error("round is not the next admitted round of the automatic plan");
	state.roundsStarted = source.round;
}
export function planView(state: PlanFoldState, activation: PlanActivation): PlanView | undefined {
	if (!state.plan) return undefined;
	if (state.createdAt === undefined || state.updatedAt === undefined) throw new Error("plan lacks durable timestamps");
	return { ...structuredClone(state.plan), roundsStarted: state.roundsStarted, createdAt: state.createdAt, updatedAt: state.updatedAt,
		activation: state.plan.autoContinue ? activation : "disarmed" };
}
function expectRef(state: PlanFoldState, ref: PlanRef): PlanSnapshot {
	if (!state.plan) throw new PlanError("no current plan", "PLAN_NOT_FOUND");
	if (ref.id !== state.plan.id || ref.revision !== state.plan.revision)
		throw new PlanError("plan changed; read its current id and revision before updating", "PLAN_STALE_REVISION");
	return state.plan;
}
function snapshotChange(state: PlanFoldState, operation: Exclude<PlanOperation, "create" | "clear">, plan: PlanSnapshot, now: number, activation: PlanActivation): PlannedPlanChange {
	if (state.createdAt === undefined || state.updatedAt === undefined) throw new Error("plan lacks durable timestamps");
	return { change: { kind: "plan/change", version: 1, operation, plan, roundsStarted: state.roundsStarted,
		createdAt: state.createdAt, updatedAt: Math.max(integer(now, 0, "now"), state.updatedAt) }, activation };
}
function phaseSnapshot(current: PlanSnapshot, phase: "active" | "paused" | "complete"): PlanSnapshot {
	return { id: current.id, revision: current.revision + 1, ...structuredClone(definition(current)), phase };
}
export function planCreate(state: PlanFoldState, request: CreatePlanRequest, id: string, now: number, defaultMaxRounds: number): PlannedPlanChange {
	if (state.plan && state.plan.phase !== "complete") throw new PlanError("an unfinished plan already exists", "PLAN_ALREADY_EXISTS");
	if (!id || state.seenPlanIds.has(id)) throw new Error("plan id must be fresh and non-empty");
	const plan: PlanSnapshot = { id, revision: 1, objective: normalizeObjective(request.objective),
		steps: planSteps(request.steps === undefined ? [] : request.steps, true),
		autoContinue: automatic(request.autoContinue === undefined ? false : request.autoContinue),
		maxRounds: integer(request.maxRounds === undefined ? defaultMaxRounds : request.maxRounds, 1, "maxRounds"), phase: "active" };
	return { change: { kind: "plan/change", version: 1, operation: "create", plan, roundsStarted: 0,
		createdAt: integer(now, 0, "now"), updatedAt: now }, activation: plan.autoContinue ? "armed" : "disarmed" };
}
export function planEdit(state: PlanFoldState, ref: PlanRef, request: EditPlanRequest, now: number, activation: PlanActivation): PlannedPlanChange {
	const current = expectRef(state, ref);
	if (request.objective === undefined && request.steps === undefined && request.autoContinue === undefined && request.maxRounds === undefined)
		throw new PlanError("edit requires objective, steps, autoContinue, or maxRounds", "PLAN_INVALID_EDIT");
	const next: PlanSnapshot = { ...structuredClone(current), revision: current.revision + 1,
		objective: request.objective === undefined ? current.objective : normalizeObjective(request.objective),
		steps: request.steps === undefined ? structuredClone(current.steps) : planSteps(request.steps, true),
		autoContinue: request.autoContinue === undefined ? current.autoContinue : automatic(request.autoContinue),
		maxRounds: request.maxRounds === undefined ? current.maxRounds : integer(request.maxRounds, 1, "maxRounds") };
	return snapshotChange(state, "edit", next, now, !next.autoContinue || next.phase !== "active" ? "disarmed"
		: !current.autoContinue ? "armed" : activation);
}
export function planPause(state: PlanFoldState, ref: PlanRef, now: number): PlannedPlanChange {
	const current = expectRef(state, ref);
	if (current.phase !== "active") throw new PlanError("only an active plan can be paused", "PLAN_INVALID_TRANSITION");
	return snapshotChange(state, "pause", phaseSnapshot(current, "paused"), now, "disarmed");
}
export function planResume(state: PlanFoldState, ref: PlanRef, now: number, activation: PlanActivation): PlannedPlanChange {
	const current = expectRef(state, ref);
	if (!["active", "paused", "blocked"].includes(current.phase)
		|| (current.phase === "active" && (!current.autoContinue || activation === "armed"))
		|| (current.autoContinue && state.roundsStarted >= current.maxRounds))
		throw new PlanError("plan cannot resume from its current state or round budget", "PLAN_INVALID_TRANSITION");
	return snapshotChange(state, "resume", phaseSnapshot(current, "active"), now, current.autoContinue ? "armed" : "disarmed");
}
export function planComplete(state: PlanFoldState, ref: PlanRef, now: number): PlannedPlanChange {
	const current = expectRef(state, ref);
	if (current.phase === "complete") throw new PlanError("plan is already complete", "PLAN_INVALID_TRANSITION");
	if (current.steps.some(step => step.status !== "completed")) throw new PlanError("complete the remaining steps before completing the plan", "PLAN_UNFINISHED_STEPS");
	return snapshotChange(state, "complete", phaseSnapshot(current, "complete"), now, "disarmed");
}
export function planBlock(state: PlanFoldState, ref: PlanRef, reason: PlanBlockReason, now: number): PlannedPlanChange {
	const current = expectRef(state, ref);
	if (current.phase !== "active") throw new PlanError("only an active plan can be blocked", "PLAN_INVALID_TRANSITION");
	const plan: PlanSnapshot = { ...phaseSnapshot(current, "active"), phase: "blocked", blockedReason: normalizeBlockReason(reason) };
	return snapshotChange(state, "block", plan, now, "disarmed");
}
export function planClear(state: PlanFoldState, ref: PlanRef, now: number): PlannedPlanChange {
	const current = expectRef(state, ref);
	return { change: { kind: "plan/change", version: 1, operation: "clear", cleared: { id: current.id, revision: current.revision + 1 },
		clearedAt: Math.max(integer(now, 0, "now"), state.updatedAt!) }, activation: "disarmed" };
}

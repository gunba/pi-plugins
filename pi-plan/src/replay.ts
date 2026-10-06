import { isDeepStrictEqual } from "node:util";
import { applyPlanChange, applyPlanRound, decodePlanChange, decodePlanSnapshot, exactKeys, integer, record, restorePlanCheckpoint,
	type PlanFoldState, type PlanRoundIdentity } from "./domain.ts";
import { PLAN_CHANGE_ENTRY, PLAN_IMPORT_ENTRY, PLAN_ROUND_ADMISSION_ENTRY } from "./constants.ts";
import { LEGACY_ENTRIES, legacyPlan } from "./legacy.ts";
import { renderPlanRoundPrompt } from "./prompt.ts";

export interface PlanRoundDetails extends PlanRoundIdentity { version: 1 }
export interface PlanRoundAdmission extends PlanRoundIdentity {
	kind: "plan/round-admission"; version: 1; content: string;
}
export function decodePlanRoundDetails(value: unknown): PlanRoundDetails {
	const input = record(value, "plan round details");
	exactKeys(input, ["version", "planId", "revision", "round"], "plan round details");
	if (input.version !== 1 || typeof input.planId !== "string" || !input.planId) throw new Error("invalid plan round details");
	return { version: 1, planId: input.planId, revision: integer(input.revision, 1, "revision"), round: integer(input.round, 1, "round") };
}
export function decodePlanRoundAdmission(value: unknown): PlanRoundAdmission {
	const input = record(value, "plan round admission");
	exactKeys(input, ["kind", "version", "planId", "revision", "round", "content"], "plan round admission");
	if (input.kind !== "plan/round-admission" || typeof input.content !== "string") throw new Error("invalid plan round admission");
	const { kind: _kind, content, ...details } = input;
	return { kind: "plan/round-admission", ...decodePlanRoundDetails(details), content };
}
export function createPlanRoundAdmission(identity: PlanRoundIdentity, content: string): PlanRoundAdmission {
	return decodePlanRoundAdmission({ kind: "plan/round-admission", version: 1,
		planId: identity.planId, revision: identity.revision, round: identity.round, content });
}
export function applyPlanRoundAdmission(state: PlanFoldState, admission: PlanRoundAdmission): void {
	if (!state.plan || admission.content !== renderPlanRoundPrompt(state.plan, admission.round))
		throw new Error("plan round content does not match its durable snapshot");
	applyPlanRound(state, admission);
}
export function planImport(state: PlanFoldState) {
	return { kind: "plan/import", version: 1, plan: state.plan ? structuredClone(state.plan) : null,
		roundsStarted: state.roundsStarted, createdAt: state.createdAt ?? null, updatedAt: state.updatedAt ?? null };
}
function checkImport(data: unknown, state: PlanFoldState): void {
	const input = record(data, "plan import");
	exactKeys(input, ["kind", "version", "plan", "roundsStarted", "createdAt", "updatedAt"], "plan import");
	const normalized = { ...input, plan: input.plan === null ? null : decodePlanSnapshot(input.plan) };
	if (!isDeepStrictEqual(normalized, planImport(state))) throw new Error("plan import does not match the selected legacy branch");
}
function custom(entry: unknown): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	return (entry as Record<string, unknown>).type === "custom" ? entry as Record<string, unknown> : undefined;
}
const PLAN_ENTRIES = new Set([PLAN_CHANGE_ENTRY, PLAN_IMPORT_ENTRY, PLAN_ROUND_ADMISSION_ENTRY]);

function missingBranchParent(entries: readonly unknown[]): string | undefined {
	const head = entries[0] as Record<string, unknown> | undefined;
	if (!head || typeof head.parentId !== "string" || !head.parentId) return undefined;
	const missing = head.parentId, seen = new Set<string>();
	let parent = missing;
	for (const value of entries) {
		if (!value || typeof value !== "object") return undefined;
		const entry = value as Record<string, unknown>;
		if (typeof entry.id !== "string" || !entry.id || entry.id === missing || seen.has(entry.id) || entry.parentId !== parent)
			return undefined;
		seen.add(entry.id); parent = entry.id;
	}
	return missing;
}

export function replayPlanBranch(entries: readonly unknown[]): { state: PlanFoldState; needsImport: boolean; recoveryParent?: string } {
	const boundary = entries.findIndex(entry => PLAN_ENTRIES.has(custom(entry)?.customType as string));
	let { state, found } = legacyPlan(boundary < 0 ? entries : entries.slice(0, boundary));
	if (boundary < 0) return { state, needsImport: found };
	const first = custom(entries[boundary])!;
	const recoveryParent = !found && first.customType === PLAN_CHANGE_ENTRY ? missingBranchParent(entries) : undefined;
	let start = boundary;
	if (recoveryParent) {
		state = restorePlanCheckpoint(decodePlanChange(first.data));
		start++;
	} else if (found) {
		if (first.customType !== PLAN_IMPORT_ENTRY) throw new Error("legacy state requires a plan import before new changes");
		checkImport(first.data, state);
		start++;
	} else if (first.customType === PLAN_IMPORT_ENTRY) throw new Error("plan import has no legacy source");
	for (let index = start; index < entries.length; index++) {
		const entry = custom(entries[index]);
		if (!entry) continue;
		if (entry.customType === PLAN_IMPORT_ENTRY) throw new Error("plan branch already imported");
		if (LEGACY_ENTRIES.has(entry.customType as string)) throw new Error("retired goal/todo writer appended after plan cutover");
		if (entry.customType === PLAN_CHANGE_ENTRY) applyPlanChange(state, decodePlanChange(entry.data));
		if (entry.customType === PLAN_ROUND_ADMISSION_ENTRY) applyPlanRoundAdmission(state, decodePlanRoundAdmission(entry.data));
	}
	return { state, needsImport: false, recoveryParent };
}

export function branchContainsRound(entries: readonly unknown[], identity: PlanRoundIdentity): boolean {
	replayPlanBranch(entries);
	return entries.some(value => {
		const entry = custom(value);
		if (entry?.customType !== PLAN_ROUND_ADMISSION_ENTRY) return false;
		const admission = decodePlanRoundAdmission(entry.data);
		return admission.planId === identity.planId && admission.revision === identity.revision && admission.round === identity.round;
	});
}

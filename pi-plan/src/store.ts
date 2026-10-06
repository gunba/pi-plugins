import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_PLAN_ROUNDS, PLAN_CHANGE_ENTRY, PLAN_IMPORT_ENTRY, PLAN_ROUND_ADMISSION_ENTRY } from "./constants.ts";
import { applyPlanChange, clonePlanFoldState, decodePlanChange, emptyPlanFoldState, planView,
	planBlock, planClear, planComplete, planCreate, planEdit, planPause, planResume,
	type CreatePlanRequest, type EditPlanRequest, type PlanActivation, type PlanBlockReason,
	type PlanRef, type PlanRoundIdentity, type PlanView, type PlannedPlanChange } from "./domain.ts";
import { applyPlanRoundAdmission, createPlanRoundAdmission, planImport, replayPlanBranch } from "./replay.ts";

export class PlanStateError extends Error {
	constructor(message: string) { super(message); this.name = "PlanStateError"; }
}
interface PlanStoreOptions { defaultMaxRounds?: number; now?: () => number; newId?: () => string }

/** One selected-branch projection and one writer, using native custom entries. */
export class PlanStore {
	private state = emptyPlanFoldState();
	private activation: PlanActivation = "disarmed";
	private corruption?: string;
	private recoveryParent?: string;
	private readonly defaultMaxRounds: number;
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;
	constructor(pi: Pick<ExtensionAPI, "appendEntry">, options: PlanStoreOptions = {}) {
		this.pi = pi;
		this.defaultMaxRounds = options.defaultMaxRounds ?? DEFAULT_MAX_PLAN_ROUNDS;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? (() => `plan-${randomUUID()}`);
	}
	get corruptionReason() { return this.corruption; }
	get currentActivation() { return this.activation; }
	restore(entries: readonly unknown[]): void { this.disarm(); this.load(entries, false); }
	reconcile(entries: readonly unknown[]): void { this.load(entries, true); }
	disarm(): void { this.activation = "disarmed"; }
	private load(entries: readonly unknown[], preserveActivation: boolean): void {
		try {
			const { state, needsImport, recoveryParent } = replayPlanBranch(entries);
			const preserve = preserveActivation && this.corruption === undefined && !needsImport
				&& this.recoveryParent === recoveryParent && isDeepStrictEqual(this.state, state);
			if (needsImport) this.pi.appendEntry(PLAN_IMPORT_ENTRY, planImport(state));
			this.state = state; this.corruption = undefined; this.recoveryParent = recoveryParent;
			if (!preserve) this.disarm();
		} catch (error) {
			this.state = emptyPlanFoldState(); this.disarm();
			this.corruption = error instanceof Error ? error.message : String(error);
		}
	}
	get(): PlanView | undefined { this.assertHealthy(); return planView(this.state, this.activation); }
	create(request: CreatePlanRequest): PlanView {
		this.assertHealthy();
		return this.commit(planCreate(this.state, request, this.newId(), this.now(), this.defaultMaxRounds));
	}
	edit(ref: PlanRef, request: EditPlanRequest): PlanView {
		this.assertHealthy(); return this.commit(planEdit(this.state, ref, request, this.now(), this.activation));
	}
	pause(ref: PlanRef): PlanView { this.assertHealthy(); return this.commit(planPause(this.state, ref, this.now())); }
	resume(ref: PlanRef): PlanView { this.assertHealthy(); return this.commit(planResume(this.state, ref, this.now(), this.activation)); }
	complete(ref: PlanRef): PlanView { this.assertHealthy(); return this.commit(planComplete(this.state, ref, this.now())); }
	block(ref: PlanRef, reason: PlanBlockReason): PlanView {
		this.assertHealthy(); return this.commit(planBlock(this.state, ref, reason, this.now()));
	}
	clear(ref: PlanRef): PlanRef {
		this.assertHealthy();
		const planned = planClear(this.state, ref, this.now());
		this.commitChange(planned);
		if (planned.change.operation !== "clear") throw new Error("expected a plan tombstone");
		return { ...planned.change.cleared };
	}
	admitRound(identity: PlanRoundIdentity, content: string): PlanView {
		this.assertHealthy();
		if (this.activation !== "armed") throw new PlanStateError("plan continuation is disarmed");
		const admission = createPlanRoundAdmission(identity, content), next = clonePlanFoldState(this.state);
		applyPlanRoundAdmission(next, admission);
		this.pi.appendEntry(PLAN_ROUND_ADMISSION_ENTRY, structuredClone(admission));
		this.state = next;
		return this.get()!;
	}
	private assertHealthy(): void {
		if (this.corruption !== undefined) throw new PlanStateError(`plan state is unavailable: ${this.corruption}`);
	}
	private commit(planned: PlannedPlanChange): PlanView {
		this.commitChange(planned);
		const view = this.get();
		if (!view) throw new Error("plan mutation unexpectedly cleared the plan");
		return view;
	}
	private commitChange(planned: PlannedPlanChange): void {
		// Reject a bad transition before it reaches native history.
		const change = decodePlanChange(planned.change), next = clonePlanFoldState(this.state);
		applyPlanChange(next, change);
		this.pi.appendEntry(PLAN_CHANGE_ENTRY, structuredClone(change));
		this.state = next; this.activation = planned.activation;
	}
}

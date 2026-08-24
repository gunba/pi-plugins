import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_GOAL_ROUNDS,
	GOAL_CHANGE_ENTRY,
	GOAL_ROUND_ADMISSION_ENTRY,
} from "./constants.ts";
import {
	applyGoalChange,
	cloneGoalFoldState,
	emptyGoalFoldState,
	goalView,
	planBlock,
	planClear,
	planComplete,
	planCreate,
	planEdit,
	planPause,
	planResume,
	type CreateGoalRequest,
	type EditGoalRequest,
	type GoalActivation,
	type GoalBlockReason,
	type GoalChange,
	type GoalFoldState,
	type GoalRef,
	type GoalRoundIdentity,
	type GoalView,
	type PlannedGoalChange,
} from "./domain.ts";
import {
	applyGoalRoundAdmission,
	createGoalRoundAdmission,
	replayGoalBranch,
} from "./replay.ts";

export class GoalCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalCorruptionError";
	}
}

interface GoalStoreOptions {
	defaultMaxGoalRounds?: number;
	now?: () => number;
	newId?: () => string;
}

function sameDurableGoal(left: GoalFoldState, right: GoalFoldState): boolean {
	const a = left.goal;
	const b = right.goal;
	if (a === undefined || b === undefined) {
		return a === b
			&& left.roundsStarted === right.roundsStarted
			&& left.createdAt === right.createdAt
			&& left.updatedAt === right.updatedAt;
	}
	const sameBlocker = a.phase === "blocked" && b.phase === "blocked"
		? a.blockedReason.code === b.blockedReason.code && a.blockedReason.message === b.blockedReason.message
		: a.phase !== "blocked" && b.phase !== "blocked";
	return a.id === b.id
		&& a.revision === b.revision
		&& a.objective === b.objective
		&& a.phase === b.phase
		&& a.maxGoalRounds === b.maxGoalRounds
		&& sameBlocker
		&& left.roundsStarted === right.roundsStarted
		&& left.createdAt === right.createdAt
		&& left.updatedAt === right.updatedAt;
}

export class GoalStore {
	private state = emptyGoalFoldState();
	private activation: GoalActivation = "disarmed";
	private corruption: string | undefined;
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;
	private readonly defaultMaxGoalRounds: number;
	private readonly now: () => number;
	private readonly newId: () => string;

	constructor(pi: Pick<ExtensionAPI, "appendEntry">, options: GoalStoreOptions = {}) {
		this.pi = pi;
		this.defaultMaxGoalRounds = options.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? (() => `goal-${randomUUID()}`);
	}

	get corruptionReason(): string | undefined {
		return this.corruption;
	}

	get currentActivation(): GoalActivation {
		return this.activation;
	}

	restore(entries: readonly unknown[]): void {
		try {
			this.state = replayGoalBranch(entries);
			this.corruption = undefined;
		} catch (error) {
			this.state = emptyGoalFoldState();
			this.corruption = error instanceof Error ? error.message : String(error);
		}
		this.activation = "disarmed";
	}

	reconcile(entries: readonly unknown[]): void {
		try {
			const next = replayGoalBranch(entries);
			const preserve = this.corruption === undefined && sameDurableGoal(this.state, next);
			this.state = next;
			this.corruption = undefined;
			if (!preserve) this.activation = "disarmed";
		} catch (error) {
			this.state = emptyGoalFoldState();
			this.activation = "disarmed";
			this.corruption = error instanceof Error ? error.message : String(error);
		}
	}

	disarm(): void {
		this.activation = "disarmed";
	}

	get(): GoalView | undefined {
		this.assertHealthy();
		return goalView(this.state, this.activation);
	}

	create(request: CreateGoalRequest): GoalView {
		this.assertHealthy();
		return this.commit(planCreate(
			this.state,
			request,
			this.newId(),
			this.now(),
			this.defaultMaxGoalRounds,
		));
	}

	edit(ref: GoalRef, request: EditGoalRequest): GoalView {
		this.assertHealthy();
		return this.commit(planEdit(this.state, ref, request, this.now(), this.activation));
	}

	pause(ref: GoalRef): GoalView {
		this.assertHealthy();
		return this.commit(planPause(this.state, ref, this.now()));
	}

	resume(ref: GoalRef): GoalView {
		this.assertHealthy();
		return this.commit(planResume(this.state, ref, this.now(), this.activation));
	}

	complete(ref: GoalRef): GoalView {
		this.assertHealthy();
		return this.commit(planComplete(this.state, ref, this.now()));
	}

	block(ref: GoalRef, reason: GoalBlockReason): GoalView {
		this.assertHealthy();
		return this.commit(planBlock(this.state, ref, reason, this.now()));
	}

	admitRound(identity: GoalRoundIdentity, content: string): GoalView {
		this.assertHealthy();
		const admission = createGoalRoundAdmission(identity, content);
		const next = cloneGoalFoldState(this.state);
		applyGoalRoundAdmission(next, admission);
		this.pi.appendEntry(GOAL_ROUND_ADMISSION_ENTRY, admission);
		this.state = next;
		const view = goalView(this.state, this.activation);
		if (view === undefined) throw new Error("goal round admission unexpectedly cleared the goal");
		return view;
	}

	clear(ref: GoalRef): GoalRef {
		this.assertHealthy();
		const planned = planClear(this.state, ref, this.now());
		this.commitChange(planned);
		return planned.change.operation === "clear"
			? { ...planned.change.cleared }
			: ref;
	}

	private assertHealthy(): void {
		if (this.corruption !== undefined) {
			throw new GoalCorruptionError(`goal history is corrupt: ${this.corruption}`);
		}
	}

	private commit(planned: PlannedGoalChange): GoalView {
		this.commitChange(planned);
		const view = goalView(this.state, this.activation);
		if (view === undefined) throw new Error("goal snapshot commit unexpectedly cleared the goal");
		return view;
	}

	private commitChange(planned: PlannedGoalChange): void {
		const change: GoalChange = structuredClone(planned.change);
		this.pi.appendEntry(GOAL_CHANGE_ENTRY, change);
		try {
			applyGoalChange(this.state, change);
			this.activation = planned.activation;
		} catch (error) {
			this.state = emptyGoalFoldState();
			this.activation = "disarmed";
			this.corruption = error instanceof Error ? error.message : String(error);
			throw new GoalCorruptionError(`newly appended goal change failed replay: ${this.corruption}`);
		}
	}
}

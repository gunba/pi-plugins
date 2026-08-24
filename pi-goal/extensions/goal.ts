import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	DEFAULT_BLOCKED_AFTER_ROUNDS,
	GOAL_COMMAND_ENTRY,
	GOAL_COMMAND_VERSION,
	GOAL_ROUND_MESSAGE,
	GOAL_ROUND_VERSION,
} from "../src/constants.ts";
import {
	executeGoalCommand,
	type GoalCommandOperations,
	type GoalCommandResult,
} from "../src/command.ts";
import type {
	GoalRef,
	GoalRoundIdentity,
	GoalView,
} from "../src/domain.ts";
import {
	renderGoalGuidance,
	renderGoalRoundPrompt,
	renderGoalWrapup,
} from "../src/prompt.ts";
import {
	branchContainsRound,
	decodeGoalRoundDetails,
} from "../src/replay.ts";
import { GoalCorruptionError, GoalStore } from "../src/store.ts";
import {
	clearGoalUi,
	renderGoalCommandEntry,
	renderGoalRoundMessage,
	updateGoalUi,
	type GoalCommandEntryData,
} from "../src/ui.ts";

const CREATE_DESCRIPTION =
	"Create one persisted same-session completion goal when the current direct human request is a long-running objective that should continue across autonomous goal rounds. You may infer that intent without requiring the user to say create a goal. Do not use this for trivial single-turn work. Execution rejects non-human and subagent authority.";

const GET_DESCRIPTION =
	"Read the current same-session goal, including its exact id/revision, objective, phase, completed continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. Call this before updating a goal.";

const UPDATE_DESCRIPTION =
	"Update the exact current goal revision. edit, pause, and resume require a direct top-level human request. During an automatic continuation of the current goal, complete and blocked are also allowed. blocked is rejected before the configured minimum round count; the model remains responsible for judging that the same condition persisted across those rounds and must explain it in blocked_reason.";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const createSchema = Type.Object({
	objective: Type.String({ description: "The concrete completion objective inferred from the direct human request." }),
	max_goal_rounds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: MAX_SAFE_INTEGER,
		description: "Optional positive safe-integer limit on automatic continuation rounds.",
	})),
}, { additionalProperties: false });

const updateSchema = Type.Object({
	goal_id: Type.String({ description: "Exact id returned by get_goal." }),
	revision: Type.Integer({
		minimum: 1,
		maximum: MAX_SAFE_INTEGER,
		description: "Exact positive revision returned by get_goal.",
	}),
	action: StringEnum(["edit", "pause", "resume", "complete", "blocked"] as const),
	objective: Type.Optional(Type.String({ description: "Replacement objective; valid only with action edit." })),
	max_goal_rounds: Type.Optional(Type.Integer({
		minimum: 0,
		maximum: MAX_SAFE_INTEGER,
		description: "Replacement cap; valid only with action edit. Zero is an ignored schema filler.",
	})),
	blocked_reason: Type.Optional(Type.String({
		description: "Concrete blocking condition; required only with action blocked.",
	})),
}, { additionalProperties: false });

type CreateParams = Static<typeof createSchema>;
type UpdateParams = Static<typeof updateSchema>;
type UpdateAction = UpdateParams["action"];

type GoalToolValue =
	| { goal: null }
	| {
		goal: {
			id: string;
			revision: number;
			objective: string;
			phase: GoalView["phase"];
			roundsStarted: number;
			maxGoalRounds: number;
			blockedReason?: { code: string; message: string };
		};
		activation: GoalView["activation"];
	};

interface GoalAttempt extends GoalRoundIdentity {
	content: string;
	admitted: boolean;
}

interface PendingHumanInput {
	streamingBehavior?: "steer" | "followUp";
}

type GoalAuthority =
	| { kind: "none" }
	| { kind: "direct-human" }
	| ({ kind: "goal-round" } & GoalRoundIdentity);

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";

class GoalToolPolicyError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(`${code}: ${message}`);
		this.name = "GoalToolPolicyError";
		this.code = code;
	}
}

function ref(goal: GoalView): GoalRef {
	return { id: goal.id, revision: goal.revision };
}

function goalValue(goal: GoalView | undefined): GoalToolValue {
	if (goal === undefined) return { goal: null };
	return {
		goal: {
			id: goal.id,
			revision: goal.revision,
			objective: goal.objective,
			phase: goal.phase,
			roundsStarted: goal.roundsStarted,
			maxGoalRounds: goal.maxGoalRounds,
			...(goal.phase === "blocked"
				? { blockedReason: { ...goal.blockedReason } }
				: {}),
		},
		activation: goal.activation,
	};
}

function toolResult(value: GoalToolValue): AgentToolResult<GoalToolValue> {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: value,
	};
}

function hasText(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFingerprint(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function hasRoundCap(value: number | undefined): value is number {
	return value !== undefined && value !== 0;
}

function updateTitle(action: UpdateAction): string {
	if (action === "blocked") return "Mark goal";
	return `${action.charAt(0).toUpperCase()}${action.slice(1)} goal`;
}

function updateRawInput(params: UpdateParams): string | number {
	if (hasText(params.blocked_reason)) return params.blocked_reason;
	if (hasText(params.objective)) return params.objective;
	if (hasRoundCap(params.max_goal_rounds)) return params.max_goal_rounds;
	return params.goal_id;
}

function renderToolCall(title: string, raw: unknown, theme: ExtensionContext["ui"]["theme"]): Text {
	const suffix = raw === undefined ? "" : ` ${theme.fg("dim", String(raw))}`;
	return new Text(theme.fg("toolTitle", theme.bold(title)) + suffix, 0, 0);
}

function renderToolResult(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	isPartial: boolean,
	theme: ExtensionContext["ui"]["theme"],
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Updating goal…"), 0, 0);
	const value = result.details as GoalToolValue | undefined;
	if (value === undefined) {
		const text = result.content.find((block) => block.type === "text")?.text ?? "Goal operation failed";
		return new Text(theme.fg("error", expanded ? text : text.split("\n")[0] ?? text), 0, 0);
	}
	if (value.goal === null) return new Text(theme.fg("muted", "No current goal"), 0, 0);
	const goal = value.goal;
	const compact = `${goal.phase} · ${goal.roundsStarted}/${goal.maxGoalRounds} · r${goal.revision}`;
	if (!expanded) return new Text(theme.fg(goal.phase === "complete" ? "success" : "toolOutput", compact), 0, 0);
	const lines = [
		compact,
		`Objective: ${goal.objective}`,
		`ID: ${goal.id}`,
		`Activation: ${value.activation}`,
	];
	if (goal.blockedReason !== undefined) {
		lines.push(`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`);
	}
	return new Text(theme.fg("toolOutput", lines.join("\n")), 0, 0);
}

function lastAssistantStopReason(messages: readonly unknown[]): AssistantStopReason | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = messages[index];
		if (typeof candidate !== "object" || candidate === null) continue;
		const message = candidate as { role?: unknown; stopReason?: unknown };
		if (message.role !== "assistant") continue;
		return typeof message.stopReason === "string"
			? message.stopReason as AssistantStopReason
			: undefined;
	}
	return undefined;
}

class GoalController {
	private readonly pi: ExtensionAPI;
	private readonly store: GoalStore;
	private readonly topLevel: boolean;
	private authority: GoalAuthority = { kind: "none" };
	private pendingHumanInputs: PendingHumanInput[] = [];
	private readonly seenContextMessages = new Map<string, number>();
	private attempt: GoalAttempt | undefined;
	private pendingWrapup: string | undefined;
	private lastStopReason: AssistantStopReason | undefined;
	private stopping = true;
	private driveRequested = false;
	private driving = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.store = new GoalStore(pi);
		this.topLevel = !process.env.PI_SUBAGENT_TASK_PATH;
	}

	register(): void {
		this.registerPresentation();
		this.registerCommand();
		this.registerTools();
		this.registerEvents();
	}

	private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private refresh(ctx: ExtensionContext): void {
		this.store.reconcile(ctx.sessionManager.getBranch());
	}

	private resetContextTracking(entries: readonly unknown[]): void {
		this.seenContextMessages.clear();
		const messages: unknown[] = [];
		for (const candidate of entries) {
			if (!isRecord(candidate)) continue;
			if (candidate.type === "message") messages.push(candidate.message);
			if (candidate.type === "compaction" && Array.isArray(candidate.retainedTail)) {
				messages.push(...candidate.retainedTail);
			}
		}
		this.rememberContextMessages(messages);
	}

	private rememberContextMessages(messages: readonly unknown[]): unknown[] {
		const occurrences = new Map<string, number>();
		const unseen: unknown[] = [];
		for (const message of messages) {
			const key = messageFingerprint(message);
			const occurrence = (occurrences.get(key) ?? 0) + 1;
			occurrences.set(key, occurrence);
			if (occurrence > (this.seenContextMessages.get(key) ?? 0)) unseen.push(message);
		}
		for (const [key, count] of occurrences) {
			this.seenContextMessages.set(key, Math.max(count, this.seenContextMessages.get(key) ?? 0));
		}
		return unseen;
	}

	private isAttemptMessage(value: unknown): boolean {
		const attempt = this.attempt;
		if (
			attempt === undefined ||
			!isRecord(value) ||
			value.role !== "custom" ||
			value.customType !== GOAL_ROUND_MESSAGE ||
			value.content !== attempt.content
		) return false;
		try {
			const details = decodeGoalRoundDetails(value.details);
			return details.goalId === attempt.goalId
				&& details.revision === attempt.revision
				&& details.round === attempt.round;
		} catch {
			return false;
		}
	}

	private admitAuthorityFromContext(messages: readonly unknown[]): void {
		const ingress = this.rememberContextMessages(messages).filter((message) =>
			isRecord(message) && (message.role === "user" || message.role === "custom"));
		if (ingress.length === 0) return;

		let directHuman = false;
		for (const message of ingress) {
			if (!isRecord(message) || message.role !== "user" || this.pendingHumanInputs.length === 0)
				continue;
			this.pendingHumanInputs.shift();
			directHuman = true;
		}
		if (directHuman) {
			this.authority = { kind: "direct-human" };
			return;
		}

		const attempt = this.attempt;
		if (attempt !== undefined && ingress.some((message) => this.isAttemptMessage(message))) {
			this.authority = {
				kind: "goal-round",
				goalId: attempt.goalId,
				revision: attempt.revision,
				round: attempt.round,
			};
			return;
		}
		this.authority = { kind: "none" };
	}

	private currentForUi(): GoalView | undefined {
		try {
			return this.store.get();
		} catch (error) {
			if (error instanceof GoalCorruptionError) return undefined;
			throw error;
		}
	}

	private refreshUi(ctx: ExtensionContext): void {
		updateGoalUi(ctx, this.currentForUi(), this.store.corruptionReason);
	}

	private requireDirectHuman(): void {
		if (this.topLevel && this.authority.kind === "direct-human") return;
		throw new GoalToolPolicyError(
			"this goal operation requires a direct human turn on a top-level agent",
			"GOAL_TOOL_AUTHORITY_REQUIRED",
		);
	}

	private terminalAuthority(goal: GoalView): "direct-human" | "goal-round" {
		if (this.topLevel && this.authority.kind === "direct-human") return "direct-human";
		const attempt = this.attempt;
		if (
			this.topLevel &&
			this.authority.kind === "goal-round" &&
			attempt !== undefined &&
			attempt.admitted &&
			this.authority.goalId === goal.id &&
			this.authority.revision === goal.revision &&
			this.authority.round === goal.roundsStarted &&
			attempt.goalId === goal.id &&
			attempt.revision === goal.revision &&
			attempt.round === goal.roundsStarted
		) return "goal-round";
		throw new GoalToolPolicyError(
			"complete and blocked require a direct human turn or the current goal round",
			"GOAL_TOOL_AUTHORITY_REQUIRED",
		);
	}

	private exactRef(goalId: string, revision: number): GoalRef {
		if (goalId.length === 0 || goalId !== goalId.trim() || !Number.isSafeInteger(revision) || revision < 1) {
			throw new GoalToolPolicyError(
				"goal_id must be non-empty and revision must be a positive safe integer",
				"GOAL_TOOL_INVALID_UPDATE",
			);
		}
		return { id: goalId, revision };
	}

	private operations(): GoalCommandOperations {
		return {
			get: () => this.store.get(),
			create: (request) => this.store.create(request),
			edit: (goalRef, request) => this.store.edit(goalRef, request),
			pause: (goalRef) => this.store.pause(goalRef),
			resume: (goalRef) => this.store.resume(goalRef),
			clear: (goalRef) => this.store.clear(goalRef),
		};
	}

	private registerPresentation(): void {
		this.pi.registerEntryRenderer<GoalCommandEntryData>(GOAL_COMMAND_ENTRY, (entry, _options, theme) =>
			renderGoalCommandEntry(entry.data, theme));
		this.pi.registerMessageRenderer(GOAL_ROUND_MESSAGE, (message, options, theme) => {
			try {
				const details = decodeGoalRoundDetails(message.details);
				return renderGoalRoundMessage(message.content, details, options.expanded, theme, options.outputPad);
			} catch {
				return undefined;
			}
		});
	}

	private registerCommand(): void {
		this.pi.registerCommand("goal", {
			description: "set or view the goal for a long-running task",
			handler: async (args, ctx) => {
				await this.serialized(() => {
					this.refresh(ctx);
					let result: GoalCommandResult;
					try {
						result = executeGoalCommand(args, this.operations());
					} catch (error) {
						if (!(error instanceof GoalCorruptionError)) throw error;
						result = {
							kind: "error",
							text: `Goal state is unavailable because its branch history is corrupt: ${error.message}`,
						};
					}
					const input = args.length === 0 ? "/goal" : `/goal ${args}`;
					this.pi.appendEntry(GOAL_COMMAND_ENTRY, {
						version: GOAL_COMMAND_VERSION,
						input,
						result,
					} satisfies GoalCommandEntryData);
					this.refreshUi(ctx);
					this.requestDrive(ctx);
				});
			},
		});
	}

	private registerTools(): void {
		const guidance = renderGoalGuidance(DEFAULT_BLOCKED_AFTER_ROUNDS);
		this.pi.registerTool({
			name: "get_goal",
			label: "Get Goal",
			description: GET_DESCRIPTION,
			promptSnippet: "Read the exact current same-session goal before changing it",
			promptGuidelines: [guidance],
			parameters: Type.Object({}, { additionalProperties: false }),
			executionMode: "sequential",
			execute: async (_id, _params, _signal, _onUpdate, ctx) => this.serialized(() => {
				this.refresh(ctx);
				return toolResult(goalValue(this.store.get()));
			}),
			renderCall: (_args, theme) => renderToolCall("Read current goal", undefined, theme),
			renderResult: (result, options, theme) =>
				renderToolResult(result, options.expanded, options.isPartial, theme),
		});

		this.pi.registerTool({
			name: "create_goal",
			label: "Create Goal",
			description: CREATE_DESCRIPTION,
			promptSnippet: "Create one long-running same-session completion goal",
			parameters: createSchema,
			executionMode: "sequential",
			execute: async (_id, params: CreateParams, _signal, _onUpdate, ctx) => this.serialized(() => {
				this.refresh(ctx);
				this.requireDirectHuman();
				const goal = this.store.create({
					objective: params.objective,
					...(params.max_goal_rounds === undefined ? {} : { maxGoalRounds: params.max_goal_rounds }),
				});
				this.refreshUi(ctx);
				this.requestDrive(ctx);
				return toolResult(goalValue(goal));
			}),
			renderCall: (args, theme) => renderToolCall("Create goal", args.objective, theme),
			renderResult: (result, options, theme) =>
				renderToolResult(result, options.expanded, options.isPartial, theme),
		});

		this.pi.registerTool({
			name: "update_goal",
			label: "Update Goal",
			description: UPDATE_DESCRIPTION,
			promptSnippet: "Edit, pause, resume, complete, or block the exact current goal revision",
			parameters: updateSchema,
			executionMode: "sequential",
			execute: async (_id, params: UpdateParams, _signal, _onUpdate, ctx) => this.serialized(() => {
				this.refresh(ctx);
				const goalRef = this.exactRef(params.goal_id, params.revision);
				const replacements = {
					...(hasText(params.objective) ? { objective: params.objective } : {}),
					...(hasRoundCap(params.max_goal_rounds) ? { maxGoalRounds: params.max_goal_rounds } : {}),
				};
				let goal: GoalView;
				if (params.action === "edit") {
					this.requireDirectHuman();
					if (hasText(params.blocked_reason)) {
						throw new GoalToolPolicyError(
							"blocked_reason is valid only with action blocked",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					goal = this.store.edit(goalRef, replacements);
				} else if (params.action === "pause" || params.action === "resume") {
					this.requireDirectHuman();
					if (hasText(params.objective) || hasRoundCap(params.max_goal_rounds) || hasText(params.blocked_reason)) {
						throw new GoalToolPolicyError(
							"objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					goal = params.action === "pause"
						? this.store.pause(goalRef)
						: this.store.resume(goalRef);
				} else {
					const current = this.store.get();
					if (current === undefined) {
						throw new GoalToolPolicyError("no current goal", "GOAL_NOT_FOUND");
					}
					const authority = this.terminalAuthority(current);
					if (hasText(params.objective) || hasRoundCap(params.max_goal_rounds)) {
						throw new GoalToolPolicyError(
							"objective and max_goal_rounds are valid only with action edit",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					if (params.action === "complete" && hasText(params.blocked_reason)) {
						throw new GoalToolPolicyError(
							"blocked_reason is valid only with action blocked",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					if (params.action === "blocked" && (params.blocked_reason === undefined || params.blocked_reason.trim().length === 0)) {
						throw new GoalToolPolicyError(
							"blocked_reason is required with action blocked",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					if (
						params.action === "blocked" &&
						authority === "goal-round" &&
						current.roundsStarted < DEFAULT_BLOCKED_AFTER_ROUNDS
					) {
						throw new GoalToolPolicyError(
							`blocked requires at least ${DEFAULT_BLOCKED_AFTER_ROUNDS} consecutive goal rounds; current round is ${current.roundsStarted}`,
							"GOAL_TOOL_BLOCK_THRESHOLD",
						);
					}
					goal = params.action === "complete"
						? this.store.complete(goalRef)
						: this.store.block(goalRef, {
							code: "model-reported",
							message: params.blocked_reason as string,
						});
					if (authority === "goal-round") {
						this.pendingWrapup = renderGoalWrapup(
							goal,
							params.action === "blocked" ? params.blocked_reason as string : undefined,
						);
					}
				}
				this.refreshUi(ctx);
				this.requestDrive(ctx);
				return toolResult(goalValue(goal));
			}),
			renderCall: (args, theme) => renderToolCall(updateTitle(args.action), updateRawInput(args), theme),
			renderResult: (result, options, theme) =>
				renderToolResult(result, options.expanded, options.isPartial, theme),
		});
	}

	private registerEvents(): void {
		this.pi.on("session_start", (_event, ctx) => {
			this.stopping = false;
			this.attempt = undefined;
			this.authority = { kind: "none" };
			this.pendingHumanInputs = [];
			this.pendingWrapup = undefined;
			this.lastStopReason = undefined;
			const branch = ctx.sessionManager.getBranch();
			this.resetContextTracking(branch);
			this.store.restore(branch);
			this.refreshUi(ctx);
		});

		this.pi.on("session_tree", (_event, ctx) => {
			this.attempt = undefined;
			this.authority = { kind: "none" };
			this.pendingHumanInputs = [];
			this.pendingWrapup = undefined;
			const branch = ctx.sessionManager.getBranch();
			this.resetContextTracking(branch);
			this.store.restore(branch);
			this.refreshUi(ctx);
		});

		this.pi.on("session_shutdown", (_event, ctx) => {
			this.stopping = true;
			this.driveRequested = false;
			this.attempt = undefined;
			this.authority = { kind: "none" };
			this.pendingHumanInputs = [];
			this.seenContextMessages.clear();
			this.pendingWrapup = undefined;
			this.lastStopReason = undefined;
			this.store.disarm();
			clearGoalUi(ctx);
		});

		this.pi.on("input", (event) => {
			if (event.source === "extension") {
				this.pendingHumanInputs = this.pendingHumanInputs.filter((pending) =>
					pending.streamingBehavior !== undefined);
				return;
			}
			this.pendingHumanInputs = this.pendingHumanInputs.filter((pending) =>
				pending.streamingBehavior !== undefined);
			this.pendingHumanInputs.push({
				...(event.streamingBehavior === undefined
					? {}
					: { streamingBehavior: event.streamingBehavior }),
			});
		});

		this.pi.on("message_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "custom" || message.customType !== GOAL_ROUND_MESSAGE) return;
			await this.serialized(() => {
				try {
					const details = decodeGoalRoundDetails(message.details);
					const attempt = this.attempt;
					if (
						attempt === undefined ||
						details.goalId !== attempt.goalId ||
						details.revision !== attempt.revision ||
						details.round !== attempt.round ||
						message.content !== attempt.content
					) return;
					const branch = ctx.sessionManager.getBranch();
					this.store.reconcile(branch);
					if (!branchContainsRound(branch, attempt)) {
						this.store.admitRound(attempt, attempt.content);
					}
					attempt.admitted = true;
					this.refreshUi(ctx);
				} catch {
					this.store.disarm();
					this.refreshUi(ctx);
				}
			});
		});

		this.pi.on("context", (event) => {
			this.admitAuthorityFromContext(event.messages);
			if (this.pendingWrapup === undefined) return;
			return {
				messages: [
					...event.messages,
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: this.pendingWrapup }],
						timestamp: Date.now(),
					},
				],
			};
		});

		this.pi.on("agent_end", (event) => {
			this.lastStopReason = lastAssistantStopReason(event.messages);
		});

		this.pi.on("agent_settled", (_event, ctx) => {
			this.handleSettled(ctx);
		});
	}

	private handleSettled(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		this.store.reconcile(branch);
		const attempt = this.attempt;
		const goal = this.currentForUi();
		if (attempt !== undefined) {
			try {
				attempt.admitted = attempt.admitted || branchContainsRound(branch, attempt);
			} catch {
				this.store.disarm();
			}
			if (!attempt.admitted) {
				this.store.disarm();
			} else if (
				goal !== undefined &&
				goal.id === attempt.goalId &&
				goal.revision === attempt.revision &&
				goal.phase === "active" &&
				goal.activation === "armed"
			) {
				if (this.lastStopReason === "aborted") {
					try {
						this.store.pause(ref(goal));
					} catch {
						this.store.disarm();
					}
				} else if (this.lastStopReason === "error" || this.lastStopReason === "length") {
					this.store.disarm();
				}
			}
		} else if (
			goal?.phase === "active" &&
			goal.activation === "armed" &&
			(this.lastStopReason === "aborted" || this.lastStopReason === "error" || this.lastStopReason === "length")
		) {
			this.store.disarm();
		}
		this.attempt = undefined;
		this.authority = { kind: "none" };
		this.pendingHumanInputs = [];
		this.pendingWrapup = undefined;
		this.lastStopReason = undefined;
		this.refreshUi(ctx);
		this.requestDrive(ctx);
	}

	private requestDrive(ctx: ExtensionContext): void {
		if (this.stopping || !this.topLevel) return;
		this.driveRequested = true;
		if (this.driving) return;
		this.driving = true;
		try {
			while (this.driveRequested && !this.stopping) {
				this.driveRequested = false;
				this.drive(ctx);
			}
		} finally {
			this.driving = false;
		}
	}

	private drive(ctx: ExtensionContext): void {
		if (!ctx.isIdle() || ctx.hasPendingMessages() || this.attempt !== undefined) return;
		this.refresh(ctx);
		if (this.store.corruptionReason !== undefined) {
			this.refreshUi(ctx);
			return;
		}
		const goal = this.store.get();
		if (goal === undefined || goal.phase !== "active" || goal.activation !== "armed") return;
		if (goal.roundsStarted >= goal.maxGoalRounds) {
			this.store.block(ref(goal), {
				code: "round-limit",
				message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
			});
			this.refreshUi(ctx);
			return;
		}
		const round = goal.roundsStarted + 1;
		const content = renderGoalRoundPrompt(goal, round);
		const attempt: GoalAttempt = {
			goalId: goal.id,
			revision: goal.revision,
			round,
			content,
			admitted: false,
		};
		this.attempt = attempt;
		this.authority = { kind: "goal-round", goalId: goal.id, revision: goal.revision, round };
		try {
			this.pi.sendMessage({
				customType: GOAL_ROUND_MESSAGE,
				content,
				display: true,
				details: {
					version: GOAL_ROUND_VERSION,
					goalId: goal.id,
					revision: goal.revision,
					round,
				},
			}, { deliverAs: "followUp", triggerTurn: true });
		} catch (error) {
			this.attempt = undefined;
			this.authority = { kind: "none" };
			const latest = this.store.get();
			if (
				latest !== undefined &&
				latest.id === goal.id &&
				latest.revision === goal.revision &&
				latest.phase === "active" &&
				latest.activation === "armed"
			) {
				this.store.block(ref(latest), {
					code: "queue-failed",
					message: `Could not queue goal round ${round}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			this.refreshUi(ctx);
		}
	}
}

export default function goalExtension(pi: ExtensionAPI): void {
	const controller = new GoalController(pi);
	controller.register();
}

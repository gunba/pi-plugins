import { createHash, randomUUID } from "node:crypto";
import { NoticeBatcher } from "./notice-batcher.ts";
import { historicalTaskName, resolveTaskPath, validateTaskName } from "./task-names.ts";
import { FOLLOWUP_MESSAGE, type FollowupInput } from "./followup-delivery.ts";
import type { PresentationScope, UiTranscriptSource } from "../../pi-ui/index.ts";
import { SessionLease, attachOwnership, releaseOwnership } from "../../pi-session-ownership/lease.ts";
import type { ChildPolicySource } from "./child-policies.ts";
import type { ModelCredentials } from "../model-credentials.ts";
import { getWorkCoordinator } from "../../pi-work-coordination/core.ts";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model, type Usage } from "@earendil-works/pi-ai";
import {
	SessionManager,
	buildContextEntries,
	buildSessionProjection,
	type ContextEditEntry,
	type ModelRuntime,
	type SessionEntry,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

export const DESCRIPTOR_ENTRY = "pi-subagents/descriptor-v1";
export const TASK_NAME_ENTRY = "pi-subagents/task-name-v1";
export const NOTICE_ENTRY = "pi-subagents/notice-received-v1";
export const BACKGROUND_USAGE_ENTRY = "pi-subagents/usage-v1";
export const INBOX_ENTRY = "pi-subagents/inbox-v1";
export const DELIVERY_ENTRY = "pi-subagents/delivery-v1";
export const LAUNCH_ENTRY = "pi-subagents/launch-v1";
export const SETTLEMENT_ENTRY = "pi-subagents/settlement-v1";
export const CONTROL_ENTRY = "pi-subagents/control-v1";
export const MAINTENANCE_ENTRY = "pi-subagents/maintenance-v1";
export type SubagentCheckpoint = {
	id: string; phase: "held" | "final" | "released";
	children: { id: string; leaf: string | null; end: string | null; running: boolean; parked: boolean; error?: string }[];
};
export const DESCRIPTOR_VERSION = 2;
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_ACTIVE = 8;
export const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
export const MAX_PARENT_NOTICE_BYTES = 32 * 1024;

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ChildMode = "continuable" | "one-shot";
export type ChildContextMode = "fresh" | "fork";
export type ModelRef = { provider: string; id: string };
export type ModelSelection = { model: ModelRef; thinkingLevel: ThinkingLevel };

export type ChildDescriptor = {
	version: 2;
	projectTrusted: boolean;
	childSessionId: string;
	rootSessionId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	mode: ChildMode;
	context: ChildContextMode;
	provider: "pi-sdk";
	label: string;
	depth: number;
	cwd: string;
	createdAt: number;
	model: ModelRef;
	thinkingLevel: ThinkingLevel;
	toolNames: string[];
	forkBoundaryEntryId?: string;
};

export type RunStopReason =
	| "completed"
	| "aborted"
	| "error"
	| "max-tokens"
	| "refusal";

export type RunOutcome = {
	consumedFollowups?: string[];
	output: string;
	stopReason: RunStopReason;
	errorMessage?: string;
	usage?: Usage & { contextTokens: number };
};

export type Authority = {
	readonly sessionId: string;
	readonly rootSessionId: string;
	readonly depth: number;
	readonly generation: string;
	readonly token: symbol;
};

export type AgentListEntry =
	| {
			kind: "child";
			id: string;
			label: string;
			status: "running" | "idle" | "ready";
			lastOutcome?: RunOutcome["stopReason"];
			errorMessage?: string;
			parent?: string;
			depth?: number;
	  }
	| {
			kind: "diagnostic";
			id: string;
			reason: "corrupt" | "unsupported" | "unavailable";
			parent?: string;
			depth?: number;
	  };

export type RuntimeChildSnapshot = {
	id: string;
	parentId: string;
	label: string;
	depth: number;
	mode: ChildMode;
	context: ChildContextMode;
	state: "running" | "waiting" | "settled" | "error" | "aborted";
	activity?: string;
	canSteer?: boolean;
	canStop?: boolean;
	queued?: number;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
	model: string;
	thinkingLevel: ThinkingLevel;
	sessionFile?: string;
	lastOutput?: string;
	usage?: RunOutcome["usage"];
	activeDurationMs?: number;
	diagnosticReason?: DiagnosticRecord["reason"];
	errorMessage?: string;
};

export type ParentInvocation = {
	authority: Authority;
	sessionManager: Pick<
		SessionManager,
		"buildContextEntries" | "getBranch" | "getSessionFile" | "getSessionId"
	>;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	toolNames: string[];
	toolCallId: string;
	cwd: string;
	projectTrusted: boolean;
};

export type StartRequest = {
	taskName?: string;
	forkTurns?: number;
	description: string;
	prompt: string;
	context: ChildContextMode;
	runInBackground: boolean;
	parent: ParentInvocation;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
};

export type BackgroundStart = {
	kind: "continuable";
	subagentId: string;
	messageId: string;
};

export type ForegroundStart = {
	kind: "foreground";
	runId: string;
	outcome: RunOutcome;
};

export type StartResult = BackgroundStart | ForegroundStart;

export type ParentNotice = {
	/** Absent in historical notices, which were always addressed to the parent. */
	recipientId?: string;
	messageId: string;
	kind: "report" | "settlement";
	childId: string;
	content: string;
	priority?: "routine" | "urgent" | "action-required";
	outputHash?: string;
	workId?: string;
};

export interface RuntimeHost {
	readonly rootSessionId: string;
	readonly rootSessionFile?: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly activeRootLaunchIds: ReadonlySet<string>;
	isProjectTrusted(): boolean;
	getRootStatus?(): "running" | "idle";
	recordRootLaunch(childId: string): void;
	/** Queue a root notice and return true only when that exact notice is already durable in the root branch. */
	deliverRootNotice(notice: ParentNotice): boolean;
	recordBackgroundUsage?(childId: string, messageId: string, usage: Usage): void;
	resolveModel(ref: ModelRef): Model<any> | undefined;
	authorizeModelOverrides?(selection: ModelSelection, signal?: AbortSignal): Promise<void>;
	readonly modelCredentials?: ModelCredentials;
	prepareModelRuntime?(ref: ModelRef, runtime: ModelRuntime, signal: AbortSignal, ownCredentials?: boolean): Promise<void>;
	/** Current root selection is authoritative, including explicit tool revocations. */
	getActiveToolNames?(): string[];
	/** Metadata identifies factories to recreate against the child, not parent execution closures. */
	getToolInfo?(): ToolInfo[];
	getChildPolicySources?(): ChildPolicySource[];
	getFlag?(name: string): boolean | string | undefined;
	createPresentation?(descriptor: ChildDescriptor): PresentationScope;
	isSuspended?(): boolean;
	readMaintenance?(id: string): unknown;
	saveMaintenance?(checkpoint: SubagentCheckpoint): void;
}

export interface ChildDriver {
	subscribeTranscript?(listener: Parameters<UiTranscriptSource["subscribe"]>[0]): () => void;
	readonly sessionFile?: string;
	readonly isRunning: boolean;
	readonly activity?: string;
	/** Refuse maintenance when native admission or opaque queued context cannot be saved safely. */
	checkpointReady?(): void;
	subscribeActivity?(listener: () => void): () => void;
	prompt(message: string): Promise<RunOutcome>;
	enqueueFollowup(input: FollowupInput): void;
	receiveNotice(notice: ParentNotice): void;
	receiveNotices?(notices: ParentNotice[]): void;
	interrupt(): void;
	dispose(): void | Promise<void>;
}

export interface ChildDriverFactory {
	open(input: {
		descriptor: ChildDescriptor;
		taskPath?: string;
		parentTaskPath?: string;
		onFollowupDelivered?(ids: string[]): void;
		sessionManager: SessionManager;
		authority: Authority;
		customTools: ToolDefinition[];
		/** Deliberately child-only capabilities, not inherited root tools. */
		intrinsicToolNames?: string[];
		signal: AbortSignal;
	}): Promise<ChildDriver>;
}

export type ChildToolFactory = (
	runtime: SubagentRuntime,
	authority: Authority,
	mode: ChildMode,
) => ToolDefinition[];

type QueueSource = "initial" | "followup" | "report" | "settlement" | "party" | "maintenance";

type QueueItem = {
	delivery?: "boundary";
	messageId: string;
	content: string;
	source: QueueSource;
	acceptedAt: number;
	started: boolean;
	startedAt?: number;
	cancelled?: boolean;
	resolve?: (outcome: RunOutcome) => void;
	reject?: (error: unknown) => void;
};

type Activation = {
	unsubscribeTranscript?: () => void;
	authority: Authority;
	driver: ChildDriver;
	unsubscribeActivity?: () => void;
	current?: QueueItem;
	interrupted: boolean;
};

type ChildRecord = {
	taskName: string;
	workId?: string;
	disposing?: Promise<unknown | undefined>;
	descriptor: ChildDescriptor;
	manager: SessionManager;
	queue: QueueItem[];
	activation?: Activation;
	opening?: AbortController;
	pump?: Promise<void>;
	parked: boolean;
	lastOutcome?: RunOutcome;
	settlementOutcome?: RunOutcome;
	totalUsage?: RunOutcome["usage"];
	activeDurationMs: number;
	lastError?: string;
	updatedAt: number;
	finishedAt?: number;
	pendingSettlement: boolean;
	maintenanceSettlement?: boolean;
	pendingSettlementNotices: ParentNotice[];
};

type DiagnosticRecord = {
	id: string;
	parentSessionId?: string;
	rootSessionId?: string;
	reason: "corrupt" | "unsupported" | "unavailable";
};

function textOfAssistant(entry: SessionEntry): string {
	if (entry.type !== "message" || entry.message.role !== "assistant") return "";
	return entry.message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function hasToolCall(entry: SessionEntry, toolCallId: string): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some(
			(block) => block.type === "toolCall" && block.id === toolCallId,
		)
	);
}

function isCompletedAssistantEntry(entry: SessionEntry | undefined): boolean {
	return entry?.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.stopReason !== "toolUse" &&
		entry.message.stopReason !== "pending";
}

/**
 * Copy the parent's completed message turns into a new child session.
 * The assistant message containing the current delegation call and its whole
 * in-flight turn are excluded.
 */
export function copyCompletedParentTurns(
	parent: ParentInvocation["sessionManager"],
	target: SessionManager,
	toolCallId: string,
	turnLimit?: number,
): string | undefined {
	if (turnLimit !== undefined && (!Number.isSafeInteger(turnLimit) || turnLimit < 1)) throw Error("fork_turns must be a positive integer");
	let contextEntries = parent.buildContextEntries();
	const currentEdits = contextEntries.filter((entry): entry is ContextEditEntry => entry.type === "context_edit");
	let currentCall = contextEntries.findIndex((entry) => hasToolCall(entry, toolCallId));
	if (currentCall < 0) currentCall = contextEntries.length;
	let boundary = -1;
	for (let index = currentCall - 1; index >= 0; index--) {
		const entry = contextEntries[index];
		if (isCompletedAssistantEntry(entry)) {
			boundary = index;
			break;
		}
	}
	if (boundary < 0) {
		const history = parent.getBranch();
		let call = history.findIndex((entry) => hasToolCall(entry, toolCallId));
		if (call < 0) call = history.length;
		let completed = call - 1;
		while (completed >= 0 && !isCompletedAssistantEntry(history[completed])) completed--;
		const inheritedSummary = (entry: SessionEntry) => entry.type === "custom_message"
			&& entry.customType === "pi-subagents/fork-summary-v1";
		let firstCurrent = history.findIndex((entry, index) => index > completed && index < call
			&& (entry.type === "message" || (entry.type === "custom_message" && !inheritedSummary(entry))));
		if (firstCurrent < 0) firstCurrent = call;
		for (let index = currentCall - 1; index >= 0; index--) {
			const entry = contextEntries[index]!;
			if (entry.type !== "compaction" && entry.type !== "branch_summary" && !inheritedSummary(entry)) continue;
			const source = history.findIndex((raw) => raw.id === (entry.type === "compaction" ? entry.firstKeptEntryId : entry.id));
			if (source >= 0 && (entry.type === "compaction" ? source <= firstCurrent : source < firstCurrent)) boundary = index;
			break;
		}
		// A mid-turn summary may contain current work. Rebuild the completed
		// historical branch instead of treating that summary as a safe seed.
		if (boundary < 0 && completed >= 0) {
			contextEntries = buildContextEntries(history, history[completed]!.id);
			boundary = contextEntries.findIndex((entry) => entry.id === history[completed]!.id);
		}
	}
	if (boundary < 0) return undefined;

	const edits = new Map([...contextEntries.filter((entry): entry is ContextEditEntry => entry.type === "context_edit"), ...currentEdits]
		.map(entry => [entry.targetId, entry]));
	const completed = contextEntries.slice(0, boundary + 1);
	// Like Codex's bounded fork, start at an instruction-turn boundary, not
	// an arbitrary message/tool result. Pre-turn compaction context is omitted.
	const starts = completed.flatMap((entry, index) => entry.type === "message" && entry.message.role === "user" || entry.type === "custom_message" && entry.customType === FOLLOWUP_MESSAGE ? [index] : []);
	const first = turnLimit === undefined ? 0 : starts[Math.max(0, starts.length - turnLimit)];
	if (first === undefined) return undefined;
	for (const entry of completed.slice(first)) {
		if (entry.type === "message" || entry.type === "custom_message") {
			const edit = edits.get(entry.id);
			// Project an isolated entry through Pi's public content-edit contract.
			// Source IDs and branch content remain untouched, including late edits to completed turns.
			const projected = buildSessionProjection([{ ...entry, parentId: null }, ...(edit ? [{ ...edit, parentId: entry.id }] : [])]);
			for (const message of projected.messages) {
				if (message.role === "custom") target.appendCustomMessageEntry(message.customType,
					structuredClone(message.content), message.display, structuredClone(message.details));
				else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "bashExecution")
					target.appendMessage(structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0]);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			target.appendCustomMessageEntry(
				"pi-subagents/fork-summary-v1",
				`Parent context summary:\n${entry.summary}`,
				false,
				{
					sourceEntryId: entry.id,
					sourceType: entry.type,
					...(entry.details !== undefined ? { sourceDetails: structuredClone(entry.details) } : {}),
				},
			);
		}
	}
	return contextEntries[boundary]?.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
	value: Record<string, unknown>,
	known: ReadonlySet<string>,
	path: string,
): void {
	const unknown = Object.keys(value).find((key) => !known.has(key));
	if (unknown) throw new Error(`${path} has unknown field ${JSON.stringify(unknown)}`);
}

function requiredString(
	value: Record<string, unknown>,
	key: string,
): string {
	const field = value[key];
	if (typeof field !== "string" || field.length === 0)
		throw new Error(`descriptor ${key} must be a non-empty string`);
	return field;
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
	const levels: ThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	if (!levels.includes(value as ThinkingLevel))
		throw new Error("descriptor thinkingLevel is invalid");
	return value as ThinkingLevel;
}

export function parseDescriptor(value: unknown): ChildDescriptor {
	if (!isRecord(value)) throw new Error("descriptor must be an object");
	assertKnownKeys(
		value,
		new Set([
			"version",
			"projectTrusted",
			"childSessionId",
			"rootSessionId",
			"parentSessionId",
			"parentSessionFile",
			"mode",
			"context",
			"provider",
			"label",
			"depth",
			"cwd",
			"createdAt",
			"model",
			"thinkingLevel",
			"toolNames",
			"forkBoundaryEntryId",
		]),
		"descriptor",
	);
	if (value.version !== DESCRIPTOR_VERSION)
		throw Object.assign(new Error("unsupported descriptor version"), {
			code: "UNSUPPORTED",
		});
	if (typeof value.projectTrusted !== "boolean") throw new Error("descriptor projectTrusted is invalid");
	const mode = value.mode;
	if (mode !== "continuable" && mode !== "one-shot")
		throw new Error("descriptor mode is invalid");
	const context = value.context;
	if (context !== "fresh" && context !== "fork")
		throw new Error("descriptor context is invalid");
	if (value.provider !== "pi-sdk")
		throw new Error("descriptor provider is invalid");
	if (!Number.isSafeInteger(value.depth) || (value.depth as number) < 1)
		throw new Error("descriptor depth is invalid");
	if (!Number.isFinite(value.createdAt))
		throw new Error("descriptor createdAt is invalid");
	if (!isRecord(value.model)) throw new Error("descriptor model is invalid");
	assertKnownKeys(value.model, new Set(["provider", "id"]), "descriptor model");
	if (!Array.isArray(value.toolNames) || value.toolNames.some((name) => typeof name !== "string"))
		throw new Error("descriptor toolNames is invalid");
	const parentSessionFile = value.parentSessionFile;
	const forkBoundaryEntryId = value.forkBoundaryEntryId;
	if (parentSessionFile !== undefined && typeof parentSessionFile !== "string")
		throw new Error("descriptor parentSessionFile is invalid");
	if (forkBoundaryEntryId !== undefined && typeof forkBoundaryEntryId !== "string")
		throw new Error("descriptor forkBoundaryEntryId is invalid");
	return {
		version: DESCRIPTOR_VERSION,
		projectTrusted: value.projectTrusted,
		childSessionId: requiredString(value, "childSessionId"),
		rootSessionId: requiredString(value, "rootSessionId"),
		parentSessionId: requiredString(value, "parentSessionId"),
		...(parentSessionFile ? { parentSessionFile } : {}),
		mode,
		context,
		provider: "pi-sdk",
		label: requiredString(value, "label"),
		depth: value.depth as number,
		cwd: requiredString(value, "cwd"),
		createdAt: value.createdAt as number,
		model: {
			provider: requiredString(value.model, "provider"),
			id: requiredString(value.model, "id"),
		},
		thinkingLevel: parseThinkingLevel(value.thinkingLevel),
		toolNames: [...(value.toolNames as string[])],
		...(forkBoundaryEntryId ? { forkBoundaryEntryId } : {}),
	};
}

function launchIds(manager: Pick<SessionManager, "getBranch" | "getSessionId">): Set<string> {
	const parentId = manager.getSessionId();
	const ids = new Set<string>();
	for (const entry of manager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== LAUNCH_ENTRY || !isRecord(entry.data))
			continue;
		if (entry.data.parentSessionId === parentId && typeof entry.data.childId === "string")
			ids.add(entry.data.childId);
	}
	return ids;
}

function readHeaderFallback(file: string): { id?: string; parentSession?: string } {
	try {
		const first = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
		const parsed = first ? JSON.parse(first) : undefined;
		return isRecord(parsed)
			? {
					...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
					...(typeof parsed.parentSession === "string"
						? { parentSession: parsed.parentSession }
						: {}),
				}
			: {};
	} catch {
		return {};
	}
}

type RecoveredChildState = {
	workId?: string;
	queue: QueueItem[];
	lastOutcome?: RunOutcome;
	settlementOutcome?: RunOutcome;
	totalUsage?: RunOutcome["usage"];
	activeDurationMs: number;
	lastError?: string;
	updatedAt?: number;
	finishedAt?: number;
	parked: boolean;
	needsSettlement: boolean;
	maintenanceSettlement: boolean;
	pendingSettlementNotices: ParentNotice[];
};

function parseUsage(value: unknown): RunOutcome["usage"] | undefined {
	if (!isRecord(value)) return undefined;
	const { input, output, cacheRead, cacheWrite, totalTokens, contextTokens, cost } = value;
	if (![input, output, cacheRead, cacheWrite, totalTokens, contextTokens].every((item) => typeof item === "number" && Number.isFinite(item)) ||
		!isRecord(cost) || ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
	if ([value.reasoning, value.cacheWrite1h].some((item) => item !== undefined && (typeof item !== "number" || !Number.isFinite(item)))) return undefined;
	return value as unknown as RunOutcome["usage"];
}

export function addUsage(
	left: RunOutcome["usage"] | undefined,
	right: RunOutcome["usage"] | undefined,
): RunOutcome["usage"] | undefined {
	if (!left) return right ? { ...right } : undefined;
	if (!right) return { ...left };
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		contextTokens: Math.max(left.contextTokens, right.contextTokens),
		...(left.reasoning !== undefined || right.reasoning !== undefined ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) } : {}),
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) } : {}),
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function mergeSettlementOutcome(
	previous: RunOutcome | undefined,
	current: RunOutcome,
): RunOutcome {
	const usage = addUsage(previous?.usage, current.usage);
	return {
		output: current.output || previous?.output || "",
		stopReason: current.stopReason,
		...(current.errorMessage ? { errorMessage: current.errorMessage } : {}),
		...(usage ? { usage } : {}),
	};
}

function parseParentNotice(value: unknown): ParentNotice | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.messageId !== "string" ||
		(value.kind !== "report" && value.kind !== "settlement") ||
		typeof value.childId !== "string" ||
		typeof value.content !== "string"
	) return undefined;
	return {
		messageId: value.messageId,
		kind: value.kind,
		childId: value.childId,
		content: value.content,
		...(typeof value.recipientId === "string" ? { recipientId: value.recipientId } : {}),
		...(value.priority === "urgent" || value.priority === "action-required" || value.priority === "routine" ? { priority: value.priority } : {}),
		...(typeof value.outputHash === "string" ? { outputHash: value.outputHash } : {}),
		...(typeof value.workId === "string" ? { workId: value.workId } : {}),
	};
}

/** Recover the gap between durable inbox admission and Pi's message append. */
export function undispatchedNotices(entries: readonly SessionEntry[]): ParentNotice[] {
	const received = new Map<string, ParentNotice>();
	const dispatched = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === NOTICE_ENTRY) {
			const notice = parseParentNotice(entry.data);
			if (notice) received.set(notice.messageId, notice);
		} else if (entry.type === "custom_message" && entry.customType === "pi-subagents/notice") {
			// Compacted resident messages retain only their delivery identifier.
			// Dispatch proof does not require the archived content/child/kind.
			if (isRecord(entry.details) && typeof entry.details.messageId === "string") {
				dispatched.add(entry.details.messageId);
			}
			if (isRecord(entry.details) && Array.isArray(entry.details.messageIds)) {
				for (const id of entry.details.messageIds) if (typeof id === "string") dispatched.add(id);
			}
		}
	}
	return [...received.values()].filter((notice) => !dispatched.has(notice.messageId));
}

function recoverChildState(entries: readonly SessionEntry[]): RecoveredChildState {
	const accepted = new Map<string, QueueItem>();
	const consumed = new Set<string>();
	const startedAt = new Map<string, number>();
	const pendingNotices = new Map<string, ParentNotice>();
	let workId: string | undefined;
	let lastOutcome: RunOutcome | undefined;
	let settlementOutcome: RunOutcome | undefined;
	let totalUsage: RunOutcome["usage"] | undefined;
	let activeDurationMs = 0;
	let lastError: string | undefined;
	let updatedAt: number | undefined;
	let finishedAt: number | undefined;
	let parked = false;
	let needsSettlement = false;
	let maintenanceSettlement = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		if (entry.customType === CONTROL_ENTRY && (entry.data.action === "parked" || entry.data.action === "unparked"))
			parked = entry.data.action === "parked";
		if (entry.customType === INBOX_ENTRY && entry.data.action === "accepted") {
			const { messageId, content, source, acceptedAt } = entry.data;
			if (typeof messageId === "string" && typeof content === "string" &&
				(source === "initial" || source === "followup" || source === "report" || source === "settlement" || source === "party" || source === "maintenance") &&
				typeof acceptedAt === "number") {
				accepted.set(messageId, { messageId, content, source, acceptedAt, started: false,
					...(entry.data.delivery === "boundary" ? { delivery: "boundary" } : {}) });
				updatedAt = Math.max(updatedAt ?? 0, acceptedAt);
				if (typeof entry.data.workId === "string") workId = entry.data.workId;
				else workId ??= messageId;
			}
		}
		if (entry.customType === DELIVERY_ENTRY && typeof entry.data.workId === "string") workId = entry.data.workId;
		if (entry.customType === DELIVERY_ENTRY && entry.data.action === "started" &&
			typeof entry.data.messageId === "string" && typeof entry.data.startedAt === "number")
			startedAt.set(entry.data.messageId, entry.data.startedAt);
		if (entry.customType === DELIVERY_ENTRY && typeof entry.data.messageId === "string" &&
			(entry.data.action === "finished" || entry.data.action === "failed")) {
			consumed.add(entry.data.messageId);
			if (Array.isArray(entry.data.consumedFollowups)) for (const id of entry.data.consumedFollowups)
				if (typeof id === "string" && accepted.get(id)?.delivery === "boundary") consumed.add(id);
			const terminalAt = typeof entry.data.finishedAt === "number" ? entry.data.finishedAt : undefined;
			if (terminalAt !== undefined) {
				updatedAt = Math.max(updatedAt ?? 0, terminalAt);
				finishedAt = terminalAt;
				const began = startedAt.get(entry.data.messageId);
				if (began !== undefined) activeDurationMs += Math.max(0, terminalAt - began);
			}
			let terminalOutcome: RunOutcome;
			if (entry.data.action === "failed") {
				lastError = typeof entry.data.error === "string" ? entry.data.error : "child activation failed";
				terminalOutcome = { output: "", stopReason: "error", errorMessage: lastError };
			} else {
				const stopReason = entry.data.stopReason;
				if (stopReason === "completed" || stopReason === "aborted" || stopReason === "error" ||
					stopReason === "max-tokens" || stopReason === "refusal") {
					lastError = typeof entry.data.errorMessage === "string" ? entry.data.errorMessage : undefined;
					const usage = parseUsage(entry.data.usage);
					terminalOutcome = {
						output: typeof entry.data.output === "string" ? entry.data.output : "",
						stopReason,
						...(lastError ? { errorMessage: lastError } : {}),
						...(usage ? { usage } : {}),
					};
				} else {
					lastError = "persisted child delivery has an invalid terminal stop reason";
					terminalOutcome = { output: "", stopReason: "error", errorMessage: lastError };
				}
			}
			lastOutcome = terminalOutcome;
			if (typeof entry.data.maintenance !== "string") settlementOutcome = mergeSettlementOutcome(settlementOutcome, terminalOutcome);
			totalUsage = addUsage(totalUsage, terminalOutcome.usage);
			if (typeof entry.data.maintenance !== "string") {
				needsSettlement = true;
				maintenanceSettlement ||= accepted.get(entry.data.messageId)?.source === "maintenance";
			}
		}
		if (entry.customType === SETTLEMENT_ENTRY) {
			if (entry.data.action === "pending") {
				const notice = parseParentNotice(entry.data.notice);
				if (notice) {
					pendingNotices.set(notice.messageId, notice);
					if (notice.kind === "settlement") {
						needsSettlement = false;
						maintenanceSettlement = false;
						settlementOutcome = undefined;
					}
				}
			} else if (entry.data.action === "delivered" && typeof entry.data.messageId === "string") {
				pendingNotices.delete(entry.data.messageId);
			}
		}
	}
	// Ordinary task recovery remains at-least-once. Maintenance continuation is not:
	// an admitted start without a terminal record needs a fresh request, not replay.
	for (const item of accepted.values()) if (item.source === "maintenance" && startedAt.has(item.messageId) && !consumed.has(item.messageId)) {
		consumed.add(item.messageId);
		if (![...accepted.values()].some(later => later.source !== "maintenance" && later.acceptedAt >= startedAt.get(item.messageId)!)) {
			parked = true; lastError = "An update continuation has an unconfirmed outcome. Review this child's history before assigning fresh work.";
		}
	}
	return {
		...(workId ? { workId } : {}),
		queue: [...accepted.values()].filter((item) => !consumed.has(item.messageId)),
		...(lastOutcome ? { lastOutcome } : {}),
		...(settlementOutcome ? { settlementOutcome } : {}),
		...(totalUsage ? { totalUsage } : {}),
		activeDurationMs,
		...(lastError ? { lastError } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(finishedAt !== undefined ? { finishedAt } : {}),
		parked,
		needsSettlement,
		maintenanceSettlement,
		pendingSettlementNotices: [...pendingNotices.values()],
	};
}

function statusForOutcome(outcome: RunOutcome | undefined): RuntimeChildSnapshot["state"] {
	if (!outcome) return "settled";
	if (outcome.stopReason === "aborted") return "aborted";
	if (outcome.stopReason !== "completed") return "error";
	return "settled";
}

function normalizeLabel(label: string): string {
	const value = label.trim().replace(/\s+/g, " ");
	if (!value) throw new Error("description must not be empty");
	return value;
}

function normalizePrompt(prompt: string): string {
	if (!prompt.trim()) throw new Error("prompt must not be empty");
	return prompt;
}

export function truncateForParent(
	text: string,
	maxBytes = MAX_PARENT_NOTICE_BYTES,
): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = "\n… [truncated; inspect the child session transcript for the full output]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let low = 0;
	let high = text.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, midpoint), "utf8") <= budget) low = midpoint;
		else high = midpoint - 1;
	}
	let prefix = text.slice(0, low);
	if (/^[\uDC00-\uDFFF]/.test(text.slice(low))) prefix = prefix.slice(0, -1);
	return `${prefix}${suffix}`;
}

function abortError(): Error {
	const error = new Error("subagent start was aborted before acceptance");
	error.name = "AbortError";
	return error;
}

export function createDurableChildSession(
	cwd: string,
	sessionDir: string,
	id: string,
	parentSession: string | undefined,
	beforeCreate?: (file: string) => void,
): SessionManager {
	mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const file = join(
		sessionDir,
		`${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
	);
	beforeCreate?.(file);
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd,
			...(parentSession ? { parentSession } : {}),
		})}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	return SessionManager.open(file, sessionDir, cwd);
}

function normalizeToolNames(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) => typeof name === "string" && name.length > 0))].sort();
}

function openWithCancellation(open: () => Promise<ChildDriver>, signal: AbortSignal, settled: () => void): Promise<ChildDriver> {
	return new Promise((resolve, reject) => {
		let cancelled = signal.aborted;
		const abort = () => { cancelled = true; reject(signal.reason); };
		if (cancelled) { settled(); reject(signal.reason); return; }
		signal.addEventListener("abort", abort, { once: true });
		void Promise.resolve().then(() => {
			signal.throwIfAborted();
			return open();
		}).then(async (driver) => {
			signal.removeEventListener("abort", abort);
			if (cancelled) await driver.dispose();
			else resolve(driver);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		}).catch(() => {
			// A late driver failed disposal after its cancelled opening was rejected.
		}).finally(settled);
	});
}

export class SubagentRuntime {
	readonly rootAuthority: Authority;
	readonly maxDepth: number;
	readonly maxActive: number;
	private readonly openTimeoutMs: number;
	private readonly records = new Map<string, ChildRecord>();
	private readonly closingChildren = new Set<string>();
	private readonly leases = new Map<string, SessionLease>();
	private readonly ownedManagers = new Map<string, SessionManager>();
	private readonly openingFiles = new Map<string, number>();
	private shutdownFinished = false;
	private initialized = false;
	private readonly diagnostics = new Map<string, DiagnosticRecord>();
	private readonly authorities = new Map<string, Authority>();
	private readonly listeners = new Set<() => void>();
	private readonly transcriptListeners = new Map<string, Set<Parameters<UiTranscriptSource["subscribe"]>[0]>>();
	private readonly noticeBatchers = new Map<string, NoticeBatcher>();
	private readonly generation = randomUUID();
	private closing = false;
	private maintenance?: SubagentCheckpoint;
	private maintenanceStopped = new Set<string>();
	readonly host: RuntimeHost;
	private readonly driverFactory: ChildDriverFactory;
	private readonly childToolFactory: ChildToolFactory;

	constructor(
		host: RuntimeHost,
		driverFactory: ChildDriverFactory,
		childToolFactory: ChildToolFactory,
		options: { sessionDir?: string; maxDepth?: number; maxActive?: number; openTimeoutMs?: number } = {},
	) {
		this.host = host;
		this.driverFactory = driverFactory;
		this.childToolFactory = childToolFactory;
		this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
		if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 0)
			throw new Error("maxDepth must be a non-negative safe integer");
		this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
		this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.maxActive) || this.maxActive < 1)
			throw new Error("maxActive must be a positive safe integer");
		if (!Number.isSafeInteger(this.openTimeoutMs) || this.openTimeoutMs < 1)
			throw new Error("openTimeoutMs must be a positive safe integer");
		this.sessionDir = options.sessionDir ??
			join(host.agentDir, "subagents", "sessions", encodeURIComponent(host.rootSessionId));
		this.rootAuthority = this.issueAuthority(host.rootSessionId, 0);
	}

	readonly sessionDir: string;

	initialize(): void {
		if (this.initialized || this.closing) throw new Error("Subagent runtime has already been initialized or closed.");
		this.initialized = true;
		mkdirSync(this.sessionDir, { recursive: true });
		this.loadCatalog();
		for (const record of this.records.values()) {
			for (const notice of undispatchedNotices(record.manager.getBranch())) this.batchFor(record).add(notice);
			for (const entry of record.manager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== DELIVERY_ENTRY || !isRecord(entry.data) ||
					entry.data.action !== "finished" || entry.data.backgroundBilling !== true || typeof entry.data.messageId !== "string") continue;
				const usage = parseUsage(entry.data.usage);
				if (usage) this.recordBackgroundUsage(record, entry.data.messageId, usage);
			}
			this.retryPendingSettlements(record);
			try { this.publishSettlement(record); }
			catch (error) { record.lastError = error instanceof Error ? error.message : String(error); continue; }
			if (record.queue.length > 0 && !record.parked) this.startPump(record);
		}
		this.emit();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	transcript(childId: string): UiTranscriptSource {
		const record = this.records.get(childId);
		if (!record) throw new Error("Child transcript is unavailable.");
		return {
			cwd: () => record.manager.getCwd(),
			branch: () => {
				if (this.closing) throw new Error("The child conversation has closed.");
				return record.manager.getBranch();
			},
			subscribe: listener => {
				if (this.closing) throw new Error("The child conversation has closed.");
				let listeners = this.transcriptListeners.get(childId);
				if (!listeners) this.transcriptListeners.set(childId, listeners = new Set());
				listeners.add(listener);
				return () => { listeners.delete(listener); if (!listeners.size && this.transcriptListeners.get(childId) === listeners) this.transcriptListeners.delete(childId); };
			},
		};
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	private releaseFile(file: string): void {
		const manager = this.ownedManagers.get(file);
		if (manager) releaseOwnership(manager);
		this.ownedManagers.delete(file);
		this.leases.get(file)?.close();
		this.leases.delete(file);
	}

	private issueAuthority(sessionId: string, depth: number): Authority {
		const authority: Authority = Object.freeze({
			sessionId,
			rootSessionId: this.host.rootSessionId,
			depth,
			generation: this.generation,
			token: Symbol(sessionId),
		});
		this.authorities.set(sessionId, authority);
		return authority;
	}

	private assertLive(authority: Authority): void {
		if (
			authority.generation !== this.generation ||
			this.authorities.get(authority.sessionId) !== authority
		)
			throw new Error("operation requires the exact live agent authority");
	}

	agentPath(id: string): string {
		const parts: string[] = [];
		while (id !== this.host.rootSessionId) {
			const record = this.records.get(id);
			if (!record) throw Error(`Unknown agent: ${id}`);
			parts.unshift(record.taskName);
			id = record.descriptor.parentSessionId;
		}
		return ["/root", ...parts].join("/");
	}

	resolveTarget(caller: Authority, target: string): string {
		this.assertLive(caller);
		if (target === this.host.rootSessionId || this.records.has(target)) return target;
		const path = resolveTaskPath(this.agentPath(caller.sessionId), target);
		if (path === "/root") return this.host.rootSessionId;
		const matches = [...this.records.keys()].filter(id => this.agentPath(id) === path);
		if (matches.length !== 1) throw Error(`${matches.length ? "Ambiguous" : "Unknown"} agent: ${target}`);
		return matches[0]!;
	}

	private requireTaskName(parentId: string, name: string): void {
		validateTaskName(name);
		if ([...this.records.values()].some(record => record.descriptor.parentSessionId === parentId && record.taskName === name))
			throw Error(`An agent named ${name} already exists under ${this.agentPath(parentId)}`);
	}

	private loadCatalog(): void {
		this.records.clear();
		this.diagnostics.clear();
		const candidates: ChildRecord[] = [];
		for (const name of readdirSync(this.sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(this.sessionDir, name);
			let lease: SessionLease | undefined;
			try {
				lease = new SessionLease(file);
				const manager = SessionManager.open(file, this.sessionDir);
				const sessionId = manager.getSessionId();
				const branch = manager.getBranch();
				const entry = branch.find(
					(candidate) => candidate.type === "custom" && candidate.customType === DESCRIPTOR_ENTRY,
				);
				if (!entry || entry.type !== "custom") {
					if (this.host.activeRootLaunchIds.has(sessionId)) this.diagnostics.set(sessionId, {
						id: sessionId,
						parentSessionId: this.host.rootSessionId,
						rootSessionId: this.host.rootSessionId,
						reason: "corrupt",
					});
					continue;
				}
				let descriptor: ChildDescriptor;
				try {
					descriptor = parseDescriptor(entry.data);
				} catch (error) {
					const raw = isRecord(entry.data) ? entry.data : {};
					if (raw.rootSessionId === this.host.rootSessionId) {
						this.diagnostics.set(sessionId, {
							id: sessionId,
							...(typeof raw.parentSessionId === "string"
								? { parentSessionId: raw.parentSessionId }
								: {}),
							rootSessionId: this.host.rootSessionId,
							reason:
								isRecord(error) && error.code === "UNSUPPORTED"
									? "unsupported"
									: "corrupt",
						});
					}
					continue;
				}
				if (descriptor.childSessionId !== sessionId) throw new Error("descriptor childSessionId does not match session");
				if (descriptor.rootSessionId !== this.host.rootSessionId) continue;
				const named = branch.find(candidate => candidate.type === "custom" && candidate.customType === TASK_NAME_ENTRY);
				const taskName = named?.type === "custom"
					? validateTaskName(requiredString(isRecord(named.data) ? named.data : {}, "name"))
					: historicalTaskName(sessionId);
				const recovered = recoverChildState(branch);
				candidates.push({
					...(recovered.workId ? { workId: recovered.workId } : {}),
					descriptor,
					manager,
					taskName,
					queue: recovered.queue,
					parked: recovered.parked,
					updatedAt: recovered.updatedAt ?? descriptor.createdAt,
					...(recovered.finishedAt !== undefined ? { finishedAt: recovered.finishedAt } : {}),
					...(recovered.lastOutcome ? { lastOutcome: recovered.lastOutcome } : {}),
					...(recovered.settlementOutcome ? { settlementOutcome: recovered.settlementOutcome } : {}),
					...(recovered.totalUsage ? { totalUsage: recovered.totalUsage } : {}),
					activeDurationMs: recovered.activeDurationMs,
					...(recovered.lastError ? { lastError: recovered.lastError } : {}),
					pendingSettlement: (descriptor.mode === "continuable" || recovered.maintenanceSettlement) && recovered.needsSettlement,
					maintenanceSettlement: recovered.maintenanceSettlement,
					pendingSettlementNotices: recovered.pendingSettlementNotices,
				});
				this.leases.set(file, lease);
			} catch {
				const header = readHeaderFallback(file);
				if (header.id && header.parentSession === this.host.rootSessionFile) {
					this.diagnostics.set(header.id, {
						id: header.id,
						parentSessionId: this.host.rootSessionId,
						rootSessionId: this.host.rootSessionId,
						reason: "unavailable",
					});
				}
			} finally { if (!this.leases.has(file)) lease?.close(); }
		}

		const byId = new Map(candidates.map((record) => [record.descriptor.childSessionId, record]));
		const valid = new Set<string>();
		let lineageChanged = true;
		while (lineageChanged) {
			lineageChanged = false;
			for (const record of candidates) {
				const descriptor = record.descriptor;
				if (valid.has(descriptor.childSessionId)) continue;
				if (descriptor.parentSessionId === this.host.rootSessionId) {
					if (
						descriptor.depth === 1 &&
						(!this.host.rootSessionFile || descriptor.parentSessionFile === this.host.rootSessionFile)
					) {
						valid.add(descriptor.childSessionId);
						lineageChanged = true;
					}
					continue;
				}
				const parent = byId.get(descriptor.parentSessionId);
				if (
					parent &&
					valid.has(parent.descriptor.childSessionId) &&
					descriptor.depth === parent.descriptor.depth + 1 &&
					descriptor.parentSessionFile === parent.manager.getSessionFile()
				) {
					valid.add(descriptor.childSessionId);
					lineageChanged = true;
				}
			}
		}
		const allowed = new Set(this.host.activeRootLaunchIds);
		let changed = true;
		while (changed) {
			changed = false;
			for (const record of candidates) {
				const descriptor = record.descriptor;
				if (allowed.has(descriptor.childSessionId)) continue;
				if (descriptor.parentSessionId === this.host.rootSessionId) continue;
				const parent = byId.get(descriptor.parentSessionId);
				if (!parent || !allowed.has(parent.descriptor.childSessionId)) continue;
				if (launchIds(parent.manager).has(descriptor.childSessionId)) {
					allowed.add(descriptor.childSessionId);
					changed = true;
				}
			}
		}
		const expectedParent = new Map<string, string>();
		for (const id of this.host.activeRootLaunchIds) expectedParent.set(id, this.host.rootSessionId);
		let discovered = true;
		while (discovered) {
			discovered = false;
			for (const record of candidates) {
				const id = record.descriptor.childSessionId;
				if (!expectedParent.has(id)) continue;
				for (const childId of launchIds(record.manager)) {
					if (expectedParent.has(childId)) continue;
					expectedParent.set(childId, id);
					allowed.add(childId);
					discovered = true;
				}
			}
		}
		for (const [id, diagnostic] of [...this.diagnostics]) {
			const parentSessionId = expectedParent.get(id);
			if (!parentSessionId) this.diagnostics.delete(id);
			else diagnostic.parentSessionId = parentSessionId;
		}
		for (const record of candidates) {
			const id = record.descriptor.childSessionId;
			if (valid.has(id) && allowed.has(id)) this.records.set(id, record);
			else if (allowed.has(id)) this.diagnostics.set(id, {
				id,
				parentSessionId: record.descriptor.parentSessionId,
				rootSessionId: record.descriptor.rootSessionId,
				reason: "corrupt",
			});
		}
		for (const [id, parentSessionId] of expectedParent) {
			if (this.records.has(id) || this.diagnostics.has(id)) continue;
			this.diagnostics.set(id, {
				id,
				parentSessionId,
				rootSessionId: this.host.rootSessionId,
				reason: "unavailable",
			});
		}
		const retained = new Set([...this.records.values()].map(record => record.manager.getSessionFile()!));
		for (const [file, lease] of this.leases) {
			if (!retained.has(file)) { lease.close(); this.leases.delete(file); }
		}
		for (const record of this.records.values()) {
			const file = record.manager.getSessionFile()!;
			attachOwnership(record.manager, this.leases.get(file)!, true);
			this.ownedManagers.set(file, record.manager);
		}
	}

	private recordLaunch(parent: ParentInvocation, childId: string): void {
		if (parent.authority.sessionId === this.host.rootSessionId) {
			this.host.recordRootLaunch(childId);
			return;
		}
		const parentRecord = this.records.get(parent.authority.sessionId);
		if (!parentRecord) throw new Error("live child parent has no durable record");
		parentRecord.manager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: parent.authority.sessionId,
			childId,
			createdAt: Date.now(),
		});
	}

	async start(request: StartRequest): Promise<StartResult> {
		if (this.closing) throw new Error("subagent runtime is shutting down");
		this.requireAdmission();
		this.assertLive(request.parent.authority);
		if (request.parent.authority.depth >= this.maxDepth)
			throw new Error(`subagent depth limit ${this.maxDepth} reached`);
		if (!request.parent.model) throw new Error("subagent requires an active parent model");
		this.requireCapacity();
		if (request.signal?.aborted) throw abortError();
		const label = normalizeLabel(request.description);
		const prompt = normalizePrompt(request.prompt);
		if (request.taskName !== undefined) this.requireTaskName(request.parent.authority.sessionId, request.taskName);
		let model = request.parent.model;
		let thinkingLevel = request.parent.thinkingLevel ?? "medium";
		const hasOverride = request.model !== undefined || request.thinkingLevel !== undefined;
		if (request.model !== undefined) {
			const separator = request.model.indexOf("/");
			if (separator <= 0 || separator === request.model.length - 1 || /\s/.test(request.model))
				throw new Error("subagent model must be an exact provider/model id");
			const ref = { provider: request.model.slice(0, separator), id: request.model.slice(separator + 1) };
			const selected = this.host.resolveModel(ref);
			if (!selected) throw new Error(`subagent model is unavailable: ${request.model}`);
			model = selected;
			thinkingLevel = clampThinkingLevel(model, thinkingLevel);
		}
		if (request.thinkingLevel !== undefined) {
			const available = getSupportedThinkingLevels(model);
			if (!available.includes(request.thinkingLevel))
				throw new Error(`thinking level ${request.thinkingLevel} is unavailable for ${model.provider}/${model.id}; choose ${available.join(", ")}`);
			thinkingLevel = request.thinkingLevel;
		}
		const selection: ModelSelection = { model: { provider: model.provider, id: model.id }, thinkingLevel };
		if (hasOverride) {
			if (!this.host.authorizeModelOverrides) throw new Error("Subagent model and thinking overrides need user approval for this conversation");
			await this.host.authorizeModelOverrides(selection, request.signal);
			if (this.closing) throw new Error("subagent runtime is shutting down");
			this.assertLive(request.parent.authority);
			this.requireCapacity();
			if (request.signal?.aborted) throw abortError();
		}
		const childId = randomUUID();
		const taskName = request.taskName ?? historicalTaskName(childId);
		// Approval is asynchronous; another call may have claimed the name.
		this.requireTaskName(request.parent.authority.sessionId, taskName);
		const mode: ChildMode = request.runInBackground ? "continuable" : "one-shot";
		let manager: SessionManager | undefined;
		let claimedFile: string | undefined;
		let record: ChildRecord | undefined;
		let item: QueueItem | undefined;
		try {
			manager = createDurableChildSession(
				request.parent.cwd,
				this.sessionDir,
				childId,
				request.parent.sessionManager.getSessionFile(),
				file => {
					const lease = new SessionLease(file);
					claimedFile = file;
					this.leases.set(file, lease);
				},
			);
			attachOwnership(manager, this.leases.get(claimedFile!)!, true);
			this.ownedManagers.set(claimedFile!, manager);
			const forkBoundaryEntryId =
				request.context === "fork"
					? copyCompletedParentTurns(
							request.parent.sessionManager,
							manager,
							request.parent.toolCallId,
							request.forkTurns,
						)
					: undefined;
			const descriptor: ChildDescriptor = {
				version: DESCRIPTOR_VERSION,
				projectTrusted: request.parent.projectTrusted && this.host.isProjectTrusted() &&
					(this.records.get(request.parent.authority.sessionId)?.descriptor.projectTrusted ?? true),
				childSessionId: childId,
				rootSessionId: this.host.rootSessionId,
				parentSessionId: request.parent.authority.sessionId,
				...(request.parent.sessionManager.getSessionFile()
					? { parentSessionFile: request.parent.sessionManager.getSessionFile() }
					: {}),
				mode,
				context: request.context,
				provider: "pi-sdk",
				label,
				depth: request.parent.authority.depth + 1,
				cwd: request.parent.cwd,
				createdAt: Date.now(),
				model: selection.model,
				thinkingLevel: selection.thinkingLevel,
				toolNames: normalizeToolNames(request.parent.toolNames),
				...(forkBoundaryEntryId ? { forkBoundaryEntryId } : {}),
			};
			manager.appendCustomEntry(DESCRIPTOR_ENTRY, descriptor);
			manager.appendCustomEntry(TASK_NAME_ENTRY, { name: taskName });
			record = {
				taskName,
				descriptor,
				manager,
				queue: [],
				parked: false,
				activeDurationMs: 0,
				updatedAt: descriptor.createdAt,
				pendingSettlement: mode === "continuable",
				pendingSettlementNotices: [],
			};
			item = this.accept(record, prompt, "initial");
			if (request.signal?.aborted) throw abortError();
			this.recordLaunch(request.parent, childId);
			this.records.set(childId, record);
		} catch (error) {
			const file = manager?.getSessionFile();
			if (file) {
				try {
					unlinkSync(file);
				} catch {
					// An unowned durable session is ignored by catalog recovery.
				}
			}
			if (claimedFile) this.releaseFile(claimedFile);
			throw error;
		}
		if (!record || !item) throw new Error("subagent acceptance did not produce a durable record");
		this.emit();

		if (request.runInBackground) {
			this.startPump(record);
			return { kind: "continuable", subagentId: childId, messageId: item.messageId };
		}

		const outcomePromise = new Promise<RunOutcome>((resolve, reject) => {
			item.resolve = resolve;
			item.reject = reject;
		});
		let abortListener: (() => void) | undefined;
		if (request.signal) {
			abortListener = () => {
				item.cancelled = true;
				if (record.activation?.current === item || record.opening)
					this.interrupt(request.parent.authority, childId);
			};
			if (request.signal.aborted) abortListener();
			else request.signal.addEventListener("abort", abortListener, { once: true });
		}
		this.startPump(record);
		try {
			return { kind: "foreground", runId: childId, outcome: await outcomePromise };
		} finally {
			if (request.signal && abortListener)
				request.signal.removeEventListener("abort", abortListener);
		}
	}

	private accept(
		record: ChildRecord,
		content: string,
		source: QueueSource,
		messageId: string = randomUUID(),
		delivery?: "boundary",
	): QueueItem {
		if (source !== "maintenance") this.requireAdmission();
		if (this.closingChildren.has(record.descriptor.childSessionId)) throw Error("The subagent is closing.");
		const queued = record.queue.find((item) => item.messageId === messageId);
		if (queued) return queued;
		const item: QueueItem = {
			delivery,
			messageId,
			content,
			source,
			acceptedAt: Date.now(),
			started: false,
		};
		record.manager.appendCustomEntry(INBOX_ENTRY, {
			action: "accepted",
			messageId: item.messageId,
			content,
			source,
			...(delivery ? { delivery } : {}),
			acceptedAt: item.acceptedAt,
		});
		record.queue.push(item);
		record.updatedAt = item.acceptedAt;
		return item;
	}

	private setParked(record: ChildRecord, parked: boolean): void {
		if (record.parked === parked) return;
		record.manager.appendCustomEntry(CONTROL_ENTRY, {
			action: parked ? "parked" : "unparked",
			at: Date.now(),
		});
		record.parked = parked;
	}

	sendMessage(caller: Authority, target: string, message: string): string {
		this.requireAdmission();
		if (this.closing) throw new Error("subagent runtime is shutting down");
		const recipientId = this.resolveTarget(caller, target);
		const content = normalizePrompt(message);
		const sender = this.records.get(caller.sessionId);
		const notice: ParentNotice = {
			messageId: randomUUID(), kind: "report", childId: caller.sessionId, recipientId,
			priority: "action-required",
			outputHash: createHash("sha256").update(content).digest("hex"),
			workId: sender?.workId,
			content: `Message from ${this.agentPath(caller.sessionId)} (${caller.sessionId}):\n${content}`,
		};
		if (sender) {
			sender.manager.appendCustomEntry(SETTLEMENT_ENTRY, { action: "pending", notice, createdAt: Date.now() });
			sender.pendingSettlementNotices.push(notice);
			this.retryPendingSettlements(sender);
		} else if (!this.deliverNotice(recipientId, notice)) throw Error("Message could not be admitted");
		return notice.messageId;
	}

	followupTask(caller: Authority, target: string, message: string): string {
		if (this.closing) throw new Error("subagent runtime is shutting down");
		const childId = this.resolveTarget(caller, target);
		if (childId === this.host.rootSessionId) throw Error("followup_task cannot target the root; use send_message");
		const record = this.records.get(childId)!;
		if (record.descriptor.mode !== "continuable") throw Error(`subagent "${childId}" is not resumable`);
		const item = this.accept(record, normalizePrompt(message), "followup", randomUUID(), "boundary");
		this.setParked(record, false);
		if (record.activation?.driver.isRunning) this.stageFollowups(record);
		if (!record.pendingSettlement) record.settlementOutcome = undefined;
		record.pendingSettlement = true;
		this.startPump(record);
		this.emit();
		return item.messageId;
	}

	private boundaryFollowups(record: ChildRecord): QueueItem[] {
		const current = record.activation?.current;
		if (!current || record.parked) return [];
		const inputs: QueueItem[] = [];
		for (const item of record.queue.slice(record.queue.indexOf(current) + 1)) {
			// Already-accepted historical FIFO input is a delivery-order barrier.
			if (item.delivery !== "boundary" || item.cancelled) break;
			inputs.push(item);
		}
		return inputs;
	}

	private stageFollowups(record: ChildRecord): void {
		for (const item of this.boundaryFollowups(record)) record.activation!.driver.enqueueFollowup(item);
	}

	resumePartyAgent(caller: Authority, childId: string): string {
		this.requireAdmission();
		this.assertLive(caller);
		if (caller !== this.rootAuthority) throw Error("Party child controls require the owning runtime.");
		const record = this.records.get(childId);
		if (!record || record.descriptor.mode !== "continuable") throw Error("This managed child is not resumable.");
		if (this.closingChildren.has(childId)) throw Error("The subagent is closing.");
		if (record.opening || record.activation?.current || record.queue.length && !record.parked) return "already_running";
		if (!record.queue.length) this.accept(record, "Read the pending peer messages with party_read and respond as needed.", "party");
		this.setParked(record, false);
		if (!record.pendingSettlement) record.settlementOutcome = undefined;
		record.pendingSettlement = true; this.startPump(record); this.emit();
		return "queued";
	}

	async closePartyAgent(caller: Authority, childId: string): Promise<string> {
		this.assertLive(caller);
		if (caller !== this.rootAuthority) throw Error("Party child controls require the owning runtime.");
		if (!this.records.has(childId)) throw Error("The managed child is unavailable.");
		const ids = new Set([childId]);
		for (let size = -1; size !== ids.size;) {
			size = ids.size;
			for (const record of this.records.values()) if (ids.has(record.descriptor.parentSessionId)) ids.add(record.descriptor.childSessionId);
		}
		const records = [...ids].map(id => this.records.get(id)!).sort((a, b) => b.descriptor.depth - a.descriptor.depth);
		try {
			for (const record of records) {
				this.closingChildren.add(record.descriptor.childSessionId); this.setParked(record, true);
				for (const item of record.queue) item.cancelled = true;
				record.opening?.abort(); record.activation?.driver.interrupt();
			}
			await Promise.allSettled(records.map(record => record.pump));
			for (const record of records) {
				while (record.queue.length) this.finishCancelledItem(record, record.queue[0]);
				const failure = await this.disposeActivation(record); if (failure) throw failure;
				await this.maybeSettle(record);
			}
			return "closed";
		} finally { for (const id of ids) this.closingChildren.delete(id); this.emit(); }
	}

	interrupt(caller: Authority, targetId: string): boolean {
		this.assertLive(caller);
		if (caller.sessionId === targetId)
			throw new Error("an agent cannot interrupt itself");
		if (targetId === this.host.rootSessionId) throw Error("an agent cannot interrupt the root");
		const record = this.records.get(targetId);
		if (!record) throw Error(`Unknown agent: ${targetId}`);
		if (record.opening) {
			const item = record.queue[0];
			if (item) item.cancelled = true;
			this.setParked(record, true);
			record.opening.abort();
		} else if (record.activation?.current) {
			record.activation.interrupted = true;
			this.setParked(record, true);
			record.activation.driver.interrupt();
		}
		return true;
	}

	private deliverNotice(parentId: string, notice: ParentNotice): boolean {
		if (this.closing) return false;
		if (parentId === this.host.rootSessionId) {
			return this.host.deliverRootNotice(notice);
		}
		const parent = this.records.get(parentId);
		if (!parent) return false;
		const alreadyAccepted = parent.manager.getBranch().some(
			(entry) => entry.type === "custom" && isRecord(entry.data) &&
				entry.data.messageId === notice.messageId &&
				(entry.customType === NOTICE_ENTRY ||
					(entry.customType === INBOX_ENTRY && entry.data.action === "accepted")),
		);
		if (alreadyAccepted) return true;
		// ACK each individual notice only after its inbox receipt is durable.
		parent.manager.appendCustomEntry(NOTICE_ENTRY, notice);
		this.batchFor(parent).add(notice);
		return true;
	}

	private batchFor(parent: ChildRecord): NoticeBatcher {
		const id = parent.descriptor.childSessionId;
		let batcher = this.noticeBatchers.get(id);
		if (batcher) return batcher;
		batcher = new NoticeBatcher((notices) => {
			const pendingIds = new Set(undispatchedNotices(parent.manager.getBranch()).map((notice) => notice.messageId));
			notices = notices.filter((notice) => pendingIds.has(notice.messageId));
			if (!notices.length) return;
			const driver = parent.activation?.driver;
			if (driver) {
				if (driver.receiveNotices) driver.receiveNotices(notices);
				else for (const notice of notices) driver.receiveNotice(notice);
			}
			// Cold and idle recipients retain their native inbox without a new prompt.
		}, (error) => { parent.lastError = error instanceof Error ? error.message : String(error); }, () => {
			if (parent.pump || this.closing) return;
			void this.maybeSettle(parent).catch((error) => { parent.lastError = error instanceof Error ? error.message : String(error); });
		});
		batcher.setPaused(!!this.maintenance || !!this.host.isSuspended?.());
		this.noticeBatchers.set(id, batcher);
		return batcher;
	}

	private retryPendingSettlements(record: ChildRecord): void {
		const blocked = new Set<string>();
		for (const notice of [...record.pendingSettlementNotices]) {
			const recipient = notice.recipientId ?? record.descriptor.parentSessionId;
			if (blocked.has(recipient)) continue;
			try {
				if (!this.deliverNotice(recipient, notice)) { blocked.add(recipient); continue; }
				record.manager.appendCustomEntry(SETTLEMENT_ENTRY, {
					action: "delivered",
					messageId: notice.messageId,
					deliveredAt: Date.now(),
				});
				record.pendingSettlementNotices = record.pendingSettlementNotices.filter(
					(candidate) => candidate.messageId !== notice.messageId,
				);
			} catch (error) {
				record.lastError = error instanceof Error ? error.message : String(error);
				blocked.add(recipient);
			}
		}
	}

	private activeCount(): number {
		return [...this.records.values()].filter((record) => record.activation || record.opening || record.pump || record.disposing
			|| this.openingFiles.has(record.manager.getSessionFile()!)).length;
	}

	private requireCapacity(): void {
		if (this.activeCount() >= this.maxActive)
			throw new Error(`root-wide subagent limit ${this.maxActive} reached; wait for active children or initialization cleanup to finish`);
	}

	private startPump(record: ChildRecord): void {
		if (record.pump || record.parked || this.closing || this.maintenance || this.host.isSuspended?.()) return;
		if (!record.activation && this.openingFiles.has(record.manager.getSessionFile()!)) return;
		if (!record.activation && record.queue.length > 0 && this.activeCount() >= this.maxActive) return;
		record.pump = this.pump(record)
			.catch(async (error) => {
				await this.handlePumpFailure(record, error);
			})
			.finally(async () => {
				try {
					record.pump = undefined;
					if (record.queue.length > 0 && !record.parked && !this.closing) {
						this.startPump(record);
						this.emit();
						return;
					}
					await this.maybeSettle(record);
					for (const waiting of this.records.values()) {
						if (waiting.queue.length) this.startPump(waiting);
					}
					this.emit();
				} catch (error) {
					record.lastError = error instanceof Error ? error.message : String(error);
				}
			});
	}

	private async handlePumpFailure(record: ChildRecord, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const stranded = record.queue.splice(0);
		record.lastError = message;
		record.lastOutcome = { output: "", stopReason: "error", errorMessage: message };
		record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, record.lastOutcome);
		record.pendingSettlement = record.descriptor.mode === "continuable";
		const failedAt = Date.now();
		const failures = stranded.length > 0
			? stranded.map((item) => ({ item, messageId: item.messageId }))
			: [{ item: undefined, messageId: `runtime-${randomUUID()}` }];
		for (const failure of failures) {
			try {
				record.manager.appendCustomEntry(DELIVERY_ENTRY, {
					action: "failed",
					messageId: failure.messageId,
					workId: record.workId,
					finishedAt: failedAt,
					error: message,
				});
			} catch {
				// Keep the in-memory error; a failed durable append must not become an unhandled rejection.
			}
			failure.item?.reject?.(error);
		}
		await this.disposeActivation(record);
		try {
			await this.maybeSettle(record);
		} catch (settlementError) {
			record.lastError = settlementError instanceof Error
				? settlementError.message
				: String(settlementError);
		}
	}

	private async ensureActivation(record: ChildRecord): Promise<Activation> {
		if (record.disposing) await record.disposing;
		if (this.closing) throw new Error("subagent runtime is shutting down");
		if (record.activation) return record.activation;
		const authority = this.issueAuthority(
			record.descriptor.childSessionId,
			record.descriptor.depth,
		);
		const opening = new AbortController();
		record.opening = opening;
		const signal = AbortSignal.any([opening.signal, AbortSignal.timeout(this.openTimeoutMs)]);
		try {
			const customTools = this.childToolFactory(
				this,
				authority,
				record.descriptor.mode,
			);
			const file = record.manager.getSessionFile()!;
			this.openingFiles.set(file, (this.openingFiles.get(file) ?? 0) + 1);
			const driver = await openWithCancellation(() => this.driverFactory.open({
				descriptor: record.descriptor,
				taskPath: this.agentPath(record.descriptor.childSessionId),
				parentTaskPath: this.agentPath(record.descriptor.parentSessionId),
				onFollowupDelivered: ids => {
					for (const id of ids) {
						const input = record.queue.find(item => item.messageId === id && item.delivery === "boundary" && !item.started);
						if (!input) continue;
						input.started = true; input.startedAt = Date.now();
						record.manager.appendCustomEntry(DELIVERY_ENTRY, { action: "started", messageId: id, startedAt: input.startedAt });
					}
					this.emit();
				},
				sessionManager: record.manager,
				authority,
				customTools,
				intrinsicToolNames: [],
				signal,
			}), signal, () => {
				const pending = (this.openingFiles.get(file) ?? 1) - 1;
				if (pending) this.openingFiles.set(file, pending);
				else {
					this.openingFiles.delete(file);
					if (this.shutdownFinished) this.releaseFile(file);
					else if (!this.closing) {
						for (const waiting of this.records.values()) if (waiting.queue.length) this.startPump(waiting);
						this.emit();
					}
				}
			});
			if (this.closing) {
				await driver.dispose();
				this.authorities.delete(authority.sessionId);
				throw new Error("subagent runtime shut down while opening a child activation");
			}
			const activation: Activation = { authority, driver, interrupted: false };
			activation.unsubscribeTranscript = driver.subscribeTranscript?.(event => {
				const listeners = this.transcriptListeners.get(record.descriptor.childSessionId);
				if (listeners) for (const listener of listeners) listener(event);
			});
			activation.unsubscribeActivity = driver.subscribeActivity?.(() => {
				record.updatedAt = Date.now();
				this.emit();
			});
			record.activation = activation;
			return activation;
		} catch (error) {
			this.authorities.delete(authority.sessionId);
			throw error;
		} finally {
			record.opening = undefined;
		}
	}

	private finishCancelledItem(record: ChildRecord, item: QueueItem): void {
		this.publishSettlement(record);
		const outcome: RunOutcome = { output: "", stopReason: "aborted" };
		const finishedAt = Date.now();
		record.workId = item.messageId;
		record.pendingSettlement = record.descriptor.mode === "continuable";
		record.lastOutcome = outcome;
		record.lastError = undefined;
		record.updatedAt = finishedAt;
		record.finishedAt = finishedAt;
		record.manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "finished",
			messageId: item.messageId,
			workId: record.workId,
			finishedAt,
			stopReason: outcome.stopReason,
			output: outcome.output,
		});
		record.queue.shift();
		record.settlementOutcome = outcome;
		item.resolve?.(outcome);
	}

	private failQueuedActivation(record: ChildRecord, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const failedAt = Date.now();
		const queued = record.queue.splice(0);
		record.lastError = message;
		record.lastOutcome = {
			output: "",
			stopReason: "error",
			errorMessage: message,
		};
		record.updatedAt = failedAt;
		record.finishedAt = failedAt;
		try {
			this.setParked(record, true);
		} catch {
			record.parked = true;
		}
		record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, record.lastOutcome);
		for (const item of queued) {
			try {
				record.manager.appendCustomEntry(DELIVERY_ENTRY, {
					action: "failed",
					messageId: item.messageId,
					workId: record.workId,
					finishedAt: failedAt,
					error: message,
				});
			} catch (appendError) {
				record.lastError = appendError instanceof Error ? appendError.message : String(appendError);
			}
			item.reject?.(error);
		}
	}

	private async pump(record: ChildRecord): Promise<void> {
		// A recovered terminal result belongs to the previous invocation, not the next input.
		this.publishSettlement(record);
		while (!this.closing && !record.parked && record.queue.length > 0) {
			const item = record.queue[0];
			if (!item) break;
			record.workId = item.messageId;
			record.settlementOutcome = undefined;
			record.maintenanceSettlement = item.source === "maintenance";
			record.pendingSettlement = record.descriptor.mode === "continuable" || record.maintenanceSettlement;
			if (item.cancelled) {
				this.finishCancelledItem(record, item);
				break;
			}
			let activation: Activation;
			try {
				activation = await this.ensureActivation(record);
				if (this.closing) break;
			} catch (error) {
				if (!this.closing) {
					if (item.cancelled) this.finishCancelledItem(record, item);
					else this.failQueuedActivation(record, error);
				}
				break;
			}
			if (item.cancelled) {
				this.finishCancelledItem(record, item);
				break;
			}
			activation.current = item;
			activation.interrupted = false;
			item.started = true;
			item.startedAt = Date.now();
			record.manager.appendCustomEntry(DELIVERY_ENTRY, {
				action: "started",
				messageId: item.messageId,
				workId: record.workId,
				startedAt: item.startedAt,
			});
			record.updatedAt = Date.now();
			this.emit();
			this.stageFollowups(record);
			let outcome: RunOutcome;
			try {
				outcome = await activation.driver.prompt(item.content);
			} catch (error) {
				outcome = {
					output: "",
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
			}
			if (activation.interrupted && outcome.stopReason === "completed")
				outcome = { ...outcome, stopReason: "aborted" };
			const delivered = new Set(outcome.consumedFollowups ?? []);
			const consumedFollowups = record.queue.filter(input => input !== item && input.delivery === "boundary" && delivered.has(input.messageId)).map(input => input.messageId);
			record.lastOutcome = outcome;
			const held = this.maintenance?.children.some(child => child.id === record.descriptor.childSessionId && child.running) && outcome.stopReason === "aborted";
			if (!held) record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, outcome);
			record.totalUsage = addUsage(record.totalUsage, outcome.usage);
			record.lastError = outcome.errorMessage;
			record.updatedAt = Date.now();
			record.finishedAt = record.updatedAt;
			if (item.startedAt !== undefined)
				record.activeDurationMs += Math.max(0, record.finishedAt - item.startedAt);
			record.manager.appendCustomEntry(DELIVERY_ENTRY, {
				action: "finished",
				messageId: item.messageId,
				workId: record.workId,
				...(consumedFollowups.length ? { consumedFollowups } : {}),
				finishedAt: record.finishedAt,
				stopReason: outcome.stopReason,
				output: outcome.output,
				...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
				...(outcome.usage ? { usage: outcome.usage } : {}),
				backgroundBilling: !item.resolve || outcome.stopReason !== "completed",
				...(held ? { maintenance: this.maintenance!.id } : {}),
			});
			if (outcome.usage && (!item.resolve || outcome.stopReason !== "completed"))
				this.recordBackgroundUsage(record, item.messageId, outcome.usage);
			record.queue = record.queue.filter(input => input !== item && !consumedFollowups.includes(input.messageId));
			activation.current = undefined;
			item.resolve?.(outcome);
			await this.maybeSettle(record);
		}
		await this.maybeSettle(record);
	}

	private recordBackgroundUsage(record: ChildRecord, messageId: string, usage: Usage): void {
		try {
			this.host.recordBackgroundUsage?.(record.descriptor.childSessionId, messageId, usage);
		} catch (error) {
			// The child delivery record retains the charge for replay at startup.
			record.lastError = `usage admission failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private hasLiveDescendantWork(parentId: string): boolean {
		const ancestors = new Set([parentId]);
		for (let added = true; added;) {
			added = false;
			for (const record of this.records.values()) {
				if (!ancestors.has(record.descriptor.parentSessionId)) continue;
				if (record.activation || record.disposing || record.opening || record.pump || record.queue.length) return true;
				if (!ancestors.has(record.descriptor.childSessionId)) { ancestors.add(record.descriptor.childSessionId); added = true; }
			}
		}
		return false;
	}

	private async disposeActivation(record: ChildRecord): Promise<unknown | undefined> {
		if (record.disposing) return record.disposing;
		const activation = record.activation;
		if (!activation) return undefined;
		// Detach authority before async extension shutdown. New accepted work
		// waits for disposal and cannot prompt a driver being invalidated.
		this.authorities.delete(activation.authority.sessionId);
		record.activation = undefined;
		const disposing = (async () => {
			let failure: unknown;
			try { activation.unsubscribeActivity?.(); } catch (error) { failure = error; }
			try { activation.unsubscribeTranscript?.(); } catch (error) { failure ??= error; }
			try { await activation.driver.dispose(); } catch (error) { failure ??= error; }
			return failure;
		})();
		record.disposing = disposing;
		try { return await disposing; }
		finally { if (record.disposing === disposing) record.disposing = undefined; }
	}

	private async maybeSettle(record: ChildRecord): Promise<void> {
		if (this.maintenance || this.host.isSuspended?.()) return;
		if (record.opening || record.activation?.current || record.activation?.driver.isRunning) return;
		this.retryPendingSettlements(record);
		// Consecutive accepted turns may reuse a driver. Parked work must not retain one.
		if (record.queue.length && !record.parked) { this.publishSettlement(record); this.emit(); return; }
		const cleanupFailure = await this.disposeActivation(record);
		if (record.opening || record.activation?.current || record.activation?.driver.isRunning) return;
		if (cleanupFailure) {
			const message = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
			record.lastError = message;
			record.lastOutcome = {
				output: record.settlementOutcome?.output ?? record.lastOutcome?.output ?? "",
				stopReason: "error",
				errorMessage: message,
			};
			record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, record.lastOutcome);
			record.pendingSettlement = record.descriptor.mode === "continuable";
			record.manager.appendCustomEntry(DELIVERY_ENTRY, {
				action: "failed",
				messageId: `cleanup-${randomUUID()}`,
				workId: record.workId,
				finishedAt: Date.now(),
				error: message,
			});
		}
		this.publishSettlement(record);
		this.emit();
	}

	private publishSettlement(record: ChildRecord): void {
		if (this.maintenance || this.host.isSuspended?.()) return;
		if (record.pendingSettlement && record.settlementOutcome && (record.descriptor.mode === "continuable" || record.maintenanceSettlement)) {
			const outcome = record.settlementOutcome;
			const errorDetail = outcome.errorMessage ? `\nError: ${outcome.errorMessage}` : "";
			const hash = createHash("sha256").update(outcome.output).digest("hex");
			const branch = record.manager.getBranch();
			const delivered = new Set(branch.flatMap(entry => entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && isRecord(entry.data) && entry.data.action === "delivered" ? [entry.data.messageId] : []));
			const reported = branch.some(entry => entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && isRecord(entry.data) && entry.data.action === "pending" && isRecord(entry.data.notice)
				&& entry.data.notice.kind === "report" && entry.data.notice.outputHash === hash && entry.data.notice.workId === record.workId
				&& (entry.data.notice.recipientId === undefined || entry.data.notice.recipientId === record.descriptor.parentSessionId)
				&& delivered.has(entry.data.notice.messageId));
			const detail = outcome.output ? reported ? "\nFinal output is identical to the previously delivered report." : `\nFinal assistant message:\n${outcome.output}` : "";
			const notice: ParentNotice = {
				messageId: randomUUID(),
				kind: "settlement",
				priority: outcome.stopReason === "completed" ? "routine" : "urgent",
				workId: record.workId,
				childId: record.descriptor.childSessionId,
				content: truncateForParent(
					`${record.descriptor.mode === "one-shot" ? "Resumed foreground" : "Background"} subagent ${record.descriptor.childSessionId} settled with ${outcome.stopReason}.${errorDetail}${detail}`,
				),
			};
			record.manager.appendCustomEntry(SETTLEMENT_ENTRY, {
				action: "pending",
				notice,
				createdAt: Date.now(),
			});
			record.pendingSettlementNotices.push(notice);
			record.pendingSettlement = false;
			record.maintenanceSettlement = false;
			record.settlementOutcome = undefined;
			this.retryPendingSettlements(record);
		}
	}

	agentStatus(id: string): "running" | "idle" | "ready" | "unknown" {
		if (id === this.host.rootSessionId) return this.host.getRootStatus?.() ?? "unknown";
		const record = this.records.get(id);
		if (!record) throw Error(`Unknown agent: ${id}`);
		return record.opening || record.pump || record.activation?.current || record.activation?.driver.isRunning
			? "running" : record.activation || (!record.parked && record.queue.length) ? "idle" : "ready";
	}

	listNamedAgents(caller: Authority, pathPrefix?: string): { agent_name: string; agent_id: string; agent_status: string }[] {
		this.assertLive(caller);
		const prefix = pathPrefix === undefined ? "/root" : resolveTaskPath(this.agentPath(caller.sessionId), pathPrefix);
		const agents = [{ agent_name: "/root", agent_id: this.host.rootSessionId, agent_status: this.agentStatus(this.host.rootSessionId) },
			...this.listAgents(this.rootAuthority, "descendants").map(entry => ({
				agent_name: entry.kind === "child" ? this.agentPath(entry.id) : entry.id,
				agent_id: entry.id,
				agent_status: entry.kind === "child" ? entry.status : "error",
			}))];
		return agents.filter(agent => pathPrefix === undefined || agent.agent_name === prefix || agent.agent_name.startsWith(`${prefix}/`));
	}

	listAgents(caller: Authority, scope: "children" | "descendants" = "children"): AgentListEntry[] {
		this.assertLive(caller);
		const children = new Map<string, ChildRecord[]>();
		for (const record of this.records.values()) {
			const list = children.get(record.descriptor.parentSessionId) ?? [];
			list.push(record);
			children.set(record.descriptor.parentSessionId, list);
		}
		for (const list of children.values())
			list.sort(
				(a, b) =>
					a.descriptor.createdAt - b.descriptor.createdAt ||
					a.descriptor.childSessionId.localeCompare(b.descriptor.childSessionId),
			);
		const diagnosticsByParent = new Map<string, DiagnosticRecord[]>();
		for (const diagnostic of this.diagnostics.values()) {
			if (!diagnostic.parentSessionId) continue;
			const list = diagnosticsByParent.get(diagnostic.parentSessionId) ?? [];
			list.push(diagnostic);
			diagnosticsByParent.set(diagnostic.parentSessionId, list);
		}
		for (const list of diagnosticsByParent.values())
			list.sort((a, b) => a.id.localeCompare(b.id));
		const rows: AgentListEntry[] = [];
		const walk = (parentId: string, depth: number): void => {
			for (const record of children.get(parentId) ?? []) {
				const descriptor = record.descriptor;
				if (descriptor.mode === "continuable") {
					const status: "running" | "idle" | "ready" =
						record.opening || record.pump || record.activation?.current || record.activation?.driver.isRunning
							? "running" : record.activation || (!record.parked && record.queue.length) ? "idle" : "ready";
					rows.push({
						kind: "child",
						id: descriptor.childSessionId,
						label: descriptor.label,
						status,
						...(record.lastOutcome && record.lastOutcome.stopReason !== "completed"
							? { lastOutcome: record.lastOutcome.stopReason }
							: {}),
						...(record.lastError ? { errorMessage: record.lastError } : {}),
						...(scope === "descendants" ? { parent: parentId, depth } : {}),
					});
				}
				if (scope === "descendants") walk(descriptor.childSessionId, depth + 1);
			}
			for (const diagnostic of diagnosticsByParent.get(parentId) ?? []) {
				rows.push({
					kind: "diagnostic",
					id: diagnostic.id,
					reason: diagnostic.reason,
					...(scope === "descendants" ? { parent: parentId, depth } : {}),
				});
				if (scope === "descendants") walk(diagnostic.id, depth + 1);
			}
		};
		walk(caller.sessionId, 1);
		return rows;
	}

	snapshot(): RuntimeChildSnapshot[] {
		const children = [...this.records.values()]
			.map((record): RuntimeChildSnapshot => {
				let state: RuntimeChildSnapshot["state"];
				if (getWorkCoordinator(record.descriptor.childSessionId)?.waiting) state = "waiting";
				else if (record.opening || record.activation?.current || record.activation?.driver.isRunning)
					state = "running";
				else if (!record.parked && record.queue.length)
					state = "waiting";
				else state = statusForOutcome(record.lastOutcome);
				const activity = record.opening ? "starting" : !record.activation && this.openingFiles.has(record.manager.getSessionFile()!) ? "closing cancelled initialization" :
					record.activation?.driver.activity ?? record.activation?.current?.source;
				const activeDurationMs = record.activeDurationMs +
					(record.activation?.current?.startedAt !== undefined
						? Math.max(0, Date.now() - record.activation.current.startedAt)
						: 0);
				return {
					id: record.descriptor.childSessionId,
					parentId: record.descriptor.parentSessionId,
					label: record.descriptor.label,
					depth: record.descriptor.depth,
					mode: record.descriptor.mode,
					context: record.descriptor.context,
					state,
					canSteer: !!record.activation?.driver.isRunning,
					canStop: !!(record.opening || record.activation?.current),
					queued: record.queue.filter(item => !item.started && !item.cancelled).length,
					...(activity ? { activity } : {}),
					createdAt: record.descriptor.createdAt,
					updatedAt: record.updatedAt,
					...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
					model: `${record.descriptor.model.provider}/${record.descriptor.model.id}`,
					thinkingLevel: record.descriptor.thinkingLevel,
					sessionFile: record.manager.getSessionFile(),
					...(record.lastOutcome?.output
						? { lastOutput: record.lastOutcome.output }
						: {}),
					...(record.totalUsage ? { usage: record.totalUsage } : {}),
					activeDurationMs,
					...(record.lastError ? { errorMessage: record.lastError } : {}),
				};
			});
		const diagnostics = [...this.diagnostics.values()].map((diagnostic): RuntimeChildSnapshot => ({
			id: diagnostic.id,
			parentId: diagnostic.parentSessionId ?? this.host.rootSessionId,
			label: `${diagnostic.reason} subagent`,
			depth: 1,
			mode: "one-shot",
			context: "fresh",
			state: "error",
			createdAt: 0,
			updatedAt: 0,
			model: "unavailable",
			thinkingLevel: "off",
			activeDurationMs: 0,
			diagnosticReason: diagnostic.reason,
		}));
		return [...children, ...diagnostics]
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	hasLiveDescendants(caller: Authority): boolean {
		this.assertLive(caller);
		return this.hasLiveDescendantWork(caller.sessionId);
	}

	getSessionFile(childId: string): string | undefined {
		return this.records.get(childId)?.manager.getSessionFile();
	}

	toolNamesFor(caller: Authority): string[] {
		this.assertLive(caller);
		if (this.host.getActiveToolNames) return normalizeToolNames(this.host.getActiveToolNames());
		if (caller.sessionId === this.host.rootSessionId) return [];
		return [...(this.records.get(caller.sessionId)?.descriptor.toolNames ?? [])];
	}

	private requireAdmission(): void {
		if (this.maintenance || this.host.isSuspended?.()) throw new Error("The subagent runtime is held for maintenance.");
	}

	maintenanceScopes(): string[] { return [...this.records.keys()]; }

	async holdMaintenance(id: string): Promise<void> {
		if (this.maintenance) {
			if (this.maintenance.id !== id) throw new Error("Another checkpoint holds the subagents.");
			return;
		}
		this.checkpointReady();
		if (!this.host.saveMaintenance) throw new Error("The parent cannot save a subagent checkpoint.");
		const children = [...this.records.values()].filter(record => record.activation)
			.sort((a, b) => b.descriptor.depth - a.descriptor.depth);
		this.maintenance = { id, phase: "held", children: children.map(record => ({ id: record.descriptor.childSessionId,
			leaf: record.manager.getLeafId(), end: record.manager.getEntries().at(-1)?.id ?? null, running: !!record.activation?.driver.isRunning, parked: record.parked })) };
		this.host.saveMaintenance(this.maintenance);
		for (const batcher of this.noticeBatchers.values()) batcher.setPaused(true);
		for (const record of children) {
			this.setParked(record, true);
			if (record.activation!.driver.isRunning) this.maintenanceStopped.add(record.descriptor.childSessionId);
			record.activation!.driver.interrupt();
		}
		await Promise.all(children.map(record => record.pump));
		this.checkpointReady();
	}

	restoreMaintenance(id: string): void {
		const value = this.host.readMaintenance?.(id);
		if (value === undefined) {
			if ([...this.records.values()].some(record => record.queue.length)) throw new Error("No saved owner checkpoint confirms these queued child tasks.");
			return;
		}
		if (!isRecord(value) || value.id !== id || value.phase !== "final" || !Array.isArray(value.children))
			throw new Error("The subagent checkpoint has no confirmed final save.");
		const children: SubagentCheckpoint["children"] = [];
		for (const child of value.children) {
			if (!isRecord(child) || typeof child.id !== "string" || typeof child.running !== "boolean" || typeof child.parked !== "boolean" ||
				(child.leaf !== null && typeof child.leaf !== "string") || (child.end !== null && typeof child.end !== "string") || child.error || children.some(row => row.id === child.id))
				throw new Error("The saved subagent checkpoint needs manual recovery.");
			const record = this.records.get(child.id);
			if (!record || record.activation || record.opening || record.pump) throw new Error("The saved subagent is unavailable or already active.");
			if ((record.manager.getEntries().at(-1)?.id ?? null) !== child.end)
				throw new Error("Child history changed after its final checkpoint. Resume it manually without rewinding.");
			if (child.leaf === null) record.manager.resetLeaf();
			else {
				if (!record.manager.getEntry(child.leaf)) throw new Error("The saved child branch position is unavailable.");
				record.manager.branch(child.leaf);
			}
			const saved = recoverChildState(record.manager.getBranch());
			Object.assign(record, saved, { lastOutcome: saved.lastOutcome, settlementOutcome: saved.settlementOutcome,
				lastError: saved.lastError, finishedAt: saved.finishedAt, totalUsage: saved.totalUsage,
				pendingSettlement: (record.descriptor.mode === "continuable" || saved.maintenanceSettlement) && saved.needsSettlement });
			children.push({ id: child.id, leaf: child.leaf, end: child.end, running: child.running, parked: child.parked });
		}
		this.maintenance = { id, phase: "final", children };
	}

	async releaseMaintenance(id: string): Promise<void> {
		const saved = this.maintenance;
		if (!saved || saved.id !== id) return;
		// A failed initial save may leave background work untouched. Do not add
		// a later Continue to a task that never stopped or finished naturally.
		if (saved.phase === "held") for (const child of saved.children) {
			const record = this.records.get(child.id)!;
			child.running &&= this.maintenanceStopped.has(child.id) ||
				!record.activation?.driver.isRunning && record.lastOutcome?.stopReason === "aborted";
		}
		// Inspect every receipt before admitting any resumed work.
		for (const child of saved.children) if (child.running) {
			const record = this.records.get(child.id)!;
			const messageId = this.maintenanceMessage(id, child.id);
			const branch = record.manager.getBranch();
			const started = branch.some(entry => entry.type === "custom" && entry.customType === DELIVERY_ENTRY && isRecord(entry.data) && entry.data.messageId === messageId && entry.data.action === "started");
			const finished = branch.some(entry => entry.type === "custom" && entry.customType === DELIVERY_ENTRY && isRecord(entry.data) && entry.data.messageId === messageId && (entry.data.action === "finished" || entry.data.action === "failed"));
			if (started && !finished) throw new Error("A child continuation has an unconfirmed admission. Resume it manually.");
		}
		for (const child of saved.children) {
			const record = this.records.get(child.id)!;
			if (child.running) {
				const messageId = this.maintenanceMessage(id, child.id);
				if (!record.manager.getBranch().some(entry => entry.type === "custom" && entry.customType === INBOX_ENTRY && isRecord(entry.data) && entry.data.messageId === messageId))
					this.accept(record, "Continue", "maintenance", messageId);
				record.pendingSettlement = true;
				record.maintenanceSettlement = true;
			}
			this.setParked(record, child.running ? false : child.parked);
		}
		this.host.saveMaintenance?.({ ...saved, phase: "released" });
		this.maintenance = undefined;
		this.maintenanceStopped.clear();
		for (const batcher of this.noticeBatchers.values()) batcher.setPaused(false);
		for (const child of saved.children) if (child.running) this.startPump(this.records.get(child.id)!);
		this.emit();
	}

	private maintenanceMessage(id: string, child: string): string {
		return `maintenance-${createHash("sha256").update(`${id}\0${child}`).digest("hex")}`;
	}

	checkpointReady(): void {
		if (this.closing || !this.initialized) throw new Error("Wait for the subagent runtime to open before updating.");
		for (const record of this.records.values()) {
			if (record.opening || record.disposing)
				throw new Error(`Wait for subagent "${record.descriptor.label}" to finish opening or closing before updating.`);
			if (record.queue.some(item => item !== record.activation?.current &&
				!(record.activation?.current && item.delivery === "boundary" && item.started)))
				throw new Error(`Finish queued tasks for subagent "${record.descriptor.label}" before updating.`);
			if (record.activation) {
				if (!record.activation.driver.checkpointReady)
					throw new Error(`Subagent "${record.descriptor.label}" has no owning-driver maintenance checkpoint.`);
				record.activation.driver.checkpointReady();
			}
		}
	}

	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		for (const batcher of this.noticeBatchers.values()) batcher.close();
		this.noticeBatchers.clear();
		const active = [...this.records.values()]
			.filter((record) => record.activation || record.pump || record.disposing)
			.sort((a, b) => b.descriptor.depth - a.descriptor.depth);
		for (const record of active) {
			try {
				record.opening?.abort();
				record.activation?.driver.interrupt();
			} catch (error) {
				record.lastError = error instanceof Error ? error.message : String(error);
			}
		}
		await Promise.allSettled(active.map((record) => record.pump).filter(Boolean));
		for (const record of active) {
			const failure = await this.disposeActivation(record);
			if (failure) {
				record.lastError = failure instanceof Error ? failure.message : String(failure);
				const saved = this.maintenance?.children.find(child => child.id === record.descriptor.childSessionId);
				if (saved) saved.error = record.lastError;
			}
		}
		if (this.maintenance) this.host.saveMaintenance?.({ ...this.maintenance, phase: "final",
			children: this.maintenance.children.map(child => ({ ...child, leaf: this.records.get(child.id)!.manager.getLeafId(),
				end: this.records.get(child.id)!.manager.getEntries().at(-1)?.id ?? null })) });
		this.authorities.clear();
		this.listeners.clear();
		this.transcriptListeners.clear();
		this.shutdownFinished = true;
		for (const file of this.leases.keys()) if (!this.openingFiles.has(file)) this.releaseFile(file);
	}
}

export function selectedAssistantText(entries: readonly SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const text = textOfAssistant(entries[index] as SessionEntry);
		if (text) return text;
	}
	return "";
}

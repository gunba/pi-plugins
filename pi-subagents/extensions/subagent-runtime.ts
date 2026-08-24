import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ModelRuntime,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const DESCRIPTOR_ENTRY = "pi-subagents/descriptor-v1";
export const INBOX_ENTRY = "pi-subagents/inbox-v1";
export const DELIVERY_ENTRY = "pi-subagents/delivery-v1";
export const LAUNCH_ENTRY = "pi-subagents/launch-v1";
export const SETTLEMENT_ENTRY = "pi-subagents/settlement-v1";
export const CONTROL_ENTRY = "pi-subagents/control-v1";
export const DESCRIPTOR_VERSION = 1;
export const DEFAULT_MAX_DEPTH = 3;
export const MAX_PARENT_NOTICE_BYTES = 32 * 1024;

export const CHILD_BUILTIN_TOOL_NAMES = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

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

export type ChildDescriptor = {
	version: 1;
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
	output: string;
	stopReason: RunStopReason;
	errorMessage?: string;
	usage?: {
		input: number;
		output: number;
		contextTokens: number;
		cost: number;
	};
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
};

export type StartRequest = {
	description: string;
	prompt: string;
	context: ChildContextMode;
	runInBackground: boolean;
	parent: ParentInvocation;
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
	messageId: string;
	kind: "report" | "settlement";
	childId: string;
	content: string;
};

export interface RuntimeHost {
	readonly rootSessionId: string;
	readonly rootSessionFile?: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly activeRootLaunchIds: ReadonlySet<string>;
	recordRootLaunch(childId: string): void;
	/** Queue a root notice and return true only when that exact notice is already durable in the root branch. */
	deliverRootNotice(notice: ParentNotice): boolean;
	resolveModel(ref: ModelRef): Model<any> | undefined;
	prepareModelRuntime?(ref: ModelRef, runtime: ModelRuntime): Promise<void>;
}

export interface ChildDriver {
	readonly sessionFile?: string;
	readonly isRunning: boolean;
	readonly activity?: string;
	subscribeActivity?(listener: () => void): () => void;
	prompt(message: string): Promise<RunOutcome>;
	interrupt(): void;
	dispose(): void;
}

export interface ChildDriverFactory {
	open(input: {
		descriptor: ChildDescriptor;
		sessionManager: SessionManager;
		authority: Authority;
		customTools: ToolDefinition[];
	}): Promise<ChildDriver>;
}

export type ChildToolFactory = (
	runtime: SubagentRuntime,
	authority: Authority,
	mode: ChildMode,
) => ToolDefinition[];

type QueueSource = "initial" | "followup" | "report" | "settlement";

type QueueItem = {
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
	authority: Authority;
	driver: ChildDriver;
	unsubscribeActivity?: () => void;
	current?: QueueItem;
	interrupted: boolean;
};

type ChildRecord = {
	descriptor: ChildDescriptor;
	manager: SessionManager;
	queue: QueueItem[];
	activation?: Activation;
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
	contextEntries: readonly SessionEntry[],
	target: SessionManager,
	toolCallId: string,
): string | undefined {
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
	if (boundary < 0) return undefined;

	for (const entry of contextEntries.slice(0, boundary + 1)) {
		if (
			entry.type === "message" &&
			(entry.message.role === "user" ||
				entry.message.role === "assistant" ||
				entry.message.role === "toolResult" ||
				entry.message.role === "bashExecution")
		) {
			target.appendMessage(
				entry.message as Parameters<SessionManager["appendMessage"]>[0],
			);
		} else if (entry.type === "custom_message") {
			target.appendCustomMessageEntry(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
			);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			target.appendCustomMessageEntry(
				"pi-subagents/fork-summary-v1",
				`Parent context summary:\n${entry.summary}`,
				false,
				{ sourceEntryId: entry.id, sourceType: entry.type },
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
		version: 1,
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
	pendingSettlementNotices: ParentNotice[];
};

function parseUsage(value: unknown): RunOutcome["usage"] | undefined {
	if (!isRecord(value)) return undefined;
	const { input, output, contextTokens, cost } = value;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof contextTokens !== "number" ||
		typeof cost !== "number"
	) return undefined;
	return { input, output, contextTokens, cost };
}

function addUsage(
	left: RunOutcome["usage"] | undefined,
	right: RunOutcome["usage"] | undefined,
): RunOutcome["usage"] | undefined {
	if (!left) return right ? { ...right } : undefined;
	if (!right) return { ...left };
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		contextTokens: Math.max(left.contextTokens, right.contextTokens),
		cost: left.cost + right.cost,
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
	};
}

function recoverChildState(entries: readonly SessionEntry[]): RecoveredChildState {
	const accepted = new Map<string, QueueItem>();
	const consumed = new Set<string>();
	const startedAt = new Map<string, number>();
	const pendingNotices = new Map<string, ParentNotice>();
	let lastOutcome: RunOutcome | undefined;
	let settlementOutcome: RunOutcome | undefined;
	let totalUsage: RunOutcome["usage"] | undefined;
	let activeDurationMs = 0;
	let lastError: string | undefined;
	let updatedAt: number | undefined;
	let finishedAt: number | undefined;
	let parked = false;
	let needsSettlement = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		if (entry.customType === CONTROL_ENTRY && (entry.data.action === "parked" || entry.data.action === "unparked"))
			parked = entry.data.action === "parked";
		if (entry.customType === INBOX_ENTRY && entry.data.action === "accepted") {
			const { messageId, content, source, acceptedAt } = entry.data;
			if (typeof messageId === "string" && typeof content === "string" &&
				(source === "initial" || source === "followup" || source === "report" || source === "settlement") &&
				typeof acceptedAt === "number") {
				accepted.set(messageId, { messageId, content, source, acceptedAt, started: false });
				updatedAt = Math.max(updatedAt ?? 0, acceptedAt);
			}
		}
		if (entry.customType === DELIVERY_ENTRY && entry.data.action === "started" &&
			typeof entry.data.messageId === "string" && typeof entry.data.startedAt === "number")
			startedAt.set(entry.data.messageId, entry.data.startedAt);
		if (entry.customType === DELIVERY_ENTRY && typeof entry.data.messageId === "string" &&
			(entry.data.action === "finished" || entry.data.action === "failed")) {
			consumed.add(entry.data.messageId);
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
			settlementOutcome = mergeSettlementOutcome(settlementOutcome, terminalOutcome);
			totalUsage = addUsage(totalUsage, terminalOutcome.usage);
			needsSettlement = true;
		}
		if (entry.customType === SETTLEMENT_ENTRY) {
			if (entry.data.action === "pending") {
				const notice = parseParentNotice(entry.data.notice);
				if (notice) {
					pendingNotices.set(notice.messageId, notice);
					if (notice.kind === "settlement") {
						needsSettlement = false;
						settlementOutcome = undefined;
					}
				}
			} else if (entry.data.action === "delivered" && typeof entry.data.messageId === "string") {
				pendingNotices.delete(entry.data.messageId);
			}
		}
	}
	return {
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
): SessionManager {
	mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const file = join(
		sessionDir,
		`${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
	);
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
		{ flag: "wx" },
	);
	return SessionManager.open(file, sessionDir, cwd);
}

function normalizeToolNames(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) =>
		CHILD_BUILTIN_TOOL_NAMES.has(name) || name === "todo_write",
	))].sort();
}

export class SubagentRuntime {
	readonly rootAuthority: Authority;
	readonly maxDepth: number;
	private readonly records = new Map<string, ChildRecord>();
	private readonly diagnostics = new Map<string, DiagnosticRecord>();
	private readonly authorities = new Map<string, Authority>();
	private readonly listeners = new Set<() => void>();
	private readonly generation = randomUUID();
	private closing = false;
	readonly host: RuntimeHost;
	private readonly driverFactory: ChildDriverFactory;
	private readonly childToolFactory: ChildToolFactory;

	constructor(
		host: RuntimeHost,
		driverFactory: ChildDriverFactory,
		childToolFactory: ChildToolFactory,
		options: { sessionDir?: string; maxDepth?: number } = {},
	) {
		this.host = host;
		this.driverFactory = driverFactory;
		this.childToolFactory = childToolFactory;
		this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
		if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 0)
			throw new Error("maxDepth must be a non-negative safe integer");
		this.sessionDir =
			options.sessionDir ?? join(host.agentDir, "subagents", "sessions");
		this.rootAuthority = this.issueAuthority(host.rootSessionId, 0);
	}

	readonly sessionDir: string;

	initialize(): void {
		mkdirSync(this.sessionDir, { recursive: true });
		this.loadCatalog();
		for (const record of this.records.values()) {
			this.retryPendingSettlements(record);
			if (record.queue.length > 0 && !record.parked) {
				record.pendingSettlement = record.descriptor.mode === "continuable";
				this.startPump(record);
			} else if (record.queue.length === 0 && record.pendingSettlement) {
				this.setParked(record, false);
				this.startPump(record);
			}
		}
		this.emit();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
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

	private loadCatalog(): void {
		this.records.clear();
		this.diagnostics.clear();
		const candidates: ChildRecord[] = [];
		for (const name of readdirSync(this.sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(this.sessionDir, name);
			try {
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
				const recovered = recoverChildState(branch);
				candidates.push({
					descriptor,
					manager,
					queue: recovered.queue,
					parked: recovered.parked,
					updatedAt: recovered.updatedAt ?? descriptor.createdAt,
					...(recovered.finishedAt !== undefined ? { finishedAt: recovered.finishedAt } : {}),
					...(recovered.lastOutcome ? { lastOutcome: recovered.lastOutcome } : {}),
					...(recovered.settlementOutcome ? { settlementOutcome: recovered.settlementOutcome } : {}),
					...(recovered.totalUsage ? { totalUsage: recovered.totalUsage } : {}),
					activeDurationMs: recovered.activeDurationMs,
					...(recovered.lastError ? { lastError: recovered.lastError } : {}),
					pendingSettlement: descriptor.mode === "continuable" && recovered.needsSettlement,
					pendingSettlementNotices: recovered.pendingSettlementNotices,
				});
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
			}
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
		this.assertLive(request.parent.authority);
		if (request.parent.authority.depth >= this.maxDepth)
			throw new Error(`subagent depth limit ${this.maxDepth} reached`);
		if (!request.parent.model) throw new Error("subagent requires an active parent model");
		if (request.signal?.aborted) throw abortError();
		const label = normalizeLabel(request.description);
		const prompt = normalizePrompt(request.prompt);
		const childId = randomUUID();
		const mode: ChildMode = request.runInBackground ? "continuable" : "one-shot";
		let manager: SessionManager | undefined;
		let record: ChildRecord | undefined;
		let item: QueueItem | undefined;
		try {
			manager = createDurableChildSession(
				request.parent.cwd,
				this.sessionDir,
				childId,
				request.parent.sessionManager.getSessionFile(),
			);
			const forkBoundaryEntryId =
				request.context === "fork"
					? copyCompletedParentTurns(
							request.parent.sessionManager.buildContextEntries(),
							manager,
							request.parent.toolCallId,
						)
					: undefined;
			const descriptor: ChildDescriptor = {
				version: 1,
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
				model: {
					provider: request.parent.model.provider,
					id: request.parent.model.id,
				},
				thinkingLevel: request.parent.thinkingLevel ?? "medium",
				toolNames: normalizeToolNames(request.parent.toolNames),
				...(forkBoundaryEntryId ? { forkBoundaryEntryId } : {}),
			};
			manager.appendCustomEntry(DESCRIPTOR_ENTRY, descriptor);
			record = {
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
				if (record.activation?.current === item)
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
	): QueueItem {
		const queued = record.queue.find((item) => item.messageId === messageId);
		if (queued) return queued;
		const item: QueueItem = {
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

	sendMessage(caller: Authority, childId: string, message: string): string {
		if (this.closing) throw new Error("subagent runtime is shutting down");
		this.assertLive(caller);
		const record = this.records.get(childId);
		if (!record || record.descriptor.mode !== "continuable")
			throw new Error(`subagent "${childId}" is not resumable`);
		if (record.descriptor.parentSessionId !== caller.sessionId)
			throw new Error("send_message is restricted to the exact live direct parent");
		const item = this.accept(record, normalizePrompt(message), "followup");
		this.setParked(record, false);
		if (!record.pendingSettlement) record.settlementOutcome = undefined;
		record.pendingSettlement = true;
		this.startPump(record);
		this.emit();
		return item.messageId;
	}

	interrupt(caller: Authority, targetId: string): boolean {
		this.assertLive(caller);
		if (caller.sessionId === targetId)
			throw new Error("an agent cannot interrupt itself");
		const record = this.records.get(targetId);
		if (!record) return true;
		let parentId = record.descriptor.parentSessionId;
		let authorized = parentId === caller.sessionId;
		while (!authorized && parentId !== this.host.rootSessionId) {
			const parent = this.records.get(parentId);
			if (!parent) break;
			parentId = parent.descriptor.parentSessionId;
			authorized = parentId === caller.sessionId;
		}
		if (!authorized)
			throw new Error("interrupt_agent requires an exact live ancestor");
		if (record.activation?.current) {
			record.activation.interrupted = true;
			this.setParked(record, true);
			record.activation.driver.interrupt();
		}
		return true;
	}

	report(caller: Authority, output: string): string {
		this.assertLive(caller);
		const record = this.records.get(caller.sessionId);
		if (
			!record ||
			record.descriptor.mode !== "continuable" ||
			record.activation?.authority !== caller
		)
			throw new Error("report requires the exact live continuable child");
		const notice: ParentNotice = {
			messageId: randomUUID(),
			kind: "report",
			childId: caller.sessionId,
			content: truncateForParent(
				`Background subagent ${caller.sessionId} reported:\n${normalizePrompt(output)}`,
			),
		};
		record.manager.appendCustomEntry(SETTLEMENT_ENTRY, {
			action: "pending",
			notice,
			createdAt: Date.now(),
		});
		record.pendingSettlementNotices.push(notice);
		this.retryPendingSettlements(record);
		return notice.messageId;
	}

	private deliverNotice(parentId: string, notice: ParentNotice): boolean {
		if (this.closing) return false;
		if (parentId === this.host.rootSessionId) {
			return this.host.deliverRootNotice(notice);
		}
		const parent = this.records.get(parentId);
		if (!parent) return false;
		if (parent.descriptor.mode === "one-shot" && !parent.activation) {
			const sender = this.records.get(notice.childId);
			if (sender?.descriptor.parentSessionId !== parentId) return false;
		}
		const alreadyAccepted = parent.manager.getBranch().some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === INBOX_ENTRY &&
				isRecord(entry.data) &&
				entry.data.action === "accepted" &&
				entry.data.messageId === notice.messageId,
		);
		if (alreadyAccepted) return true;
		this.accept(parent, notice.content, notice.kind, notice.messageId);
		this.setParked(parent, false);
		if (!parent.pendingSettlement) parent.settlementOutcome = undefined;
		parent.pendingSettlement = parent.descriptor.mode === "continuable";
		this.startPump(parent);
		return true;
	}

	acknowledgeRootNotice(messageId: string): void {
		for (const record of this.records.values()) {
			if (!record.pendingSettlementNotices.some((notice) => notice.messageId === messageId))
				continue;
			record.manager.appendCustomEntry(SETTLEMENT_ENTRY, {
				action: "delivered",
				messageId,
				deliveredAt: Date.now(),
			});
			record.pendingSettlementNotices = record.pendingSettlementNotices.filter(
				(notice) => notice.messageId !== messageId,
			);
		}
	}

	private retryPendingSettlements(record: ChildRecord): void {
		for (const notice of [...record.pendingSettlementNotices]) {
			try {
				if (!this.deliverNotice(record.descriptor.parentSessionId, notice)) continue;
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
			}
		}
	}

	private startPump(record: ChildRecord): void {
		if (record.pump || record.parked || this.closing) return;
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
					await this.settleAncestors(record.descriptor.parentSessionId);
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

	private async settleAncestors(parentId: string): Promise<void> {
		let current = this.records.get(parentId);
		while (current && !current.pump) {
			await this.maybeSettle(current);
			if (
				current.queue.length > 0 ||
				current.pump ||
				this.hasLiveChildren(current.descriptor.childSessionId)
			) return;
			current = this.records.get(current.descriptor.parentSessionId);
		}
	}

	private async ensureActivation(record: ChildRecord): Promise<Activation> {
		if (record.activation) return record.activation;
		const authority = this.issueAuthority(
			record.descriptor.childSessionId,
			record.descriptor.depth,
		);
		try {
			const customTools = this.childToolFactory(
				this,
				authority,
				record.descriptor.mode,
			);
			const driver = await this.driverFactory.open({
				descriptor: record.descriptor,
				sessionManager: record.manager,
				authority,
				customTools,
			});
			if (this.closing) {
				driver.dispose();
				this.authorities.delete(authority.sessionId);
				throw new Error("subagent runtime shut down while opening a child activation");
			}
			const activation: Activation = { authority, driver, interrupted: false };
			activation.unsubscribeActivity = driver.subscribeActivity?.(() => {
				record.updatedAt = Date.now();
				this.emit();
			});
			record.activation = activation;
			return activation;
		} catch (error) {
			this.authorities.delete(authority.sessionId);
			throw error;
		}
	}

	private finishCancelledItem(record: ChildRecord, item: QueueItem): void {
		const outcome: RunOutcome = { output: "", stopReason: "aborted" };
		const finishedAt = Date.now();
		record.lastOutcome = outcome;
		record.lastError = undefined;
		record.updatedAt = finishedAt;
		record.finishedAt = finishedAt;
		this.setParked(record, true);
		record.manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "finished",
			messageId: item.messageId,
			finishedAt,
			stopReason: outcome.stopReason,
			output: outcome.output,
		});
		record.queue.shift();
		record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, outcome);
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
		while (!this.closing && !record.parked && record.queue.length > 0) {
			const item = record.queue[0];
			if (!item) break;
			if (item.cancelled) {
				this.finishCancelledItem(record, item);
				break;
			}
			let activation: Activation;
			try {
				activation = await this.ensureActivation(record);
				if (this.closing) break;
			} catch (error) {
				this.failQueuedActivation(record, error);
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
				startedAt: item.startedAt,
			});
			record.updatedAt = Date.now();
			this.emit();
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
			record.lastOutcome = outcome;
			record.settlementOutcome = mergeSettlementOutcome(record.settlementOutcome, outcome);
			record.totalUsage = addUsage(record.totalUsage, outcome.usage);
			record.lastError = outcome.errorMessage;
			record.updatedAt = Date.now();
			record.finishedAt = record.updatedAt;
			if (item.startedAt !== undefined)
				record.activeDurationMs += Math.max(0, record.finishedAt - item.startedAt);
			record.manager.appendCustomEntry(DELIVERY_ENTRY, {
				action: "finished",
				messageId: item.messageId,
				finishedAt: record.finishedAt,
				stopReason: outcome.stopReason,
				output: outcome.output,
				...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
				...(outcome.usage ? { usage: outcome.usage } : {}),
			});
			record.queue.shift();
			activation.current = undefined;
			item.resolve?.(outcome);
			if (outcome.stopReason === "aborted" && activation.interrupted)
				this.setParked(record, true);
		}
		await this.maybeSettle(record);
	}

	private hasLiveChildren(parentId: string): boolean {
		for (const record of this.records.values()) {
			if (
				record.descriptor.parentSessionId === parentId &&
				(record.activation || record.queue.length > 0)
			)
				return true;
		}
		return false;
	}

	private async disposeActivation(record: ChildRecord): Promise<unknown | undefined> {
		const activation = record.activation;
		if (!activation) return undefined;
		let failure: unknown;
		try {
			activation.unsubscribeActivity?.();
		} catch (error) {
			failure = error;
		}
		try {
			activation.driver.dispose();
		} catch (error) {
			failure ??= error;
		} finally {
			this.authorities.delete(activation.authority.sessionId);
			record.activation = undefined;
		}
		return failure;
	}

	private async maybeSettle(record: ChildRecord): Promise<void> {
		if (record.queue.length > 0 || this.hasLiveChildren(record.descriptor.childSessionId)) {
			this.emit();
			return;
		}
		this.retryPendingSettlements(record);
		const cleanupFailure = await this.disposeActivation(record);
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
				finishedAt: Date.now(),
				error: message,
			});
		}
		if (record.pendingSettlement && record.descriptor.mode === "continuable") {
			const outcome = record.settlementOutcome ?? record.lastOutcome ?? {
				output: "",
				stopReason: "completed" as const,
			};
			const detail = outcome.output ? `\nFinal assistant message:\n${outcome.output}` : "";
			const notice: ParentNotice = {
				messageId: randomUUID(),
				kind: "settlement",
				childId: record.descriptor.childSessionId,
				content: truncateForParent(
					`Background subagent ${record.descriptor.childSessionId} settled with ${outcome.stopReason}.${detail}`,
				),
			};
			record.manager.appendCustomEntry(SETTLEMENT_ENTRY, {
				action: "pending",
				notice,
				createdAt: Date.now(),
			});
			record.pendingSettlementNotices.push(notice);
			record.pendingSettlement = false;
			record.settlementOutcome = undefined;
			this.retryPendingSettlements(record);
		}
		this.emit();
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
					const status: "running" | "idle" | "ready" = record.activation
						? record.activation.current || record.activation.driver.isRunning
							? "running"
							: "idle"
						: "ready";
					rows.push({
						kind: "child",
						id: descriptor.childSessionId,
						label: descriptor.label,
						status,
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
				if (record.activation?.current || record.activation?.driver.isRunning)
					state = "running";
				else if (
					record.activation &&
					this.hasLiveChildren(record.descriptor.childSessionId)
				)
					state = "waiting";
				else state = statusForOutcome(record.lastOutcome);
				const activity =
					record.activation?.driver.activity ??
					record.activation?.current?.source;
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
		return this.hasLiveChildren(caller.sessionId);
	}

	getSessionFile(childId: string): string | undefined {
		return this.records.get(childId)?.manager.getSessionFile();
	}

	toolNamesFor(caller: Authority): string[] {
		this.assertLive(caller);
		if (caller.sessionId === this.host.rootSessionId) return [];
		return [...(this.records.get(caller.sessionId)?.descriptor.toolNames ?? [])];
	}

	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		const active = [...this.records.values()]
			.filter((record) => record.activation || record.pump)
			.sort((a, b) => b.descriptor.depth - a.descriptor.depth);
		for (const record of active) {
			try {
				record.activation?.driver.interrupt();
			} catch (error) {
				record.lastError = error instanceof Error ? error.message : String(error);
			}
		}
		await Promise.allSettled(active.map((record) => record.pump).filter(Boolean));
		for (const record of active) {
			const failure = await this.disposeActivation(record);
			if (failure) record.lastError = failure instanceof Error ? failure.message : String(failure);
		}
		this.authorities.clear();
		this.listeners.clear();
	}
}

export function selectedAssistantText(entries: readonly SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const text = textOfAssistant(entries[index] as SessionEntry);
		if (text) return text;
	}
	return "";
}

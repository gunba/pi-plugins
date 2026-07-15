// pi-subagents — background pi processes as a coordinated team.
//
// Each subagent is a fresh `pi --print` child with the installed tool stack and
// one task. A filesystem mailbox provides spawn, message, wait, and kill primitives.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import {
	spawn as spawnChild,
	spawnSync,
	type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	SubagentDashboard,
	orchestrationSummary,
	type DashboardAction,
	type DashboardSnapshot,
} from "./subagent-dashboard.ts";
import { terminalRunCanHide } from "./run-lifecycle.ts";
import { readSessionTranscript } from "./session-transcript.ts";
import {
	nextProgressDeadline,
	stalledProgress,
	type ProgressObservation,
} from "./subagent-liveness.ts";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

function positiveEnvInt(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const BASE =
	process.env.PI_SUBAGENTS_DIR || join(homedir(), ".pi", "agent", "subagents");
const VIEW_KEY = "pi-subagents";
const REFRESH_MS = 1000;
const INBOX_FALLBACK_MS = 5000;
const STALL_TIMEOUT_MS =
	positiveEnvInt("PI_SUBAGENTS_STALL_TIMEOUT_MS") ?? 600_000;
const PROGRESS_HEARTBEAT_MIN_MS = 5_000;
const RUN_TTL_MS = positiveEnvInt("PI_SUBAGENTS_RUN_TTL_MS") ?? 86_400_000; // sweep runs older than 24h
const FEED_TAIL = positiveEnvInt("PI_SUBAGENTS_FEED_TAIL") ?? 8;
const MAX_ACTIVE_CHILDREN = positiveEnvInt("PI_SUBAGENTS_MAX_ACTIVE") ?? 12;
const AUTO_RECOVERY_PROMPT = "Continue";
const RECOVERY_SUMMARY_PROMPT =
	"Review the conversation and return the best available result for the original delegated task. Summarize completed work, evidence, unresolved issues, and why execution stopped. Do not continue implementation or call tools.";
const ASSISTANT_PREVIEW_MAX = 2000;
const ROOT_TASK_PATH = "/root";
const RUN_SCHEMA_VERSION = 2;
const COORDINATION_NOTICE = "Delegated work is pending. Call wait_agent.";
const INACTIVE = new Set(["completed", "error", "interrupted", "hard_killed"]);
const RECOVERING = new Set([
	"restart_requested",
	"summary_requested",
	"restarting",
	"summarizing",
]);

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type SpawnApproval = {
	type: "spawn";
	taskName: string;
	taskPath: string;
	message: string;
	thinking?: ThinkingLevel;
};

type Beacon = {
	name: string;
	taskId: string;
	parent: string | null;
	taskName: string;
	task?: string;
	state: string;
	activity?: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	responses?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	contextTokens?: number;
	cost?: number;
	model?: string;
	thinking?: ThinkingLevel;
	lastAssistantText?: string;
	generation?: number;
	resultFile?: string;
	errorMessage?: string;
	recoveryStage?: RecoveryStage;
};

type RecoveryStage =
	| "idle"
	| "continued_once"
	| "continued_twice"
	| "restarted"
	| "summarizing";

type AssistantStatus = {
	stopReason?: string;
	errorMessage?: string;
};

type ExitRecovery = {
	prompt: string;
	stage: "restarted" | "summarizing";
};

type Mail = {
	id: string;
	from: string;
	to: string;
	body: string;
	replyTo?: string;
	kind?: "request" | "completion" | "attention" | "notice";
	topic?: "stalled";
	taskPaths?: string[];
	approval?: SpawnApproval;
	approved?: boolean;
	ts: number;
};

type TeamEvent = {
	message: string;
	kind?: Mail["kind"];
	topic?: Mail["topic"];
	from?: string;
	taskPaths?: string[];
};

type PendingQuestion = {
	from: string;
	id: string;
	body: string;
	approval?: SpawnApproval;
};

function exitRecovery(beacon: Beacon | undefined): ExitRecovery | undefined {
	if (
		!beacon ||
		INACTIVE.has(beacon.state) ||
		beacon.recoveryStage === "summarizing"
	)
		return undefined;
	if (beacon.state === "restart_requested")
		return { prompt: AUTO_RECOVERY_PROMPT, stage: "restarted" };
	if (
		beacon.state === "summary_requested" ||
		beacon.recoveryStage === "restarted"
	)
		return { prompt: RECOVERY_SUMMARY_PROMPT, stage: "summarizing" };
	return { prompt: AUTO_RECOVERY_PROMPT, stage: "restarted" };
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

const now = () => Date.now();
const rid = () => randomUUID();
const ensureDir = (p: string) => mkdirSync(p, { recursive: true });

function isWhitespace(character: string): boolean {
	return character.trim().length === 0;
}

function collapseWhitespace(value: string): string {
	let result = "";
	let separator = false;
	for (const character of value) {
		if (isWhitespace(character)) {
			separator = result.length > 0;
			continue;
		}
		if (separator) result += " ";
		result += character;
		separator = false;
	}
	return result;
}

function splitWords(value: string): string[] {
	const collapsed = collapseWhitespace(value);
	return collapsed ? collapsed.split(" ") : [];
}

function isTaskName(value: string): boolean {
	if (!value) return false;
	for (const character of value) {
		const code = character.charCodeAt(0);
		const lowercase = code >= 97 && code <= 122;
		const digit = code >= 48 && code <= 57;
		if (!lowercase && !digit && character !== "_") return false;
	}
	return true;
}

function timestampSegment(value: string): string {
	return value.replaceAll(":", "-").replaceAll(".", "-");
}

function taskId(): string {
	return `task-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function allocateTaskId(): string {
	const dir = join(ensureRun(), ".tasks");
	ensureDir(dir);
	for (let attempt = 0; attempt < 10; attempt++) {
		const id = taskId();
		try {
			writeFileSync(join(dir, id), "", { flag: "wx" });
			return id;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Could not allocate a unique subagent task id.");
}

export function normalizeTaskName(value: string): string {
	const taskName = value.trim();
	if (
		!taskName ||
		taskName === "root" ||
		taskName === "." ||
		taskName === ".." ||
		!isTaskName(taskName)
	) {
		throw new Error(
			'task_name must contain only lowercase ASCII letters, digits, and underscores, and cannot be "root", ".", or "..".',
		);
	}
	return taskName;
}

export function childTaskPath(parentPath: string, taskName: string): string {
	return `${parentPath}/${normalizeTaskName(taskName)}`;
}

export function taskStorageKey(taskPath: string): string {
	return createHash("sha256").update(taskPath, "utf8").digest("base64url");
}

export function taskSummary(task: string): string {
	return collapseWhitespace(task).slice(0, 160);
}

function writeJsonAtomic(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${rid()}.tmp`;
	writeFileSync(temp, JSON.stringify(value), { flag: "wx" });
	renameSync(temp, path);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// The subagent's final answer. It is never inlined into mailbox messages:
// write it to a result file so the parent chooses when to spend context on it.
function assistantTextFromMessage(message: unknown): string {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant") return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return (m.content as { type?: string; text?: string }[])
			.filter((b) => b?.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
	}
	return "";
}

function lastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantTextFromMessage(messages[i]);
		if (text) return text;
	}
	return "";
}

function finalAssistantStatus(messages: unknown[]): AssistantStatus {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
		};
		if (m?.role === "assistant")
			return { stopReason: m.stopReason, errorMessage: m.errorMessage };
	}
	return {};
}

function statusNeedsAttention(status: AssistantStatus): boolean {
	return (
		!status.stopReason ||
		status.stopReason === "error" ||
		status.stopReason === "aborted" ||
		!!status.errorMessage
	);
}

function isSuccessfulAssistantStatus(status: AssistantStatus): boolean {
	return !statusNeedsAttention(status);
}

function safeFileSegment(value: string): string {
	let result = "";
	let separator = false;
	for (const character of value) {
		const code = character.charCodeAt(0);
		const allowed =
			(code >= 48 && code <= 57) ||
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			character === "." ||
			character === "_" ||
			character === "-";
		if (!allowed) {
			separator = result.length > 0;
			continue;
		}
		if (separator) result += "-";
		result += character;
		separator = false;
		if (result.length === 80) break;
	}
	return result || "subagent";
}

function resultDir(): string {
	return join(runDir, "results");
}

function writeResultFile(name: string, messages: unknown[]): string {
	ensureDir(resultDir());
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const task = beacon?.task || beacon?.taskName;
	const stamp = timestampSegment(new Date().toISOString());
	const path = join(
		resultDir(),
		`${stamp}_${safeFileSegment(name)}_g${beacon?.generation ?? 1}_${rid().slice(0, 8)}.md`,
	);
	const status = finalAssistantStatus(messages);
	const body =
		lastAssistantText(messages) ||
		status.errorMessage ||
		(statusNeedsAttention(status) ? "(needs attention)" : "(completed)");
	const header = [
		`# Subagent result: ${name}`,
		"",
		task ? `Task: ${task}` : undefined,
		beacon?.parent ? `Parent: ${beacon.parent}` : undefined,
		`Generation: ${beacon?.generation ?? 1}`,
		status.stopReason ? `Stop reason: ${status.stopReason}` : undefined,
		status.errorMessage ? `Error: ${status.errorMessage}` : undefined,
		`Finished: ${new Date().toISOString()}`,
		"",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	writeFileSync(path, `${header}${body.endsWith("\n") ? body : `${body}\n`}`);
	return path;
}

function resultReadyMessage(
	name: string,
	path: string,
	state: "completed" | "attention",
	errorMessage?: string,
): string {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const label = beacon?.taskName ? ` · ${beacon.taskName}` : "";
	const head =
		state === "completed"
			? `Completed${label}.`
			: `Needs attention${label}.${errorMessage ? ` ${errorMessage}` : ""}`;
	return [
		"Message Type: FINAL_ANSWER",
		`Task name: ${NOTIFY ?? beacon?.parent ?? ROOT_TASK_PATH}`,
		`Sender: ${name}`,
		`Status: ${state}`,
		"Payload:",
		head,
		`Result file: ${path}`,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

// --------------------------------------------------------------------------
// Run + identity (module state: each pi process is one agent)
// --------------------------------------------------------------------------

const SELF = process.env.PI_SUBAGENT_TASK_PATH || ROOT_TASK_PATH;
const PARENT = process.env.PI_SUBAGENT_PARENT_PATH || null;
const NOTIFY = process.env.PI_SUBAGENT_NOTIFY_PATH || PARENT;
const IS_CHILD = !!process.env.PI_SUBAGENT_TASK_PATH;

let runDir = process.env.PI_SUBAGENT_RUN || "";
const kids = new Map<string, ChildProcess>();
let piThinkingLevel: ThinkingLevel = "medium";
let pendingSpawnApprovals = 0;

function assertRunSchema(): void {
	if (!runDir) throw new Error("Subagent task is missing PI_SUBAGENT_RUN.");
	const metadata = readJson<{ schemaVersion?: number; rootPath?: string }>(
		join(runDir, "run.json"),
	);
	if (
		metadata?.schemaVersion !== RUN_SCHEMA_VERSION ||
		metadata.rootPath !== ROOT_TASK_PATH
	)
		throw new Error(`Unsupported subagent run schema in ${runDir}.`);
}

function ensureRun(): string {
	if (!runDir) {
		runDir = join(
			BASE,
			`${timestampSegment(new Date().toISOString())}_${rid().slice(0, 8)}`,
		);
		ensureDir(runDir);
		if (!IS_CHILD) {
			writeJsonAtomic(join(runDir, "run.json"), {
				schemaVersion: RUN_SCHEMA_VERSION,
				rootPath: ROOT_TASK_PATH,
			});
			writeFileSync(join(runDir, ".root-pid"), `${process.pid}\n`);
			writeBeacon(ROOT_TASK_PATH, {
				taskId: "main",
				parent: null,
				state: "running",
				startedAt: now(),
			});
		}
	}
	return runDir;
}

function agentDir(name: string): string {
	return join(runDir, "tasks", taskStorageKey(name));
}
function inboxDir(name: string): string {
	return join(agentDir(name), "inbox");
}
function childrenDir(name: string): string {
	return join(agentDir(name), "children");
}
function sessionsDir(): string {
	return join(runDir, "sessions");
}
function launchFile(name: string): string {
	return join(agentDir(name), "launch.json");
}
function activeLock(name: string): string {
	return join(agentDir(name), ".active");
}
function activePidFile(name: string): string {
	return join(activeLock(name), "pid");
}
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string })?.code === "EPERM";
	}
}
function isActive(name: string): boolean {
	const lock = activeLock(name);
	if (!existsSync(lock)) return false;
	const pidText = (() => {
		try {
			return readFileSync(activePidFile(name), "utf8");
		} catch {
			return "";
		}
	})();
	const pid = Number(pidText);
	if (Number.isFinite(pid) && pid > 0) {
		const alive = processAlive(pid);
		if (!alive) rmSync(lock, { recursive: true, force: true });
		return alive;
	}
	// Compatibility for locks from older code while this process is alive.
	return kids.has(name);
}

function writeBeacon(name: string, patch: Partial<Beacon>): void {
	const dir = agentDir(name);
	ensureDir(dir);
	const prev = readJson<Beacon>(join(dir, "beacon.json"));
	const state = patch.state ?? prev?.state ?? "running";
	const beacon: Beacon = {
		name,
		taskId:
			patch.taskId ??
			prev?.taskId ??
			(name === ROOT_TASK_PATH ? "main" : taskId()),
		parent: patch.parent ?? prev?.parent ?? (name === SELF ? PARENT : null),
		taskName: patch.taskName ?? prev?.taskName ?? "",
		task: patch.task ?? prev?.task,
		state,
		activity: patch.activity ?? (INACTIVE.has(state) ? "" : prev?.activity),
		startedAt: prev?.startedAt ?? patch.startedAt ?? now(),
		updatedAt: now(),
		finishedAt: INACTIVE.has(state) ? (prev?.finishedAt ?? now()) : undefined,
		responses: patch.responses ?? prev?.responses,
		inputTokens: patch.inputTokens ?? prev?.inputTokens,
		outputTokens: patch.outputTokens ?? prev?.outputTokens,
		cacheReadTokens: patch.cacheReadTokens ?? prev?.cacheReadTokens,
		cacheWriteTokens: patch.cacheWriteTokens ?? prev?.cacheWriteTokens,
		contextTokens: patch.contextTokens ?? prev?.contextTokens,
		cost: patch.cost ?? prev?.cost,
		model: patch.model ?? prev?.model,
		thinking: patch.thinking ?? prev?.thinking,
		lastAssistantText: patch.lastAssistantText ?? prev?.lastAssistantText,
		generation: patch.generation ?? prev?.generation ?? 1,
		resultFile: patch.resultFile ?? prev?.resultFile,
		errorMessage: patch.errorMessage ?? prev?.errorMessage,
		recoveryStage: patch.recoveryStage ?? prev?.recoveryStage,
	};
	writeJsonAtomic(join(dir, "beacon.json"), beacon);
}

function listAgents(): Beacon[] {
	if (!runDir || !existsSync(runDir)) return [];
	const tasksDir = join(runDir, "tasks");
	if (!existsSync(tasksDir)) return [];
	const out: Beacon[] = [];
	for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const b = readJson<Beacon>(join(tasksDir, entry.name, "beacon.json"));
		if (b) out.push(b);
	}
	return out;
}

function activeChildren(parent: string): Beacon[] {
	const dir = childrenDir(parent);
	if (!existsSync(dir)) return [];
	const out: Beacon[] = [];
	for (const child of readdirSync(dir)) {
		let taskPath = "";
		try {
			taskPath = readFileSync(join(dir, child), "utf8").trim();
		} catch {
			continue;
		}
		if (!taskPath) continue;
		const beacon = readJson<Beacon>(join(agentDir(taskPath), "beacon.json"));
		if (
			beacon &&
			!INACTIVE.has(beacon.state) &&
			(beacon.state === "queued" ||
				RECOVERING.has(beacon.state) ||
				isActive(beacon.name))
		)
			out.push(beacon);
	}
	return out;
}

function activeDescendants(parent: string): Beacon[] {
	const prefix = `${parent}/`;
	return listAgents().filter(
		(agent) =>
			agent.name.startsWith(prefix) &&
			!INACTIVE.has(agent.state) &&
			(agent.state === "queued" ||
				RECOVERING.has(agent.state) ||
				isActive(agent.name)),
	);
}

function hasPendingFresh(name: string): boolean {
	return !!peekFresh(name);
}

function hasTeamWork(name: string): boolean {
	return hasPendingFresh(name) || activeDescendants(name).length > 0;
}

function noWaitWorkMessage(name: string): string {
	const children = listAgents().filter((agent) => agent.parent === name);
	if (!children.length) return "No agents exist.";
	const failed = children.filter(
		(agent) =>
			agent.state === "error" ||
			(!INACTIVE.has(agent.state) &&
				!RECOVERING.has(agent.state) &&
				!isActive(agent.name)),
	);
	if (failed.length)
		return `No active agents or unread messages. Failed: ${failed.map((agent) => agent.name).join(", ")}.`;
	return "No active agents or unread messages.";
}

function terminalRunReadyToHide(): boolean {
	if (!runDir) return false;
	const agents = listAgents().filter((a) => a.name !== ROOT_TASK_PATH);
	return terminalRunCanHide(
		agents,
		isActive,
		Boolean(pendingQuestion) || hasPendingFresh(SELF),
	);
}

function hideCompletedRun(ctx: ExtensionContext): void {
	if (!terminalRunReadyToHide()) return;
	if (ctx.mode === "tui") ctx.ui.setWidget(VIEW_KEY, undefined);
	lastSig = undefined;
	runDismissed = true;
}

function modelLabel(message: { provider?: string; model?: string }):
	| string
	| undefined {
	if (!message.model) return undefined;
	return message.provider
		? `${message.provider}/${message.model}`
		: message.model;
}

function recordAssistantResponse(message: unknown): void {
	const m = message as {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		provider?: string;
		model?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
	};
	if (m.role !== "assistant") return;

	const prev = readJson<Beacon>(join(agentDir(SELF), "beacon.json"));
	const usage = m.usage ?? {};
	const text = collapseWhitespace(assistantTextFromMessage(message));
	const patch: Partial<Beacon> = {
		state: "running",
		activity: "",
		responses: (prev?.responses ?? 0) + 1,
		inputTokens: (prev?.inputTokens ?? 0) + (usage.input ?? 0),
		outputTokens: (prev?.outputTokens ?? 0) + (usage.output ?? 0),
		cacheReadTokens: (prev?.cacheReadTokens ?? 0) + (usage.cacheRead ?? 0),
		cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + (usage.cacheWrite ?? 0),
		contextTokens: usage.totalTokens ?? prev?.contextTokens,
		cost: (prev?.cost ?? 0) + (usage.cost?.total ?? 0),
		model: modelLabel(m) ?? prev?.model,
	};
	if (
		isSuccessfulAssistantStatus(m) &&
		prev?.recoveryStage !== "summarizing"
	) {
		patch.recoveryStage = "idle";
		patch.errorMessage = "";
	}
	if (text) patch.lastAssistantText = text.slice(0, ASSISTANT_PREVIEW_MAX);
	writeBeacon(SELF, patch);
}

// Stateless cleanup: drop run directories from past sessions. No main-side bookkeeping.
function sweepOldRuns(): void {
	if (!existsSync(BASE)) return;
	for (const e of readdirSync(BASE, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const path = join(BASE, e.name);
		if (now() - statSync(path).mtimeMs <= RUN_TTL_MS) continue;
		const rootPid = Number(
			(() => {
				try {
					return readFileSync(join(path, ".root-pid"), "utf8");
				} catch {
					return "";
				}
			})(),
		);
		if (Number.isFinite(rootPid) && rootPid > 0 && processAlive(rootPid))
			continue;
		rmSync(path, { recursive: true, force: true });
	}
}

// --------------------------------------------------------------------------
// Mailbox
// --------------------------------------------------------------------------

function appendFeed(line: string): void {
	const feedPath = join(runDir, "feed.log");
	appendFileSync(feedPath, `${collapseWhitespace(line).slice(0, 160)}\n`);
}

function post(msg: Mail): void {
	ensureDir(inboxDir(msg.to));
	writeFileSync(
		join(inboxDir(msg.to), `${msg.ts}-${msg.id}.json`),
		JSON.stringify(msg),
		{ flag: "wx" },
	);
	appendFeed(`${msg.from}→${msg.to}: ${msg.body}`);
}

function inboxFiles(name: string): string[] {
	const dir = inboxDir(name);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
}

// Oldest fresh (non-reply) message, without consuming.
function peekFresh(name: string): { path: string; msg: Mail } | undefined {
	for (const f of inboxFiles(name)) {
		const path = join(inboxDir(name), f);
		const msg = readJson<Mail>(path);
		if (msg && !msg.replyTo) return { path, msg };
	}
	return undefined;
}

// A reply to a specific message id, consumed on read.
function takeReply(
	name: string,
	replyTo: string,
	expectedFrom?: string,
): Mail | undefined {
	for (const f of inboxFiles(name)) {
		const path = join(inboxDir(name), f);
		const msg = readJson<Mail>(path);
		if (
			msg &&
			msg.replyTo === replyTo &&
			(!expectedFrom || msg.from === expectedFrom)
		) {
			rmSync(path, { force: true });
			return msg;
		}
	}
	return undefined;
}

// Atomically claim a fresh message. The claim file is not visible to inboxFiles().
function claimFresh(name: string): { path: string; msg: Mail } | undefined {
	for (const f of inboxFiles(name)) {
		const path = join(inboxDir(name), f);
		const msg = readJson<Mail>(path);
		if (!msg || msg.replyTo) continue;
		const claimPath = `${path}.${process.pid}.${rid()}.claim`;
		try {
			renameSync(path, claimPath);
			return { path: claimPath, msg };
		} catch {
			// Another loop claimed it first.
		}
	}
	return undefined;
}

function spawnApprovalDetails(msg: { approval?: SpawnApproval }):
	| SpawnApproval
	| undefined {
	return msg.approval?.type === "spawn" ? msg.approval : undefined;
}

function pendingQuestionFor(msg: Mail): PendingQuestion | undefined {
	if (msg.kind !== "request") return undefined;
	return {
		from: msg.from,
		id: msg.id,
		body: msg.body,
		approval: spawnApprovalDetails(msg),
	};
}

async function pollFor<T>(
	fn: () => T | undefined,
	signal?: AbortSignal,
): Promise<T | undefined> {
	if (signal?.aborted) return undefined;
	const value = fn();
	if (value !== undefined) return value;
	await waitForDirectoryChange(inboxDir(SELF), signal);
	return pollFor(fn, signal);
}

function updateSpawnApprovalState(): void {
	let state = "running";
	let activity = "";
	if (pendingSpawnApprovals > 0) {
		state = "waiting";
		let suffix = "";
		if (pendingSpawnApprovals !== 1) suffix = "s";
		activity = `awaiting ${pendingSpawnApprovals} spawn approval${suffix}`;
	}
	writeBeacon(SELF, { state, activity });
}

async function waitForSpawnApproval(
	requestId: string,
	signal?: AbortSignal,
): Promise<Mail | undefined> {
	pendingSpawnApprovals++;
	updateSpawnApprovalState();
	try {
		return await pollFor(
			() => takeReply(SELF, requestId, ROOT_TASK_PATH),
			signal,
		);
	} finally {
		pendingSpawnApprovals--;
		updateSpawnApprovalState();
	}
}

function waitForDirectoryChange(
	path: string,
	signal?: AbortSignal,
): Promise<void> {
	ensureDir(path);
	return new Promise((resolve) => {
		let settled = false;
		let watcher: ReturnType<typeof watch> | undefined;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (fallback) clearTimeout(fallback);
			watcher?.close();
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		watcher = watch(path, finish);
		watcher.on("error", finish);
		watcher.unref();
		fallback = setTimeout(finish, INBOX_FALLBACK_MS);
		fallback.unref();
		signal?.addEventListener("abort", finish, { once: true });
	});
}

async function waitForTeamEvent(
	signal?: AbortSignal,
): Promise<TeamEvent | undefined> {
	if (signal?.aborted) return undefined;
	const fresh = claimFresh(SELF);
	if (fresh) {
		try {
			pendingQuestion = pendingQuestionFor(fresh.msg);
			return {
				message: `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`,
				kind: fresh.msg.kind,
				topic: fresh.msg.topic,
				from: fresh.msg.from,
				taskPaths: fresh.msg.taskPaths,
			};
		} finally {
			rmSync(fresh.path, { force: true });
		}
	}
	if (activeDescendants(SELF).length === 0)
		return { message: noWaitWorkMessage(SELF) };
	await waitForDirectoryChange(inboxDir(SELF), signal);
	return waitForTeamEvent(signal);
}

// --------------------------------------------------------------------------
// Human name allocation (mkdir is the atomic lock)
// --------------------------------------------------------------------------

function reserveChildTaskPath(taskName: string): string {
	ensureRun();
	const taskPath = childTaskPath(SELF, taskName);
	ensureDir(childrenDir(SELF));
	const pathLock = join(childrenDir(SELF), taskStorageKey(taskPath));
	let reserved = false;
	try {
		writeFileSync(pathLock, taskPath, { flag: "wx" });
		reserved = true;
		mkdirSync(agentDir(taskPath));
		return taskPath;
	} catch (error) {
		if (reserved) rmSync(pathLock, { force: true });
		if ((error as { code?: string }).code === "EEXIST")
			throw new Error(`Task ${taskPath} already exists in this run.`);
		throw error;
	}
}

// --------------------------------------------------------------------------
// Spawn a child pi process
// --------------------------------------------------------------------------

type LaunchRequest = {
	prompt: string;
	fresh: boolean;
	taskName: string;
	taskId: string;
	thinking: ThinkingLevel;
	parent: string;
	notify: string;
	generation: number;
};

function runningDirectChildren(): Beacon[] {
	return activeChildren(SELF).filter(
		(agent) =>
			agent.state !== "queued" &&
			(RECOVERING.has(agent.state) || isActive(agent.name)),
	);
}

function launchAgent(
	name: string,
	request: LaunchRequest,
	ctx: ExtensionContext,
): boolean {
	const existingBeacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const summarizing =
		!request.fresh && existingBeacon?.recoveryStage === "summarizing";
	const sessionFile = request.fresh ? undefined : latestSessionFile(name);
	if (!request.fresh && !sessionFile) return false;
	try {
		mkdirSync(activeLock(name)); // claims the agent; throws if already active
	} catch {
		return false;
	}
	ensureDir(inboxDir(name));
	ensureDir(sessionsDir());
	writeBeacon(
		name,
		request.fresh
			? {
					taskId: request.taskId,
					parent: request.parent,
					taskName: request.taskName,
					task: request.prompt,
					thinking: request.thinking,
					generation: request.generation,
					recoveryStage: "idle",
					state: "spawning",
					startedAt: now(),
				}
			: {
					thinking: request.thinking,
					generation: request.generation,
					state: "running",
					activity: "",
					resultFile: "",
					errorMessage: "",
				},
	);

	// Persistent session in an isolated store: resumable, but `/resume` never scans it.
	const args = [
		process.argv[1],
		"--print",
		request.prompt,
		...(request.fresh
			? ["--session-id", request.taskId]
			: ["--session", sessionFile as string]),
		"--session-dir",
		sessionsDir(),
		...(summarizing ? ["--no-tools"] : ["--exclude-tools", "ask_user"]),
		"--thinking",
		request.thinking,
	];
	if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);

	const child = spawnChild(process.execPath, args, {
		cwd: ctx.cwd,
		env: {
			...process.env,
			PI_SUBAGENT_RUN: runDir,
			PI_SUBAGENT_TASK_PATH: name,
			PI_SUBAGENT_PARENT_PATH: request.parent,
			PI_SUBAGENT_NOTIFY_PATH: request.notify,
		},
		stdio: "ignore",
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	if (typeof child.pid === "number")
		writeFileSync(activePidFile(name), `${child.pid}\n`);
	kids.set(name, child);
	rmSync(launchFile(name), { force: true });
	let finalized = false;
	const finishUnexpected = (state: "error", detail: string) => {
		if (finalized) return;
		finalized = true;
		const b = readJson<Beacon>(join(agentDir(name), "beacon.json"));
		if (b && b.generation !== request.generation) {
			if (kids.get(name) === child) kids.delete(name);
			return;
		}
		let body = detail;
		const recovery = exitRecovery(b);
		if (recovery) {
			const outcome = restartAgentProcess(
				name,
				recovery.prompt,
				ctx,
				request.generation,
				recovery.stage,
			);
			if (outcome.ok || outcome.superseded) {
				if (kids.get(name) === child) kids.delete(name);
				setTimeout(() => drainLaunchQueue(ctx), 0).unref();
				return;
			}
			body = `automatic restart failed: ${outcome.message}`;
		}

		rmSync(activeLock(name), { recursive: true, force: true });
		if (kids.get(name) === child) kids.delete(name);
		if (!b || !INACTIVE.has(b.state)) {
			writeBeacon(name, { state, errorMessage: body });
			post({
				id: rid(),
				from: name,
				to: request.notify,
				body,
				kind: "attention",
				ts: now(),
			});
		}
		setTimeout(() => drainLaunchQueue(ctx), 0).unref();
	};
	child.on("error", (error) =>
		finishUnexpected("error", `failed to start: ${(error as Error).message}`),
	);
	// Safety net: if the process dies without a clean agent_end, surface it to the launcher.
	child.on("exit", (code) =>
		finishUnexpected(
			"error",
			code === 0
				? "exited before posting a result"
				: `exited unexpectedly (code ${code})`,
		),
	);
	child.on("exit", () => refreshView(ctx));
	return true;
}

// Launch (fresh) or resume (existing session). Excess direct children are queued
// on disk so a burst of delegation does not create an unbounded process/provider fan-out.
function runAgent(
	name: string,
	prompt: string,
	ctx: ExtensionContext,
	fresh: boolean,
	taskName = "",
	id?: string,
	thinking?: ThinkingLevel,
	generation?: number,
): boolean {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const request: LaunchRequest = {
		prompt,
		fresh,
		taskName: taskName || beacon?.taskName || "",
		taskId: id ?? beacon?.taskId ?? taskId(),
		thinking: thinking ?? beacon?.thinking ?? piThinkingLevel,
		parent: fresh ? SELF : (beacon?.parent ?? SELF),
		notify: fresh ? SELF : (beacon?.parent ?? SELF),
		generation:
			generation ?? (fresh ? 1 : (beacon?.generation ?? 1) + 1),
	};
	if (isActive(name)) return false;
	if (fresh && runningDirectChildren().length >= MAX_ACTIVE_CHILDREN) {
		ensureDir(agentDir(name));
		writeJsonAtomic(launchFile(name), request);
		writeBeacon(name, {
			taskId: request.taskId,
			parent: fresh ? SELF : beacon?.parent,
			taskName: request.taskName,
			task: request.prompt,
			thinking: request.thinking,
			generation: request.generation,
			resultFile: "",
			errorMessage: "",
			state: "queued",
			startedAt: fresh ? now() : beacon?.startedAt,
		});
		return true;
	}
	return launchAgent(name, request, ctx);
}

function drainLaunchQueue(ctx: ExtensionContext): void {
	const children = activeChildren(SELF);
	let available =
		MAX_ACTIVE_CHILDREN -
		children.filter((agent) => agent.state !== "queued" && isActive(agent.name))
			.length;
	if (available <= 0) return;
	const queued = children
		.filter((agent) => agent.state === "queued")
		.sort((a, b) => a.startedAt - b.startedAt);
	for (const agent of queued) {
		if (available <= 0) break;
		const request = readJson<LaunchRequest>(launchFile(agent.name));
		if (!request) {
			writeBeacon(agent.name, {
				state: "error",
				activity: "missing launch request",
			});
			continue;
		}
		if (launchAgent(agent.name, request, ctx)) available--;
	}
}

function activePid(name: string): number | undefined {
	try {
		const pid = Number(readFileSync(activePidFile(name), "utf8"));
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function killPidTree(pid: number): boolean {
	if (process.platform === "win32") {
		const result = spawnSync(
			"taskkill.exe",
			["/PID", String(pid), "/T", "/F"],
			{ windowsHide: true },
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			return false;
		}
	}
}

type RestartOutcome = {
	ok: boolean;
	message: string;
	generation?: number;
	superseded?: boolean;
};

function acquireRestartClaim(claim: string): boolean {
	const tryAcquire = (): boolean => {
		const candidate = `${claim}.${process.pid}.${rid()}`;
		mkdirSync(candidate);
		writeFileSync(join(candidate, "pid"), `${process.pid}\n`);
		try {
			renameSync(candidate, claim);
			return true;
		} catch {
			rmSync(candidate, { recursive: true, force: true });
			return false;
		}
	};
	if (tryAcquire()) return true;
	const owner = Number(
		(() => {
			try {
				return readFileSync(join(claim, "pid"), "utf8");
			} catch {
				return "";
			}
		})(),
	);
	if (!Number.isFinite(owner) || owner <= 0 || processAlive(owner)) return false;
	rmSync(claim, { recursive: true, force: true });
	return tryAcquire();
}

function restartAgentProcess(
	name: string,
	prompt: string,
	ctx: ExtensionContext,
	expectedGeneration?: number,
	recoveryStage: RecoveryStage = "restarted",
	expectedProgressAt?: number,
): RestartOutcome {
	const claim = join(agentDir(name), ".restart");
	if (!acquireRestartClaim(claim)) {
		return {
			ok: false,
			message: `${name}: restart already claimed`,
			superseded: true,
		};
	}

	try {
		const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
		if (!beacon) return { ok: false, message: `${name}: not found` };
		const previousGeneration = beacon.generation ?? 1;
		if (
			expectedGeneration !== undefined &&
			previousGeneration !== expectedGeneration
		)
			return {
				ok: false,
				message: `${name}: generation ${expectedGeneration} was superseded`,
				superseded: true,
			};
		if (expectedGeneration !== undefined && INACTIVE.has(beacon.state))
			return {
				ok: false,
				message: `${name}: already ${beacon.state}`,
				superseded: true,
			};
		if (beacon.state === "queued")
			return {
				ok: false,
				message: `${name}: queued tasks have no conversation to resume`,
			};
		if (
			expectedProgressAt !== undefined &&
			Math.max(beacon.updatedAt, sessionProgressAt(name)) > expectedProgressAt
		)
			return {
				ok: false,
				message: `${name}: progress resumed before restart`,
				superseded: true,
			};
		if (!latestSessionFile(name))
			return {
				ok: false,
				message: `${name}: no persisted session is available to resume`,
			};

		const nextGeneration = previousGeneration + 1;
		const trackedChild = kids.get(name);
		const pid = activePid(name) ?? trackedChild?.pid;
		const live = Boolean(pid && processAlive(pid));

		// Advance the generation before terminating the old process. Its exit
		// callback then cannot mutate the replacement lock or beacon.
		writeBeacon(name, {
			generation: nextGeneration,
			state: recoveryStage === "summarizing" ? "summarizing" : "restarting",
			activity:
				recoveryStage === "summarizing" ? "summarizing" : "restarting",
			recoveryStage,
			resultFile: "",
			errorMessage: "",
		});
		if (live && pid && !killPidTree(pid) && processAlive(pid)) {
			writeBeacon(name, {
				generation: previousGeneration,
				state: beacon.state,
				activity: beacon.activity ?? "",
				recoveryStage: beacon.recoveryStage ?? "idle",
				errorMessage: "restart failed: process could not be terminated",
			});
			return {
				ok: false,
				message: `${name}: process ${pid} could not be terminated`,
			};
		}

		if (recoveryStage === "summarizing")
			killDescendants(name, "parent recovery entered summary mode");
		if (kids.get(name) === trackedChild) kids.delete(name);
		rmSync(activeLock(name), { recursive: true, force: true });
		rmSync(launchFile(name), { force: true });
		const accepted = runAgent(
			name,
			prompt,
			ctx,
			false,
			beacon.taskName,
			beacon.taskId,
			beacon.thinking,
			nextGeneration,
		);
		if (!accepted) {
			writeBeacon(name, {
				state: "error",
				activity: "",
				errorMessage: "restart failed: replacement launch was rejected",
			});
			return {
				ok: false,
				message: `${name}: replacement launch was rejected`,
			};
		}
		appendFeed(`${SELF}→${name}: restarted generation ${nextGeneration}`);
		return {
			ok: true,
			message: `${name}: resumed session in generation ${nextGeneration}`,
			generation: nextGeneration,
		};
	} finally {
		rmSync(claim, { recursive: true, force: true });
	}
}

function removePendingFrom(sender: string, recipient = SELF): number {
	let removed = 0;
	for (const file of inboxFiles(recipient)) {
		const path = join(inboxDir(recipient), file);
		const msg = readJson<Mail>(path);
		if (msg?.from === sender) {
			rmSync(path, { force: true });
			removed++;
		}
	}
	return removed;
}

function killOneAgent(name: string, reason: string): string {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	if (!beacon) return `${name}: not found`;
	const pid = activePid(name);
	const live = Boolean(pid && processAlive(pid));
	rmSync(launchFile(name), { force: true });
	kids.delete(name);
	const removed = removePendingFrom(name, beacon.parent ?? SELF);
	if (pendingQuestion?.from === name) pendingQuestion = undefined;
	const cleared = removed
		? `; cleared ${removed} pending message${removed === 1 ? "" : "s"}`
		: "";

	if (INACTIVE.has(beacon.state) && !live) {
		rmSync(activeLock(name), { recursive: true, force: true });
		return `${name}: already ${beacon.state}${cleared}`;
	}

	writeBeacon(name, { state: "hard_killed", activity: "" });
	const killed = pid ? killPidTree(pid) : false;
	if (!pid || !processAlive(pid))
		rmSync(activeLock(name), { recursive: true, force: true });
	else
		setTimeout(() => {
			if (!processAlive(pid))
				rmSync(activeLock(name), { recursive: true, force: true });
		}, 250).unref();
	appendFeed(`${SELF}→${name}: killed (${reason})`);
	return `${name}: ${pid ? (killed ? `killed pid ${pid}` : `marked hard-killed; pid ${pid} did not terminate cleanly`) : "marked hard-killed; no live pid"}${cleared}`;
}

function killDescendants(name: string, reason: string): void {
	const prefix = `${name}/`;
	const descendants = listAgents()
		.filter(
			(agent) =>
				agent.name.startsWith(prefix) && !INACTIVE.has(agent.state),
		)
		.sort((a, b) => b.name.length - a.name.length);
	for (const descendant of descendants)
		killOneAgent(descendant.name, reason);
}

function killAgents(selector: string, reason: string): string[] {
	const agents = listAgents();
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const children = new Map<string, Beacon[]>();
	for (const agent of agents) {
		const siblings = children.get(agent.parent ?? "") ?? [];
		siblings.push(agent);
		children.set(agent.parent ?? "", siblings);
	}
	const collect = (root: string): string[] => {
		const names: string[] = [];
		const walk = (name: string) => {
			const agent = byName.get(name);
			if (agent) names.push(name);
			for (const child of children.get(name) ?? []) walk(child.name);
		};
		walk(root);
		return names;
	};
	const selected = resolveAgent(selector);
	const names =
		selector.trim() === "*"
			? (children.get(SELF) ?? []).flatMap((agent) => collect(agent.name))
			: selected
				? collect(selected.name)
				: [];
	const unique = [...new Set(names)].filter((name) => name !== SELF);
	if (!unique.length) return [`No agent matched ${selector}.`];
	return unique.reverse().map((name) => killOneAgent(name, reason));
}

function resolveAgent(selector: string): Beacon | undefined {
	const normalized = selector.trim();
	if (!normalized) return undefined;
	const absolute = normalized.startsWith("/")
		? normalized
		: `${SELF}/${normalized}`;
	return listAgents().find((agent) => agent.name === absolute);
}

function canAddress(target: Beacon): boolean {
	return (
		SELF === ROOT_TASK_PATH ||
		target.name === ROOT_TASK_PATH ||
		target.name === PARENT ||
		target.name.startsWith(`${SELF}/`)
	);
}

function canControlTask(target: Beacon): boolean {
	return SELF === ROOT_TASK_PATH || target.name.startsWith(`${SELF}/`);
}

function resolveAuthorizedAgent(selector: string): Beacon | undefined {
	const target = resolveAgent(selector);
	return target && canAddress(target) ? target : undefined;
}

function sendAgentNotice(
	to: string,
	body: string,
	ctx: ExtensionContext,
): string {
	if (!runDir) return "No run yet — spawn_agent first.";
	const target = resolveAuthorizedAgent(to);
	if (!target || target.name === SELF)
		return `Unknown or unauthorized task ${to}.`;
	const message = body.trim();
	if (!message) return "Message must not be empty.";
	if (message.length > 4000) return "Message must be at most 4000 characters.";
	if (pendingQuestion?.from === target.name) {
		post({
			id: rid(),
			from: SELF,
			to: target.name,
			body: message,
			replyTo: pendingQuestion.id,
			kind: "notice",
			ts: now(),
		});
		pendingQuestion = undefined;
		return `Replied to ${target.name}.`;
	}
	if (
		target.name !== ROOT_TASK_PATH &&
		!isActive(target.name) &&
		target.state !== "queued"
	) {
		if (!canControlTask(target) || !runAgent(target.name, message, ctx, false))
			return `${target.name} could not be resumed.`;
		return `Resumed ${target.name}.`;
	}
	post({
		id: rid(),
		from: SELF,
		to: target.name,
		body: message,
		kind: "notice",
		ts: now(),
	});
	return `Sent message to ${target.name}.`;
}

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

const text = (t: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: t }],
	details,
});

const structured = (payload: Record<string, unknown>, display?: string) =>
	text(JSON.stringify(payload), display ? { ...payload, display } : payload);

function renderToolResult(
	result: {
		content?: Array<{ type?: string; text?: string }>;
		details?: unknown;
	},
	isPartial: boolean,
	theme: Theme,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
	const details = asRecord(result.details);
	const display =
		typeof details?.display === "string" ? details.display : undefined;
	const fallback =
		result.content?.find((part) => part.type === "text")?.text ?? "Done";
	return new Text(
		theme.fg(details?.error ? "error" : "success", display ?? fallback),
		0,
		0,
	);
}

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn agent",
		description: "Start an isolated child agent.",
		promptSnippet:
			"Start an isolated child agent; ordinary tools are blocked until delegated work completes",
		promptGuidelines: [
			"After the final spawn_agent call, call wait_agent next. Do not batch or call ordinary tools while delegated work is pending; only spawn_agent, send_message, restart_agent, wait_agent, and kill_agent are allowed.",
		],
		parameters: Type.Object(
			{
				task_name: Type.String({
					description:
						"One lowercase task-path segment using only letters, digits, and underscores.",
				}),
				message: Type.String({
					description:
						"The delegated objective, constraints, and expected result.",
				}),
				thinking: Type.Optional(
					StringEnum(THINKING_LEVELS, {
						description:
							"Thinking level for the child. Defaults to the caller's level.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!IS_CHILD && runDir && terminalRunReadyToHide()) {
				rmSync(join(runDir, ".root-pid"), { force: true });
				runDir = "";
				runDismissed = false;
			}
			ensureRun();
			const taskName = normalizeTaskName(params.task_name);
			const message = params.message.trim();
			if (!message) throw new Error("message must not be empty");
			const taskPath = childTaskPath(SELF, taskName);
			const thinking =
				params.thinking ?? (pi.getThinkingLevel() as ThinkingLevel);

			if (IS_CHILD) {
				const reqId = rid();
				post({
					id: reqId,
					from: SELF,
					to: ROOT_TASK_PATH,
					body: `[approval] spawn "${taskName}" at ${taskPath} with thinking ${thinking}: ${message}`,
					kind: "request",
					approval: { type: "spawn", taskName, taskPath, message, thinking },
					ts: now(),
				});
				const reply = await waitForSpawnApproval(reqId, signal);
				if (!reply) return structured({ error: "Approval wait interrupted." });
				if (reply.approved !== true)
					return structured({ error: `Spawn denied by root: ${reply.body}` });
			}

			const reservedPath = reserveChildTaskPath(taskName);
			const accepted = runAgent(
				reservedPath,
				message,
				ctx,
				true,
				taskSummary(message),
				allocateTaskId(),
				thinking,
			);
			if (!accepted) {
				writeBeacon(reservedPath, {
					state: "error",
					activity: "launch rejected",
					errorMessage: "active lock already held",
				});
				throw new Error(
					`Could not launch ${reservedPath}; its active lock is held.`,
				);
			}
			refreshView(ctx);
			const state = readJson<Beacon>(
				join(agentDir(reservedPath), "beacon.json"),
			)?.state;
			return structured(
				{
					task_name: reservedPath,
					thinking,
					delegation_pending: true,
					next_action:
						"Call wait_agent. Non-coordination tools are blocked while delegated work remains.",
				},
				`${state === "queued" ? "Queued" : "Spawned"} ${reservedPath}`,
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `Spawn ${args.task_name}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send message",
		description:
			"Send a message, or decide a pending nested spawn with approve_spawn.",
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute /root/... task path or path relative to the caller.",
				}),
				message: Type.String({
					description: "Message to deliver.",
					maxLength: 4000,
				}),
				approve_spawn: Type.Optional(
					Type.Boolean({
						description:
							"Approve or deny a pending nested spawn request from the target.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!runDir) return structured({ error: "No collaboration run exists." });
			const target = resolveAuthorizedAgent(params.target);
			if (!target || target.name === SELF)
				return structured({
					error: `Unknown or unauthorized task ${params.target}.`,
				});
			const message = params.message.trim();
			if (!message) return structured({ error: "message must not be empty" });
			if (message.length > 4000)
				return structured({
					error:
						"message must be at most 4000 characters; put reports in the task's final response",
				});

			const pendingReply =
				pendingQuestion?.from === target.name ? pendingQuestion : undefined;
			if (params.approve_spawn !== undefined && !pendingReply?.approval)
				return structured({
					error:
						"approve_spawn is only valid for a pending nested spawn request",
				});
			if (pendingReply?.approval && params.approve_spawn === undefined)
				return structured({
					error: "approve_spawn is required for this nested spawn request",
				});

			if (pendingReply) {
				const approved = pendingReply.approval
					? params.approve_spawn
					: undefined;
				let body = message;
				if (pendingReply.approval)
					body = approved ? "approve" : `deny: ${message}`;
				post({
					id: rid(),
					from: SELF,
					to: target.name,
					body,
					replyTo: pendingReply.id,
					kind: "notice",
					approved,
					ts: now(),
				});
				pendingQuestion = undefined;
				refreshView(ctx);
				if (pendingReply.approval)
					return structured(
						{ approved },
						`${approved ? "Approved" : "Denied"} ${pendingReply.approval.taskPath}`,
					);
				return structured({}, `Replied to ${target.name}`);
			}

			if (SELF.startsWith(`${target.name}/`)) {
				const requestId = rid();
				post({
					id: requestId,
					from: SELF,
					to: target.name,
					body: message,
					kind: "request",
					ts: now(),
				});
				const reply = await pollFor(
					() => takeReply(SELF, requestId, target.name),
					signal,
				);
				if (!reply) return structured({ error: "Message wait interrupted." });
				return structured({ message: reply.body }, `Reply from ${target.name}`);
			}

			if (
				target.name !== ROOT_TASK_PATH &&
				!isActive(target.name) &&
				target.state !== "queued"
			) {
				if (
					!canControlTask(target) ||
					!runAgent(target.name, message, ctx, false)
				)
					return structured({ error: `${target.name} could not be resumed.` });
				refreshView(ctx);
				return structured({}, `Resumed ${target.name}`);
			}
			post({
				id: rid(),
				from: SELF,
				to: target.name,
				body: message,
				kind: "notice",
				ts: now(),
			});
			refreshView(ctx);
			return structured({}, `Sent message to ${target.name}`);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `Message ${args.target}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "restart_agent",
		label: "Restart agent",
		description:
			"Terminate a stuck task process and resume its persisted conversation in a fresh process.",
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute /root/... task path or path relative to the caller.",
				}),
				message: Type.String({
					description:
						"Recovery instruction appended to the resumed conversation.",
					maxLength: 4000,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!runDir) return structured({ error: "No collaboration run exists." });
			const target = resolveAuthorizedAgent(params.target);
			if (
				!target ||
				!canControlTask(target) ||
				target.name === ROOT_TASK_PATH ||
				target.name === SELF
			)
				return structured({
					error: `Unknown or invalid restart target ${params.target}.`,
				});
			const message = params.message.trim();
			if (!message) return structured({ error: "message must not be empty" });
			if (message.length > 4000)
				return structured({ error: "message must be at most 4000 characters" });
			const outcome = restartAgentProcess(target.name, message, ctx);
			refreshView(ctx);
			if (!outcome.ok) return structured({ error: outcome.message });
			return structured(
				{
					task_name: target.name,
					generation: outcome.generation,
					resumed_session: true,
					delegation_pending: true,
					next_action: "Call wait_agent for the restarted task.",
				},
				outcome.message,
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("warning", `Restart ${args.target}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait for agents",
		description:
			"Wait until a child sends a message, finishes, or the user interrupts.",
		promptSnippet:
			"Wait for delegated work; repeat while delegation_pending is true",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			if (!runDir)
				return structured(
					{
						message: "No collaboration run exists.",
						delegation_pending: false,
						next_action: "Continue with ordinary tools.",
					},
					"No collaboration run exists",
				);
			if (pendingQuestion)
				return structured(
					{
						message: `Reply to ${pendingQuestion.from} before waiting.`,
						request: pendingQuestion,
						delegation_pending: true,
						next_action: `Call send_message to reply to ${pendingQuestion.from}.`,
					},
					`Reply to ${pendingQuestion.from} before waiting`,
				);
			if (!hasTeamWork(SELF))
				return structured(
					{
						message: noWaitWorkMessage(SELF),
						delegation_pending: false,
						next_action: "Continue with ordinary tools.",
					},
					"No agent work pending",
				);
			if (!IS_CHILD) {
				const stalled = restartStalledAgents(stalledActiveLeaves(), ctx);
				if (stalled.length > 0)
					postStalledAlert(failStalledAgents(stalled));
			}
			writeBeacon(SELF, { state: "waiting", activity: "coordinating" });
			if (!IS_CHILD) scheduleStallWatchdog(ctx);
			let event: TeamEvent | undefined;
			try {
				event = await waitForTeamEvent(signal);
			} finally {
				if (!IS_CHILD) cancelStallWatchdog();
				writeBeacon(SELF, { state: "running", activity: "" });
			}
			const interrupted = Boolean(signal?.aborted);
			if (interrupted) suppressNextCoordinationNudge = true;
			const message = interrupted
				? "Wait interrupted by user input."
				: (event?.message ?? "Wait completed.");
			const request = currentPendingQuestion();
			const delegationPending = hasTeamWork(SELF);
			const stalledAttention = event?.topic === "stalled";
			let nextAction: string;
			if (request)
				nextAction = `Call send_message to reply to ${request.from}.`;
			else if (interrupted)
				nextAction =
					"Handle the user input with send_message, restart_agent, or kill_agent, then call wait_agent again if work remains.";
			else if (stalledAttention)
				nextAction =
					"Automatic recovery is exhausted; handle the reported task failure.";
			else if (delegationPending)
				nextAction =
					"Call wait_agent again. Non-coordination tools remain blocked.";
			else
				nextAction =
					"Delegated work is complete; ordinary tools are available.";
			return structured(
				{
					message,
					request,
					attention: stalledAttention
						? { type: "stalled_agents", task_paths: event?.taskPaths ?? [] }
						: undefined,
					delegation_pending: delegationPending,
					next_action: nextAction,
				},
				message,
			);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "Waiting for agents"), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "kill_agent",
		label: "Kill agent",
		description: "Stop one child subtree, or all child subtrees with '*'.",
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute or caller-relative task path, or '*' for all direct child subtrees.",
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!runDir) return structured({ error: "No collaboration run exists." });
			let selector = params.target.trim();
			if (selector !== "*") {
				const target = resolveAuthorizedAgent(selector);
				if (
					!target ||
					!canControlTask(target) ||
					target.name === ROOT_TASK_PATH ||
					target.name === SELF
				)
					return structured({
						error: `Unknown or invalid kill target ${params.target}.`,
					});
				selector = target.name;
			}
			const lines = killAgents(selector, `requested by ${SELF}`);
			refreshView(ctx);
			return structured(
				{ message: lines.join("\n") },
				selector === "*" ? "Stopped all child agents" : `Stopped ${selector}`,
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("error", `Kill ${args.target}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});
}

// --------------------------------------------------------------------------
// Coordination guardrails
// --------------------------------------------------------------------------

let pendingQuestion: PendingQuestion | undefined;

function currentPendingQuestion(): PendingQuestion | undefined {
	return pendingQuestion;
}

function coordinationPrompt(): string {
	if (!pendingQuestion) return COORDINATION_NOTICE;
	const approval = pendingQuestion.approval;
	if (approval)
		return [
			`Nested spawn request from ${pendingQuestion.from}: ${approval.taskPath}`,
			`Task: ${approval.message}`,
			`Thinking: ${approval.thinking ?? "caller default"}`,
			`Call send_message to ${pendingQuestion.from} with a brief reason and approve_spawn set to true or false.`,
		].join("\n");
	return `Question from ${pendingQuestion.from}: ${pendingQuestion.body}\nAnswer with send_message to ${pendingQuestion.from}.`;
}

function registerCoordinationHooks(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", (event) => {
		piThinkingLevel = (event as { level: ThinkingLevel }).level;
		if (IS_CHILD) writeBeacon(SELF, { thinking: piThinkingLevel });
	});

	pi.on("input", (event, ctx) => {
		if ((event as { source?: string }).source !== "extension")
			hideCompletedRun(ctx);
	});

	pi.on("tool_call", (event) => {
		const toolName = (event as { toolName?: string }).toolName ?? "";
		const coordinationTools = [
			"spawn_agent",
			"send_message",
			"restart_agent",
			"wait_agent",
			"kill_agent",
		];
		if (pendingQuestion && toolName !== "send_message")
			return { block: true, reason: coordinationPrompt() };
		if (
			runDir &&
			hasTeamWork(SELF) &&
			!pendingQuestion &&
			!coordinationTools.includes(toolName)
		)
			return { block: true, reason: coordinationPrompt() };
	});

	// If the agent fully settles without waiting while children are still live (or
	// child messages are unread), continue with an explicit coordination nudge.
	if (!IS_CHILD) {
		pi.on("agent_end", (event) => {
			lastMainRunMessages = (event as { messages?: unknown[] }).messages ?? [];
		});
		pi.on("agent_settled", () => {
			const status = finalAssistantStatus(lastMainRunMessages);
			if (status.stopReason === "aborted" || suppressNextCoordinationNudge) {
				suppressNextCoordinationNudge = false;
				return;
			}
			if (runDir && (pendingQuestion || hasTeamWork(SELF)))
				pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
		});
	}
}

// --------------------------------------------------------------------------
// Child beacons
// --------------------------------------------------------------------------

let lastProgressHeartbeatAt = 0;

function writeProgressHeartbeat(activity: string, force = false): void {
	const observedAt = now();
	if (
		!force &&
		observedAt - lastProgressHeartbeatAt < PROGRESS_HEARTBEAT_MIN_MS
	)
		return;
	lastProgressHeartbeatAt = observedAt;
	writeBeacon(SELF, { state: "running", activity });
}

function registerChildHooks(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		writeProgressHeartbeat("", true);
	});
	pi.on("turn_start", () => {
		writeProgressHeartbeat("responding", true);
	});
	pi.on("message_update", () => {
		writeProgressHeartbeat("responding");
	});
	pi.on("tool_execution_start", (event) => {
		const name = (event as { toolName?: string }).toolName ?? "tool";
		writeProgressHeartbeat(name, true);
	});
	pi.on("tool_execution_update", (event) => {
		const name = (event as { toolName?: string }).toolName ?? "tool";
		writeProgressHeartbeat(name);
	});
	pi.on("tool_execution_end", (event) => {
		const name = (event as { toolName?: string }).toolName ?? "tool";
		writeProgressHeartbeat(`${name} complete`, true);
	});
	pi.on("message_end", (event) => {
		recordAssistantResponse((event as { message?: unknown }).message);
		lastProgressHeartbeatAt = now();
	});
	pi.on("agent_end", (event) => {
		lastChildRunMessages = (event as { messages?: unknown[] }).messages ?? [];
	});
	// On settled completion the subagent pushes only a result-file notice to its parent.
	// If it still has live children or unread child messages, it is not allowed to
	// finish; continue the agent loop with an explicit wait-only nudge instead.
	pi.on("agent_settled", () => {
		const messages = lastChildRunMessages;
		const status = finalAssistantStatus(messages);
		const beacon = readJson<Beacon>(join(agentDir(SELF), "beacon.json"));
		const recoveryStage = beacon?.recoveryStage ?? "idle";
		const successful = isSuccessfulAssistantStatus(status);
		if (
			!successful &&
			(recoveryStage === "idle" || recoveryStage === "continued_once")
		) {
			writeBeacon(SELF, {
				state: "running",
				activity: "recovering",
				errorMessage: status.errorMessage,
				recoveryStage:
					recoveryStage === "idle"
						? "continued_once"
						: "continued_twice",
			});
			pi.sendUserMessage(AUTO_RECOVERY_PROMPT, { deliverAs: "followUp" });
			return;
		}
		if (!successful && recoveryStage === "continued_twice") {
			writeBeacon(SELF, {
				state: "restart_requested",
				activity: "restarting",
				errorMessage: status.errorMessage,
				recoveryStage: "continued_twice",
			});
			return;
		}
		if (!successful && recoveryStage === "restarted") {
			writeBeacon(SELF, {
				state: "summary_requested",
				activity: "summarizing",
				errorMessage: status.errorMessage,
				recoveryStage: "restarted",
			});
			return;
		}

		if (recoveryStage !== "summarizing" && hasTeamWork(SELF)) {
			writeBeacon(SELF, { state: "running", activity: "must wait" });
			pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
			return;
		}

		const needsAttention = !successful;
		const terminalError =
			status.errorMessage ||
			(needsAttention ? "subagent produced no successful assistant response" : undefined);
		const finalText = collapseWhitespace(
			lastAssistantText(messages) || terminalError || "",
		);
		const resultFile = NOTIFY ? writeResultFile(SELF, messages) : undefined;
		const terminalPatch: Partial<Beacon> = {
			state: needsAttention ? "error" : "completed",
			errorMessage: terminalError,
			recoveryStage: successful ? "idle" : recoveryStage,
			resultFile,
		};
		if (finalText)
			terminalPatch.lastAssistantText = finalText.slice(
				0,
				ASSISTANT_PREVIEW_MAX,
			);
		writeBeacon(SELF, terminalPatch);
		if (NOTIFY && resultFile) {
			post({
				id: rid(),
				from: SELF,
				to: NOTIFY,
				body: resultReadyMessage(
					SELF,
					resultFile,
					needsAttention ? "attention" : "completed",
					terminalError,
				),
				kind: needsAttention ? "attention" : "completion",
				ts: now(),
			});
		}
	});
}

// --------------------------------------------------------------------------
// Compact orchestration indicator + interactive dashboard
// --------------------------------------------------------------------------

let uiReady = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let stallWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
let lastSig: string | undefined;
let runDismissed = false;
let suppressNextCoordinationNudge = false;
let lastMainRunMessages: unknown[] = [];
let lastChildRunMessages: unknown[] = [];

function readFeed(): string[] {
	try {
		return readFileSync(join(runDir, "feed.log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-FEED_TAIL);
	} catch {
		return [];
	}
}

function refreshView(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const agents = runDir ? listAgents() : [];
	const workers = agents.filter((agent) => agent.name !== ROOT_TASK_PATH);
	if (workers.length === 0 || runDismissed) {
		if (lastSig !== undefined) ctx.ui.setWidget(VIEW_KEY, undefined);
		lastSig = undefined;
		return;
	}
	const summary = orchestrationSummary(agents);
	if (summary === lastSig) return;
	lastSig = summary;
	ctx.ui.setWidget(
		VIEW_KEY,
		(_tui, theme) => ({
			render: (width: number) => [
				truncateToWidth(theme.fg("dim", summary), width),
			],
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}

function latestSessionFile(name: string): string | undefined {
	const dir = sessionsDir();
	if (!existsSync(dir)) return undefined;
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	if (!beacon) return undefined;
	const suffix = `_${beacon.taskId}.jsonl`;
	return readdirSync(dir)
		.filter((file) => file.endsWith(suffix))
		.map((file) => join(dir, file))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function dashboardSnapshot(selectedName?: string): DashboardSnapshot {
	const transcript = selectedName
		? readSessionTranscript(latestSessionFile(selectedName))
		: { lines: [] };
	return {
		agents: listAgents(),
		feed: readFeed(),
		transcript: transcript.lines,
		transcriptError: transcript.error,
	};
}

async function runDashboard(
	ctx: ExtensionCommandContext,
	initialName?: string,
): Promise<void> {
	if (!runDir) {
		ctx.ui.notify("No subagent run is available.", "info");
		return;
	}
	let selectedName = initialName;
	while (true) {
		let component: SubagentDashboard | undefined;
		let modalTimer: ReturnType<typeof setInterval> | undefined;
		const action = await ctx.ui.custom<DashboardAction | null>(
			(tui, theme, _keybindings, done) => {
				component = new SubagentDashboard(
					dashboardSnapshot(selectedName),
					selectedName,
					theme,
					() => tui.requestRender(),
					done,
					() => tui.terminal.rows,
				);
				modalTimer = setInterval(() => {
					if (!component) return;
					component.update(dashboardSnapshot(component.getSelectedName()));
					tui.requestRender();
				}, REFRESH_MS);
				modalTimer.unref();
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					margin: 0,
				},
			},
		);
		if (modalTimer) clearInterval(modalTimer);
		if (!action) return;
		selectedName = action.name;

		let result: string;
		if (action.action === "message") {
			const message = await ctx.ui.input(`Message ${action.name}`, "message");
			if (!message?.trim()) continue;
			result = sendAgentNotice(action.name, message.trim(), ctx);
		} else {
			const confirmed = await ctx.ui.confirm(
				`Stop ${action.name}?`,
				"Terminate this task process and all descendant processes?",
			);
			if (!confirmed) continue;
			result = killAgents(
				action.name,
				"requested from orchestration dashboard",
			).join("\n");
		}
		refreshView(ctx);
		if (result)
			ctx.ui.notify(result, action.action === "kill" ? "warning" : "info");
	}
}

async function inspectSubagentCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!runDir) {
		ctx.ui.notify("No subagent run is available.", "info");
		return;
	}
	const words = splitWords(args);
	if (
		words.length === 0 ||
		(words.length === 1 && words[0]?.toLowerCase() === "list")
	)
		return runDashboard(ctx);
	const [first, ...rest] = words;
	if (first?.toLowerCase() === "kill") {
		const target = rest[0];
		if (!target) {
			ctx.ui.notify("Usage: /subagent kill </root/task|*>", "error");
			return;
		}
		const lines = killAgents(target, "requested from /subagent");
		refreshView(ctx);
		ctx.ui.notify(lines.join("\n"), "warning");
		return;
	}

	const target = resolveAgent(first ?? "");
	if (!target || target.name === ROOT_TASK_PATH) {
		ctx.ui.notify(`Unknown task path ${first ?? ""}.`, "error");
		return;
	}
	const inlineMessage = rest.join(" ").trim();
	if (inlineMessage) {
		ctx.ui.notify(sendAgentNotice(target.name, inlineMessage, ctx), "info");
		return;
	}
	await runDashboard(ctx, target.name);
}

type ActiveLeafProgress = ProgressObservation & {
	agent: Beacon;
	pid?: number;
	tokens: number;
};

function tokenTotal(agent: Beacon): number {
	return (
		(agent.inputTokens ?? 0) +
		(agent.outputTokens ?? 0) +
		(agent.cacheReadTokens ?? 0) +
		(agent.cacheWriteTokens ?? 0)
	);
}

function sessionProgressAt(name: string): number {
	const file = latestSessionFile(name);
	if (!file) return 0;
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function activeLeafProgress(): ActiveLeafProgress[] {
	const agents = listAgents();
	const active = agents.filter(
		(agent) =>
			agent.name !== ROOT_TASK_PATH &&
			!INACTIVE.has(agent.state) &&
			(agent.state === "queued" ||
				RECOVERING.has(agent.state) ||
				isActive(agent.name)),
	);
	const liveParents = new Set(
		active.flatMap((agent) => (agent.parent ? [agent.parent] : [])),
	);
	return active
		.filter(
			(agent) =>
				agent.state !== "queued" &&
				agent.state !== "waiting" &&
				!liveParents.has(agent.name),
		)
		.map((agent) => ({
			taskPath: agent.name,
			progressAt: Math.max(agent.updatedAt, sessionProgressAt(agent.name)),
			agent,
			pid: activePid(agent.name),
			tokens: tokenTotal(agent),
		}));
}

function stalledActiveLeaves(observedAt = now()): ActiveLeafProgress[] {
	const leaves = activeLeafProgress();
	const stalled = new Set(
		stalledProgress(leaves, observedAt, STALL_TIMEOUT_MS).map(
			(observation) => observation.taskPath,
		),
	);
	return leaves.filter((leaf) => stalled.has(leaf.taskPath));
}

function durationText(durationMs: number): string {
	const minutes = Math.max(1, Math.floor(durationMs / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function stalledAlertBody(
	stalled: ActiveLeafProgress[],
	observedAt = now(),
): string {
	return [
		`Programmatic liveness monitor found ${stalled.length} stalled subagent${stalled.length === 1 ? "" : "s"}:`,
		...stalled.map((item) => {
			const inactive = durationText(observedAt - item.progressAt);
			const activity = item.agent.activity
				? `, last activity ${item.agent.activity}`
				: "";
			return `${item.taskPath}: no transcript, token, or runtime-event progress for ${inactive}${activity}; pid ${item.pid ?? "unknown"}, ${item.tokens} recorded tokens`;
		}),
		"Automatic recovery is exhausted; the task was stopped and marked failed.",
	].join("\n");
}

function rootIsBlocked(): boolean {
	if (!runDir) return false;
	const root = readJson<Beacon>(join(agentDir(ROOT_TASK_PATH), "beacon.json"));
	return (
		root?.state === "waiting" && activeDescendants(ROOT_TASK_PATH).length > 0
	);
}

function postStalledAlert(stalled: ActiveLeafProgress[]): void {
	for (const item of stalled) {
		appendFeed(`liveness: stalled ${item.taskPath}`);
		post({
			id: rid(),
			from: item.taskPath,
			to: item.agent.parent ?? ROOT_TASK_PATH,
			body: stalledAlertBody([item]),
			kind: "attention",
			topic: "stalled",
			taskPaths: [item.taskPath],
			ts: now(),
		});
	}
}

function restartStalledAgents(
	stalled: ActiveLeafProgress[],
	ctx: ExtensionContext,
): ActiveLeafProgress[] {
	return stalled.filter((item) => {
		const beacon = readJson<Beacon>(
			join(agentDir(item.taskPath), "beacon.json"),
		);
		if (
			!beacon ||
			INACTIVE.has(beacon.state) ||
			beacon.state === "queued" ||
			beacon.state === "waiting" ||
			activeDescendants(item.taskPath).length > 0
		)
			return false;
		const progressAt = Math.max(
			beacon.updatedAt,
			sessionProgressAt(item.taskPath),
		);
		if (now() - progressAt < STALL_TIMEOUT_MS) return false;

		const stage = beacon.recoveryStage ?? "idle";
		if (stage === "summarizing") return true;
		const summarize =
			beacon.state === "summary_requested" || stage === "restarted";
		const outcome = restartAgentProcess(
			item.taskPath,
			summarize ? RECOVERY_SUMMARY_PROMPT : AUTO_RECOVERY_PROMPT,
			ctx,
			beacon.generation ?? 1,
			summarize ? "summarizing" : "restarted",
			progressAt,
		);
		return !outcome.ok && !outcome.superseded;
	});
}

function failStalledAgents(
	stalled: ActiveLeafProgress[],
): ActiveLeafProgress[] {
	return stalled.filter((item) => {
		const beacon = readJson<Beacon>(
			join(agentDir(item.taskPath), "beacon.json"),
		);
		if (
			!beacon ||
			INACTIVE.has(beacon.state) ||
			beacon.recoveryStage !== "summarizing" ||
			now() - Math.max(beacon.updatedAt, sessionProgressAt(item.taskPath)) <
				STALL_TIMEOUT_MS
		)
			return false;
		killOneAgent(item.taskPath, "automatic recovery exhausted");
		writeBeacon(item.taskPath, {
			state: "error",
			activity: "",
			errorMessage: "automatic recovery exhausted after the task stalled",
		});
		return true;
	});
}

function runStallWatchdog(ctx: ExtensionContext): void {
	if (!rootIsBlocked()) return;
	const stalled = restartStalledAgents(stalledActiveLeaves(), ctx);
	if (stalled.length > 0)
		postStalledAlert(failStalledAgents(stalled));
	scheduleStallWatchdog(ctx);
}

function cancelStallWatchdog(): void {
	if (stallWatchdogTimer) clearTimeout(stallWatchdogTimer);
	stallWatchdogTimer = undefined;
}

function scheduleStallWatchdog(ctx: ExtensionContext): void {
	if (stallWatchdogTimer || !rootIsBlocked()) return;
	const leaves = activeLeafProgress();
	const deadline = nextProgressDeadline(leaves, STALL_TIMEOUT_MS);
	if (deadline === undefined) return;
	const delay = Math.max(1, Math.min(deadline - now(), 2_147_483_647));
	stallWatchdogTimer = setTimeout(() => {
		stallWatchdogTimer = undefined;
		runStallWatchdog(ctx);
	}, delay);
	stallWatchdogTimer.unref();
}

// --------------------------------------------------------------------------
// Entry
// --------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	if (IS_CHILD) assertRunSchema();
	registerTools(pi);
	registerCoordinationHooks(pi);

	if (IS_CHILD) {
		ensureDir(inboxDir(SELF));
		registerChildHooks(pi);
	}

	pi.on("session_shutdown", (_event, ctx) => {
		if (runDir) killAgents("*", "parent session shutting down");
		for (const child of kids.values()) {
			const pid = child.pid;
			if (pid) killPidTree(pid);
		}
		cancelStallWatchdog();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		if (!IS_CHILD && runDir) rmSync(join(runDir, ".root-pid"), { force: true });
		if (!IS_CHILD && ctx.mode === "tui") ctx.ui.setWidget(VIEW_KEY, undefined);
		uiReady = false;
		lastSig = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		piThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
		drainLaunchQueue(ctx);

		if (IS_CHILD || ctx.mode !== "tui" || uiReady) return;
		ctx.ui.setWidget(VIEW_KEY, undefined);
		lastSig = undefined;
		uiReady = true;
		sweepOldRuns();
		pi.registerCommand("subagents", {
			description: "Open the live subagent orchestration dashboard.",
			handler: async (args, cmdCtx) => {
				const requestedPath = args.trim();
				const target = requestedPath ? resolveAgent(requestedPath) : undefined;
				if (requestedPath && !target) {
					cmdCtx.ui.notify(`Unknown task path ${requestedPath}.`, "error");
					return;
				}
				await runDashboard(cmdCtx, target?.name);
			},
		});
		pi.registerCommand("subagent", {
			description:
				"Open, message, or stop a task: /subagent </root/task>, /subagent </root/task> <message>, /subagent kill </root/task|*>",
			handler: async (args, cmdCtx) => inspectSubagentCommand(args, cmdCtx),
		});
		refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
		refreshTimer.unref();
		refreshView(ctx);
	});
}

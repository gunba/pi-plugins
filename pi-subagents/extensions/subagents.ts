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
import { providerFailureHint } from "./provider-errors.ts";
import {
	SubagentDashboard,
	orchestrationSummary,
	type DashboardAction,
	type DashboardSnapshot,
} from "./subagent-dashboard.ts";
import { terminalRunCanHide } from "./run-lifecycle.ts";
import { readSessionTranscript } from "./session-transcript.ts";
import {
	assessBlockedAgents,
	type OverseerSnapshot,
} from "./subagent-overseer.ts";

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
const OVERSEER_INTERVAL_MS =
	positiveEnvInt("PI_SUBAGENTS_OVERSEER_INTERVAL_MS") ?? 600_000;
const RUN_TTL_MS = positiveEnvInt("PI_SUBAGENTS_RUN_TTL_MS") ?? 86_400_000; // sweep runs older than 24h
const FEED_TAIL = positiveEnvInt("PI_SUBAGENTS_FEED_TAIL") ?? 8;
const MAX_ACTIVE_CHILDREN = positiveEnvInt("PI_SUBAGENTS_MAX_ACTIVE") ?? 12;
const ASSISTANT_PREVIEW_MAX = 2000;
const ROOT_TASK_PATH = "/root";
const RUN_SCHEMA_VERSION = 2;
const COORDINATION_NOTICE =
	'Delegated work is pending. Call wait_agent. If the user asks to stop, call kill_agent with target "*".';
const INACTIVE = new Set(["completed", "error", "interrupted", "hard_killed"]);

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
};

type Mail = {
	id: string;
	from: string;
	to: string;
	body: string;
	replyTo?: string;
	kind?: "request" | "completion" | "attention" | "notice";
	approval?: SpawnApproval;
	approved?: boolean;
	ts: number;
};

type PendingQuestion = {
	from: string;
	id: string;
	body: string;
};

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

function finalAssistantStatus(messages: unknown[]): {
	stopReason?: string;
	errorMessage?: string;
} {
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

function statusNeedsAttention(status: {
	stopReason?: string;
	errorMessage?: string;
}): boolean {
	return (
		status.stopReason === "error" ||
		status.stopReason === "aborted" ||
		!!status.errorMessage
	);
}

function providerBackoffMessage(status: {
	stopReason?: string;
	errorMessage?: string;
}): string | undefined {
	const raw =
		`${status.stopReason ?? ""} ${status.errorMessage ?? ""}`.toLowerCase();
	if (!raw.trim()) return undefined;
	if (
		raw.includes("429") ||
		raw.includes("rate_limit") ||
		raw.includes("rate limit") ||
		raw.includes("too many requests") ||
		raw.includes("resource_exhausted") ||
		raw.includes("quota") ||
		raw.includes("overloaded")
	)
		return status.errorMessage || status.stopReason;
	return undefined;
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
	recoveryHint?: string,
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
		recoveryHint ? `Recovery: ${recoveryHint}` : undefined,
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
			(beacon.state === "queued" || isActive(beacon.name))
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
			(agent.state === "queued" || isActive(agent.name)),
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
			(!INACTIVE.has(agent.state) && !isActive(agent.name)),
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

// Atomically claim a fresh message so wait() and UI approval prompts cannot
// consume the same request. The claim file is not visible to inboxFiles().
function claimFresh(
	name: string,
	predicate: (msg: Mail) => boolean = () => true,
): { path: string; msg: Mail } | undefined {
	for (const f of inboxFiles(name)) {
		const path = join(inboxDir(name), f);
		const msg = readJson<Mail>(path);
		if (!msg || msg.replyTo || !predicate(msg)) continue;
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

function isNestedSpawnApproval(msg: Mail): boolean {
	return msg.kind === "request" && !!spawnApprovalDetails(msg);
}

function replyToNestedSpawnApproval(
	msg: Mail,
	approved: boolean,
	reason: string,
): void {
	post({
		id: rid(),
		from: SELF,
		to: msg.from,
		body: approved ? "approve" : reason,
		replyTo: msg.id,
		kind: "notice",
		approved,
		ts: now(),
	});
}

async function resolveNestedSpawnApprovalWithUser(
	ctx: ExtensionContext,
	msg: Mail,
): Promise<string> {
	const details = spawnApprovalDetails(msg);
	const label = details?.taskPath ? ` "${details.taskPath}"` : "";
	if (!ctx.hasUI) {
		const reason = "nested spawn approval requires an interactive UI";
		replyToNestedSpawnApproval(msg, false, reason);
		return `Denied nested spawn${label} from ${msg.from}: ${reason}.`;
	}

	let approved = false;
	try {
		approved = await ctx.ui.confirm(
			"Approve nested subagent?",
			[
				`${msg.from} wants to spawn${label}.`,
				"",
				"Task:",
				details?.message || msg.body,
				"",
				"Approve this nested spawn request?",
			].join("\n"),
		);
	} catch (error) {
		const reason = `user approval prompt failed: ${error instanceof Error ? error.message : String(error)}`;
		replyToNestedSpawnApproval(msg, false, reason);
		return `Denied nested spawn${label} from ${msg.from}: ${reason}.`;
	}
	replyToNestedSpawnApproval(
		msg,
		approved,
		approved ? "" : "user denied nested spawn request",
	);
	return `${approved ? "Approved" : "Denied"} nested spawn${label} from ${msg.from}.`;
}

function pendingQuestionFor(msg: Mail): PendingQuestion | undefined {
	if (msg.kind !== "request") return undefined;
	return {
		from: msg.from,
		id: msg.id,
		body: msg.body,
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
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	const fresh = claimFresh(SELF);
	if (fresh) {
		try {
			if (isNestedSpawnApproval(fresh.msg)) {
				const summary = await resolveNestedSpawnApprovalWithUser(
					ctx,
					fresh.msg,
				);
				if (ctx.hasUI) ctx.ui.notify(summary, "info");
				return waitForTeamEvent(ctx, signal);
			}
			pendingQuestion = pendingQuestionFor(fresh.msg);
			return `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`;
		} finally {
			rmSync(fresh.path, { force: true });
		}
	}
	if (activeDescendants(SELF).length === 0) return noWaitWorkMessage(SELF);
	await waitForDirectoryChange(inboxDir(SELF), signal);
	return waitForTeamEvent(ctx, signal);
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
		(agent) => agent.state !== "queued" && isActive(agent.name),
	);
}

function launchAgent(
	name: string,
	request: LaunchRequest,
	ctx: ExtensionContext,
): boolean {
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
					state: "spawning",
					startedAt: now(),
				}
			: {
					task: request.prompt,
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
		"--session-id",
		request.taskId,
		"--session-dir",
		sessionsDir(),
		"--exclude-tools",
		"ask_user",
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
	const finishUnexpected = (state: "error", body: string) => {
		rmSync(activeLock(name), { recursive: true, force: true });
		const b = readJson<Beacon>(join(agentDir(name), "beacon.json"));
		if (!b || !INACTIVE.has(b.state)) {
			writeBeacon(name, { state, errorMessage: body });
			post({
				id: rid(),
				from: name,
				to: SELF,
				body,
				kind: "attention",
				ts: now(),
			});
		}
		kids.delete(name);
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
): boolean {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const request: LaunchRequest = {
		prompt,
		fresh,
		taskName: taskName || beacon?.taskName || "",
		taskId: id ?? beacon?.taskId ?? taskId(),
		thinking: thinking ?? beacon?.thinking ?? piThinkingLevel,
		parent: fresh ? SELF : (beacon?.parent ?? SELF),
		notify: SELF,
		generation: fresh ? 1 : (beacon?.generation ?? 1) + 1,
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
	const removed = removePendingFrom(name);
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
				{ task_name: reservedPath, thinking },
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
			"Send downward instructions or ask an ancestor a blocking question.",
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
				refreshView(ctx);
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
		name: "wait_agent",
		label: "Wait for agents",
		description:
			"Wait until a child sends a message, finishes, or the user interrupts.",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			if (!runDir)
				return structured({ message: "No collaboration run exists." });
			if (pendingQuestion)
				return structured(
					{ message: `Reply to ${pendingQuestion.from} before waiting.` },
					`Reply to ${pendingQuestion.from} before waiting`,
				);
			if (!hasTeamWork(SELF))
				return structured(
					{ message: noWaitWorkMessage(SELF) },
					"No agent work pending",
				);
			writeBeacon(SELF, { state: "waiting", activity: "coordinating" });
			if (!IS_CHILD) scheduleOverseer(ctx);
			let event: string | undefined;
			try {
				event = await waitForTeamEvent(ctx, signal);
			} finally {
				if (!IS_CHILD) cancelOverseer();
				writeBeacon(SELF, { state: "running", activity: "" });
			}
			const interrupted = Boolean(signal?.aborted);
			if (interrupted) suppressNextCoordinationNudge = true;
			const message = interrupted
				? "Wait interrupted by user input."
				: (event ?? "Wait completed.");
			return structured({ message }, message);
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

function coordinationPrompt(): string {
	if (!pendingQuestion) return COORDINATION_NOTICE;
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
			"wait_agent",
			"kill_agent",
		];
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
		pi.on("agent_settled", (_event, ctx) => {
			const status = finalAssistantStatus(lastMainRunMessages);
			if (status.stopReason === "aborted" || suppressNextCoordinationNudge) {
				suppressNextCoordinationNudge = false;
				return;
			}
			const backoff = providerBackoffMessage(status);
			if (backoff) {
				if (ctx.hasUI && now() - lastProviderBackoffNoticeAt > 60_000) {
					lastProviderBackoffNoticeAt = now();
					ctx.ui.notify(
						`Subagent coordination paused after provider backoff: ${backoff}. Send a new message or use the collaboration tools when ready.`,
						"warning",
					);
				}
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

function registerChildHooks(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		writeBeacon(SELF, { state: "running" });
	});
	pi.on("tool_execution_start", (event) => {
		const name = (event as { toolName?: string }).toolName;
		writeBeacon(SELF, { state: "running", activity: name });
	});
	pi.on("message_end", (event) => {
		recordAssistantResponse((event as { message?: unknown }).message);
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
		const interrupted = status.stopReason === "aborted";
		const needsAttention = statusNeedsAttention(status);
		const recoveryHint = needsAttention
			? providerFailureHint(status)
			: undefined;

		if (hasTeamWork(SELF)) {
			writeBeacon(SELF, { state: "running", activity: "must wait" });
			pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
			return;
		}

		const finalText = collapseWhitespace(
			lastAssistantText(messages) || status.errorMessage || "",
		);
		const resultFile =
			NOTIFY && !interrupted ? writeResultFile(SELF, messages) : undefined;
		const terminalPatch: Partial<Beacon> = {
			state: interrupted
				? "interrupted"
				: needsAttention
					? "error"
					: "completed",
			errorMessage: needsAttention ? status.errorMessage : undefined,
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
					status.errorMessage,
					recoveryHint,
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
let approvalTimer: ReturnType<typeof setInterval> | undefined;
let overseerTimer: ReturnType<typeof setTimeout> | undefined;
let lastSig: string | undefined;
let runDismissed = false;
let suppressNextCoordinationNudge = false;
let lastProviderBackoffNoticeAt = 0;
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

// --------------------------------------------------------------------------
// Human nested-spawn approval
// --------------------------------------------------------------------------
let uiPrompting = false;

function startNestedSpawnApprovalPrompts(ctx: ExtensionContext): void {
	approvalTimer = setInterval(async () => {
		if (!runDir || uiPrompting) return;
		const fresh = claimFresh(SELF, isNestedSpawnApproval);
		if (!fresh) return;
		uiPrompting = true;
		try {
			const summary = await resolveNestedSpawnApprovalWithUser(ctx, fresh.msg);
			if (ctx.hasUI) ctx.ui.notify(summary, "info");
			refreshView(ctx);
		} finally {
			rmSync(fresh.path, { force: true });
			uiPrompting = false;
		}
	}, REFRESH_MS);
	approvalTimer.unref();
}

type OverseerSample = {
	cpuTicks?: number;
	tokens: number;
	transcriptHash: string;
};

const overseerSamples = new Map<string, OverseerSample>();
let overseerRunning = false;

function processCpuTicks(pid: number | undefined): number | undefined {
	if (!pid || process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = splitWords(stat.slice(stat.lastIndexOf(")") + 2));
		const user = Number(fields[11]);
		const system = Number(fields[12]);
		return Number.isFinite(user) && Number.isFinite(system)
			? user + system
			: undefined;
	} catch {
		return undefined;
	}
}

function tokenTotal(agent: Beacon): number {
	return (
		(agent.inputTokens ?? 0) +
		(agent.outputTokens ?? 0) +
		(agent.cacheReadTokens ?? 0) +
		(agent.cacheWriteTokens ?? 0)
	);
}

function isOverseerCandidate(
	agent: Beacon,
	hasLiveChild: Set<string>,
): boolean {
	return !(
		agent.name === ROOT_TASK_PATH ||
		INACTIVE.has(agent.state) ||
		agent.state === "queued" ||
		agent.state === "waiting" ||
		hasLiveChild.has(agent.name) ||
		now() - agent.startedAt < OVERSEER_INTERVAL_MS
	);
}

function snapshotAgent(agent: Beacon): OverseerSnapshot {
	const pid = activePid(agent.name);
	const cpuTicks = processCpuTicks(pid);
	const tokens = tokenTotal(agent);
	const transcriptTail = readSessionTranscript(
		latestSessionFile(agent.name),
		6000,
	).lines.slice(-40);
	const transcriptHash = createHash("sha256")
		.update(transcriptTail.join("\n"))
		.digest("hex");
	const previous = overseerSamples.get(agent.name);
	overseerSamples.set(agent.name, { cpuTicks, tokens, transcriptHash });
	return {
		taskPath: agent.name,
		state: agent.state,
		activity: agent.activity,
		runningForMs: now() - agent.startedAt,
		unchangedForMs: now() - agent.updatedAt,
		observedUpdatedAt: agent.updatedAt,
		pid,
		processAlive: Boolean(pid && processAlive(pid)),
		cpuTicks,
		cpuTicksSinceLastCheck:
			previous?.cpuTicks !== undefined && cpuTicks !== undefined
				? cpuTicks - previous.cpuTicks
				: undefined,
		tokens,
		tokensSinceLastCheck: previous ? tokens - previous.tokens : undefined,
		transcriptChangedSinceLastCheck: previous
			? transcriptHash !== previous.transcriptHash
			: undefined,
		transcriptTail,
	};
}

function overseerSnapshots(agents: Beacon[]): OverseerSnapshot[] {
	const hasLiveChild = new Set(
		agents.flatMap((agent) =>
			!INACTIVE.has(agent.state) && agent.parent ? [agent.parent] : [],
		),
	);
	const snapshots: OverseerSnapshot[] = [];
	for (const agent of [...agents].sort((a, b) => a.updatedAt - b.updatedAt)) {
		if (!isOverseerCandidate(agent, hasLiveChild)) continue;
		if (snapshots.length >= 24) break;
		snapshots.push(snapshotAgent(agent));
	}
	const current = new Set(snapshots.map((snapshot) => snapshot.taskPath));
	for (const name of overseerSamples.keys())
		if (!current.has(name)) overseerSamples.delete(name);
	return snapshots;
}

function safeToStop(
	current: Beacon | undefined,
	observed: OverseerSnapshot,
): boolean {
	if (
		!current ||
		INACTIVE.has(current.state) ||
		current.state === "queued" ||
		current.state === "waiting" ||
		current.updatedAt > observed.observedUpdatedAt ||
		activeChildren(current.name).length > 0 ||
		tokenTotal(current) > observed.tokens
	)
		return false;
	const latestCpuTicks = processCpuTicks(activePid(current.name));
	return !(
		latestCpuTicks !== undefined &&
		observed.cpuTicks !== undefined &&
		latestCpuTicks > observed.cpuTicks
	);
}

function rootIsBlocked(): boolean {
	if (!runDir) return false;
	const root = readJson<Beacon>(join(agentDir(ROOT_TASK_PATH), "beacon.json"));
	return (
		root?.state === "waiting" && activeDescendants(ROOT_TASK_PATH).length > 0
	);
}

async function runOverseer(ctx: ExtensionContext): Promise<void> {
	if (!rootIsBlocked() || overseerRunning) return;
	overseerRunning = true;
	try {
		const agents = listAgents();
		const snapshots = overseerSnapshots(agents);
		if (!snapshots.length) return;
		const decisions = await assessBlockedAgents(ctx, snapshots);
		if (!rootIsBlocked()) return;
		const candidates = new Map(
			snapshots.map((snapshot) => [snapshot.taskPath, snapshot]),
		);
		const stopped: Array<{ taskPath: string; reason: string; result: string }> =
			[];
		for (const decision of decisions) {
			const observed = candidates.get(decision.taskPath);
			if (!decision.blocked || !observed) continue;
			const current = resolveAgent(decision.taskPath);
			if (!safeToStop(current, observed)) continue;
			const result = killAgents(
				decision.taskPath,
				`overseer: ${decision.reason}`,
			).join("; ");
			stopped.push({
				taskPath: decision.taskPath,
				reason: decision.reason,
				result,
			});
		}
		if (stopped.length) {
			appendFeed(
				`overseer: stopped ${stopped.map((item) => item.taskPath).join(", ")}`,
			);
			post({
				id: rid(),
				from: stopped[0].taskPath,
				to: ROOT_TASK_PATH,
				body: `Overseer stopped blocked agents:\n${stopped.map((item) => `${item.taskPath}: ${item.reason} (${item.result})`).join("\n")}`,
				kind: "notice",
				ts: now(),
			});
			refreshView(ctx);
		} else {
			appendFeed(`overseer: checked ${snapshots.length}; no blocked agents`);
		}
	} catch (error) {
		appendFeed(
			`overseer: check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		overseerRunning = false;
	}
}

function cancelOverseer(): void {
	if (overseerTimer) clearTimeout(overseerTimer);
	overseerTimer = undefined;
}

function scheduleOverseer(ctx: ExtensionContext): void {
	if (overseerTimer || !rootIsBlocked()) return;
	overseerTimer = setTimeout(async () => {
		overseerTimer = undefined;
		await runOverseer(ctx);
		if (rootIsBlocked()) scheduleOverseer(ctx);
	}, OVERSEER_INTERVAL_MS);
	overseerTimer.unref();
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
		cancelOverseer();
		for (const timer of [refreshTimer, approvalTimer]) {
			if (timer) clearInterval(timer);
		}
		refreshTimer = undefined;
		approvalTimer = undefined;
		if (!IS_CHILD && runDir) rmSync(join(runDir, ".root-pid"), { force: true });
		if (!IS_CHILD && ctx.mode === "tui") ctx.ui.setWidget(VIEW_KEY, undefined);
		uiReady = false;
		lastSig = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		piThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
		drainLaunchQueue(ctx);
		if (!IS_CHILD && !approvalTimer) startNestedSpawnApprovalPrompts(ctx);

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

// pi-subagents — background pi processes as a coordinated team.
//
// A subagent is a fresh `pi --print` child with the same installed capabilities,
// given one task. Coordination is a filesystem mailbox under a shared run dir;
// teams and intercom are exposed through a Codex V2-shaped collaboration surface.

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
import { isAbsolute, join, resolve } from "node:path";
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
const WATCHDOG_MS = 15_000;
const STALE_MS = positiveEnvInt("PI_SUBAGENTS_STALE_MS") ?? 600_000;
const ACTIVE_TOOL_STALE_MS =
	positiveEnvInt("PI_SUBAGENTS_ACTIVE_TOOL_STALE_MS") ?? 1_800_000;
const RUN_TTL_MS = positiveEnvInt("PI_SUBAGENTS_RUN_TTL_MS") ?? 86_400_000; // sweep runs older than 24h
const FEED_TAIL = positiveEnvInt("PI_SUBAGENTS_FEED_TAIL") ?? 8;
const MAX_ACTIVE_CHILDREN = positiveEnvInt("PI_SUBAGENTS_MAX_ACTIVE") ?? 12;
const ASSISTANT_PREVIEW_MAX = 2000;
const ROOT_TASK_PATH = "/root";
const RUN_SCHEMA_VERSION = 2;
const WAIT_MIN_MS = 10_000;
const WAIT_MAX_MS = 3_600_000;
const COORDINATION_NOTICE =
	"Subagent coordination gate: child subagents are active or child messages are unread. Do not do independent work. Use spawn_agent, send_message, followup_task, wait_agent, interrupt_agent, or list_agents; root may also inspect or directly control any descendant. Handle child requests or attention events, then call wait_agent again. Read completion result files after no active subagents or pending messages remain.";

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
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type NestedSpawnApprovalMode = "agent" | "user";
type SpawnApproval = {
	type: "spawn";
	taskName: string;
	taskPath: string;
	message: string;
};

type Beacon = {
	name: string;
	taskId: string;
	parent: string | null;
	taskName: string;
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

type ControlMessage = {
	id: string;
	from: string;
	action: "steer" | "followUp" | "abort" | "setThinking";
	body?: string;
	thinking?: ThinkingLevel;
	ts: number;
};

type Mail = {
	id: string;
	from: string;
	to: string;
	body: string;
	replyTo?: string;
	kind?: "request" | "completion" | "attention" | "notice";
	approval?: SpawnApproval;
	ts: number;
};

type ActiveRequest = {
	from: string;
	id: string;
	body: string;
	kind: "request" | "attention" | "notice";
	approval?: SpawnApproval;
};

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

const now = () => Date.now();
const rid = () => randomUUID();
const ensureDir = (p: string) => mkdirSync(p, { recursive: true });

function taskId(): string {
	return `task-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
		!/^[a-z0-9_]+$/.test(taskName)
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
	return task.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function thinkingAtOrBelow(
	requested: ThinkingLevel | undefined,
	ceiling: ThinkingLevel,
): ThinkingLevel {
	const level = requested ?? ceiling;
	if (THINKING_LEVELS.indexOf(level) > THINKING_LEVELS.indexOf(ceiling)) {
		throw new Error(
			`Thinking level ${level} exceeds this agent's ${ceiling} ceiling.`,
		);
	}
	return level;
}

function writeJsonAtomic(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${rid()}.tmp`;
	writeFileSync(temp, JSON.stringify(value), { flag: "wx" });
	renameSync(temp, path);
}

function fmtAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
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

function expandPath(value: string, baseDir: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	if (isAbsolute(value)) return resolve(value);
	return resolve(baseDir, value);
}

function piAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured
		? expandPath(configured, homedir())
		: join(homedir(), ".pi", "agent");
}

function parseNestedSpawnApprovalMode(
	value: unknown,
): NestedSpawnApprovalMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "agent") return "agent";
	if (normalized === "user" || normalized === "modal" || normalized === "human")
		return "user";
	return undefined;
}

function readSubagentsSettings(path: string): Record<string, unknown> {
	return asRecord(readJson<Record<string, unknown>>(path)?.subagents) ?? {};
}

function nestedSpawnApprovalMode(
	ctx: ExtensionContext,
): NestedSpawnApprovalMode {
	const envMode = parseNestedSpawnApprovalMode(
		process.env.PI_SUBAGENTS_NESTED_SPAWN_APPROVAL,
	);
	if (envMode) return envMode;

	const globalSettings = readSubagentsSettings(
		join(piAgentDir(), "settings.json"),
	);
	const projectSettings = ctx.isProjectTrusted()
		? readSubagentsSettings(join(ctx.cwd, ".pi", "settings.json"))
		: {};
	const mergedSettings = { ...globalSettings, ...projectSettings };
	return (
		parseNestedSpawnApprovalMode(mergedSettings.nestedSpawnApproval) ?? "agent"
	);
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

function safeFileSegment(s: string): string {
	return (
		s
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "subagent"
	);
}

function resultDir(): string {
	return join(runDir, "results");
}

function writeResultFile(name: string, messages: unknown[]): string {
	ensureDir(resultDir());
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
		beacon?.taskName ? `Task: ${beacon.taskName}` : undefined,
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
			`${new Date().toISOString().replace(/[:.]/g, "-")}_${rid().slice(0, 8)}`,
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
function controlDir(name: string): string {
	return join(agentDir(name), "control");
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
		activity: patch.activity ?? prev?.activity,
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
	const children = listAgents().filter((a) => a.parent === name);
	if (!children.length)
		return "No agents to wait for — call spawn_agent first.";
	const attention = children.filter(
		(a) =>
			a.state === "error" ||
			a.state === "hard_killed" ||
			(!INACTIVE.has(a.state) && !isActive(a.name)),
	);
	if (attention.length) {
		const names = attention
			.map(
				(a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""} (${a.state})`,
			)
			.join(", ");
		return `No active subagents or pending messages for ${name}. Children needing attention: ${names}. Use followup_task to repair an affected task, or continue if repair is unnecessary.`;
	}
	return `No active subagents or pending messages for ${name}. Continue normally until new collaboration work is created.`;
}

function coordinationStatus(name: string): string {
	const active = activeDescendants(name).map(
		(a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""}`,
	);
	const pending = hasPendingFresh(name) ? "yes" : "no";
	return `active children: ${active.length ? active.join(", ") : "none"}; pending child message: ${pending}`;
}

function terminalRunReadyToHide(): boolean {
	if (!runDir) return false;
	const agents = listAgents().filter((a) => a.name !== ROOT_TASK_PATH);
	return terminalRunCanHide(
		agents,
		isActive,
		Boolean(activeRequest) || hasPendingFresh(SELF),
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
	const text = assistantTextFromMessage(message).replace(/\s+/g, " ").trim();
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
	appendFileSync(feedPath, `${line.replace(/\s+/g, " ").slice(0, 160)}\n`);
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

function spawnApprovalDetails(msg: { body: string; approval?: SpawnApproval }):
	| SpawnApproval
	| undefined {
	if (msg.approval?.type === "spawn") return msg.approval;
	const match = msg.body.match(
		/^\[approval]\s+spawn\s+"([^"]+)"\s+at\s+([^:]+):\s*([\s\S]*)$/i,
	);
	return match
		? {
				type: "spawn",
				taskName: match[1] ?? "task",
				taskPath: match[2]?.trim() ?? "",
				message: match[3] ?? "",
			}
		: undefined;
}

function isNestedSpawnApproval(msg: Mail): boolean {
	return msg.kind === "request" && !!spawnApprovalDetails(msg);
}

function approvalReplyAllowsSpawn(body: string): boolean {
	return /^\s*approve(?:\s*:\s*.*)?\s*$/i.test(body);
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
		body: approved ? "approve" : `deny: ${reason}`,
		replyTo: msg.id,
		kind: "notice",
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
		const reason =
			"user approval mode is enabled, but this session has no UI to confirm nested spawns";
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

function isCompletionNotice(msg: Mail): boolean {
	if (msg.kind) return msg.kind === "completion";
	return msg.body.startsWith("Completed") && msg.body.includes("Result file:");
}

function activeRequestFor(msg: Mail): ActiveRequest | undefined {
	if (isCompletionNotice(msg)) return undefined;
	const kind =
		msg.kind === "request" || msg.kind === "attention" ? msg.kind : "notice";
	return {
		from: msg.from,
		id: msg.id,
		body: msg.body,
		kind,
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
			if (
				isNestedSpawnApproval(fresh.msg) &&
				nestedSpawnApprovalMode(ctx) === "user"
			) {
				const summary = await resolveNestedSpawnApprovalWithUser(
					ctx,
					fresh.msg,
				);
				if (ctx.hasUI) ctx.ui.notify(summary, "info");
				return waitForTeamEvent(ctx, signal);
			}
			activeRequest = activeRequestFor(fresh.msg);
			return `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`;
		} finally {
			rmSync(fresh.path, { force: true });
		}
	}
	if (activeDescendants(SELF).length === 0) return noWaitWorkMessage(SELF);
	await waitForDirectoryChange(inboxDir(SELF), signal);
	return waitForTeamEvent(ctx, signal);
}

function controlFiles(name: string): string[] {
	const dir = controlDir(name);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort();
}

function postControl(name: string, control: ControlMessage): void {
	ensureDir(controlDir(name));
	writeFileSync(
		join(controlDir(name), `${control.ts}-${control.id}.json`),
		JSON.stringify(control),
		{ flag: "wx" },
	);
	appendFeed(
		`${control.from}→${name}: [${control.action}] ${control.body ?? control.thinking ?? ""}`,
	);
}

function claimControl(
	name: string,
): { path: string; control: ControlMessage } | undefined {
	for (const file of controlFiles(name)) {
		const path = join(controlDir(name), file);
		const control = readJson<ControlMessage>(path);
		if (!control) continue;
		const claimPath = `${path}.${process.pid}.${rid()}.claim`;
		try {
			renameSync(path, claimPath);
			return { path: claimPath, control };
		} catch {
			// Another watcher claimed it.
		}
	}
	return undefined;
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
	ensureDir(controlDir(name));
	ensureDir(sessionsDir());
	writeBeacon(
		name,
		request.fresh
			? {
					taskId: request.taskId,
					parent: request.parent,
					taskName: request.taskName,
					thinking: request.thinking,
					generation: request.generation,
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

	// Mark terminal before killing so the normal child exit handler does not post
	// another attention message for an intentional hard stop.
	writeBeacon(name, { state: "hard_killed", activity: "" });
	rmSync(launchFile(name), { force: true });
	kids.delete(name);
	const removed = removePendingFrom(name);
	if (activeRequest?.from === name) activeRequest = undefined;

	let killed = false;
	if (pid && processAlive(pid)) killed = killPidTree(pid);
	if (!pid || !processAlive(pid))
		rmSync(activeLock(name), { recursive: true, force: true });
	else
		setTimeout(() => {
			if (!processAlive(pid))
				rmSync(activeLock(name), { recursive: true, force: true });
		}, 250).unref();
	appendFeed(`${SELF}→${name}: killed (${reason})`);
	return `${name}: ${pid ? (killed ? `killed pid ${pid}` : `marked hard-killed; pid ${pid} did not terminate cleanly`) : "marked hard-killed; no live pid"}${removed ? `; cleared ${removed} pending message${removed === 1 ? "" : "s"}` : ""}`;
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
			? (children.get(SELF) ?? [])
					.filter((agent) => agent.state !== "completed")
					.flatMap((agent) => collect(agent.name))
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

function dismissActiveRequestFrom(
	taskPath: string,
	reason: string,
): ActiveRequest | undefined {
	const request = activeRequest;
	if (!request || request.from !== taskPath) return undefined;
	if (request.kind === "request") {
		post({
			id: rid(),
			from: SELF,
			to: request.from,
			body: `deny: ${reason}`,
			replyTo: request.id,
			kind: "notice",
			ts: now(),
		});
	}
	activeRequest = undefined;
	return request;
}

function sendAgentNotice(
	to: string,
	body: string,
	_ctx: ExtensionContext,
): string {
	if (!runDir) return "No run yet — spawn_agent first.";
	const target = resolveAuthorizedAgent(to);
	if (!target) return `Unknown or unauthorized task ${to}.`;
	post({
		id: rid(),
		from: SELF,
		to: target.name,
		body,
		kind: "notice",
		ts: now(),
	});
	return `Sent message to ${target.name}.`;
}

function controlAgent(
	selector: string,
	action: ControlMessage["action"],
	ctx: ExtensionContext,
	body?: string,
	thinking?: ThinkingLevel,
): string {
	if (!runDir) return "No run yet — spawn_agent first.";
	const target = resolveAuthorizedAgent(selector);
	if (!target || target.name === ROOT_TASK_PATH)
		return `Unknown or unauthorized subagent ${selector}.`;

	if (action === "setThinking") {
		if (!thinking) return "A thinking level is required.";
		const allowed = thinkingAtOrBelow(thinking, piThinkingLevel);
		writeBeacon(target.name, { thinking: allowed });
		if (isActive(target.name)) {
			postControl(target.name, {
				id: rid(),
				from: SELF,
				action,
				thinking: allowed,
				ts: now(),
			});
			return `Queued thinking ${allowed} for ${target.name}.`;
		}
		return `Set ${target.name} to thinking ${allowed} for its next run.`;
	}

	if (action === "abort") {
		const dismissed = dismissActiveRequestFrom(
			target.name,
			`interrupted by ${SELF}`,
		);
		if (!isActive(target.name))
			return dismissed
				? `Cleared the pending event from ${target.name}; it has no active turn.`
				: `${target.name} is not running.`;
		if (target.activity?.startsWith("interrupt requested by "))
			return `Interruption already requested for ${target.name}.`;
		writeBeacon(target.name, {
			activity: `interrupt requested by ${SELF}`,
		});
		postControl(target.name, { id: rid(), from: SELF, action, ts: now() });
		return `Requested interruption of ${target.name}.`;
	}

	const message = body?.trim();
	if (!message) return `A message is required for ${action}.`;
	if (!isActive(target.name)) {
		if (target.state === "queued")
			return `${target.name} is queued; its follow-up will run after launch.`;
		if (runAgent(target.name, message, ctx, false)) {
			refreshView(ctx);
			return `Started follow-up turn for ${target.name}.`;
		}
		return `${target.name} could not be resumed.`;
	}
	postControl(target.name, {
		id: rid(),
		from: SELF,
		action,
		body: message,
		ts: now(),
	});
	return `Queued ${action === "followUp" ? "follow-up" : "steer"} for ${target.name}.`;
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

function statusForModel(beacon: Beacon): unknown {
	if (beacon.name === ROOT_TASK_PATH && beacon.state === "running")
		return "running";
	if (beacon.state === "queued" || beacon.state === "spawning")
		return "pending_init";
	if (beacon.state === "running" || beacon.state === "waiting")
		return "running";
	if (beacon.state === "interrupted") return "interrupted";
	if (beacon.state === "completed")
		return { completed: beacon.lastAssistantText ?? null };
	if (beacon.state === "error")
		return {
			errored:
				beacon.errorMessage ?? beacon.lastAssistantText ?? "agent failed",
		};
	if (beacon.state === "hard_killed") return "shutdown";
	return "not_found";
}

function waitTimeout(value: number): number {
	if (!Number.isInteger(value) || value < WAIT_MIN_MS)
		throw new Error(`timeout_ms must be at least ${WAIT_MIN_MS}`);
	if (value > WAIT_MAX_MS)
		throw new Error(`timeout_ms must be at most ${WAIT_MAX_MS}`);
	return value;
}

async function waitForTeamEventOrTimeout(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<{ event?: string; timedOut: boolean; interrupted: boolean }> {
	if (timeoutMs === undefined) {
		const event = await waitForTeamEvent(ctx, signal);
		return {
			event,
			timedOut: false,
			interrupted: Boolean(signal?.aborted),
		};
	}
	const controller = new AbortController();
	let timedOut = false;
	let interrupted = false;
	const onAbort = () => {
		interrupted = true;
		controller.abort();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const event = await waitForTeamEvent(ctx, controller.signal);
		return { event, timedOut, interrupted };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn agent",
		description:
			"Spawn one isolated background agent for a concrete delegated task. The child starts with a clean model context and shares the working directory.",
		promptSnippet:
			"spawn_agent(task_name, message): delegate one bounded, independent task",
		promptGuidelines: [
			"Delegate only concrete independent work with a clear deliverable; avoid duplicate investigations and overlapping write ownership.",
			"After spawning, this Pi agent becomes an orchestration-only coordinator until direct children and unread child mail settle.",
			"Nested spawns require deliberate root approval; approve only useful, non-duplicative delegation.",
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

			if (IS_CHILD) {
				const reqId = rid();
				post({
					id: reqId,
					from: SELF,
					to: ROOT_TASK_PATH,
					body: `[approval] spawn "${taskName}" at ${taskPath}: ${message}`,
					kind: "request",
					approval: { type: "spawn", taskName, taskPath, message },
					ts: now(),
				});
				const reply = await pollFor(
					() => takeReply(SELF, reqId, ROOT_TASK_PATH),
					signal,
				);
				if (!reply) return structured({ error: "Approval wait interrupted." });
				if (!approvalReplyAllowsSpawn(reply.body))
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
				pi.getThinkingLevel() as ThinkingLevel,
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
				{ task_name: reservedPath },
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
			"Store a cooperative message independently of turn activation. Use reply_to to answer a correlated request.",
		promptSnippet:
			"send_message(target, message, reply_to?): queue coordination mail",
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute /root/... task path or path relative to the caller.",
				}),
				message: Type.String({ description: "Message to deliver." }),
				reply_to: Type.Optional(
					Type.String({ description: "Request id being answered." }),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!runDir) return structured({ error: "No collaboration run exists." });
			const target = resolveAuthorizedAgent(params.target);
			if (!target)
				return structured({
					error: `Unknown or unauthorized task ${params.target}.`,
				});
			const message = params.message.trim();
			if (!message) return structured({ error: "message must not be empty" });
			const id = rid();
			post({
				id,
				from: SELF,
				to: target.name,
				body: message,
				replyTo: params.reply_to,
				kind: "notice",
				ts: now(),
			});
			if (
				activeRequest &&
				target.name === activeRequest.from &&
				(params.reply_to === activeRequest.id ||
					(activeRequest.kind !== "request" &&
						target.name === activeRequest.from))
			)
				activeRequest = undefined;
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
		name: "followup_task",
		label: "Follow up task",
		description:
			"Start or queue a new turn for an existing agent while preserving its isolated session.",
		promptSnippet: "followup_task(target, message): continue an existing task",
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute /root/... task path or path relative to the caller.",
				}),
				message: Type.String({ description: "Follow-up task or correction." }),
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
					error: `Unknown or invalid follow-up target ${params.target}.`,
				});
			const message = params.message.trim();
			if (!message) return structured({ error: "message must not be empty" });
			let outcome: string;
			if (isActive(target.name) || target.state === "queued") {
				postControl(target.name, {
					id: rid(),
					from: SELF,
					action: "followUp",
					body: message,
					ts: now(),
				});
				outcome = `Queued follow-up for ${target.name}`;
			} else if (runAgent(target.name, message, ctx, false)) {
				outcome = `Started follow-up turn for ${target.name}`;
			} else {
				return structured({ error: `${target.name} could not be resumed.` });
			}
			if (
				activeRequest?.from === target.name &&
				activeRequest.kind !== "request"
			)
				activeRequest = undefined;
			refreshView(ctx);
			return structured({}, outcome);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `Follow up ${args.target}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait for agents",
		description:
			"Wait for team mailbox activity, a child lifecycle event, or user steering. An optional timeout enables deliberate polling.",
		promptSnippet: "wait_agent(): wait until collaboration activity",
		promptGuidelines: [
			"While Pi's coordination gate is active, call wait_agent without timeout_ms to yield until the team actually needs you.",
			"Set timeout_ms only for deliberate bounded polling; normal agent work may take minutes or hours.",
		],
		parameters: Type.Object(
			{
				timeout_ms: Type.Optional(
					Type.Integer({
						description: `Optional polling timeout in milliseconds. Omit to wait for team activity. Min ${WAIT_MIN_MS}, max ${WAIT_MAX_MS}.`,
						minimum: WAIT_MIN_MS,
						maximum: WAIT_MAX_MS,
					}),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments(args) {
			const input = asRecord(args);
			if (!input) throw new Error("wait_agent arguments must be an object");
			const unknown = Object.keys(input).find((key) => key !== "timeout_ms");
			if (unknown) throw new Error(`Unknown wait_agent argument: ${unknown}`);
			const timeout = input.timeout_ms;
			if (timeout === undefined) return {};
			if (typeof timeout !== "number" || !Number.isFinite(timeout))
				throw new Error("timeout_ms must be a finite number");
			return {
				timeout_ms: Math.min(
					WAIT_MAX_MS,
					Math.max(WAIT_MIN_MS, Math.round(timeout)),
				),
			};
		},
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!runDir)
				return structured({
					message: "No collaboration run exists.",
					timed_out: false,
				});
			const timeoutMs =
				params.timeout_ms === undefined
					? undefined
					: waitTimeout(params.timeout_ms);
			if (activeRequest)
				return structured(
					{ message: "Wait completed.", timed_out: false },
					`Request from ${activeRequest.from} is still pending`,
				);
			if (!hasTeamWork(SELF))
				return structured(
					{ message: noWaitWorkMessage(SELF), timed_out: false },
					"No agent work pending",
				);
			writeBeacon(SELF, { state: "waiting", activity: "coordinating" });
			const outcome = await waitForTeamEventOrTimeout(ctx, signal, timeoutMs);
			writeBeacon(SELF, { state: "running", activity: "" });
			if (outcome.interrupted) suppressNextCoordinationNudge = true;
			const message = outcome.interrupted
				? "Wait interrupted by new input."
				: outcome.timedOut
					? "Wait timed out."
					: "Wait completed.";
			return structured({ message, timed_out: outcome.timedOut }, message);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "Waiting for agents"), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt agent",
		description:
			"Interrupt an agent's current turn without destroying its resumable session. Root and self cannot be targeted.",
		promptSnippet: "interrupt_agent(target): interrupt a current agent turn",
		promptGuidelines: [
			"Call interrupt_agent once, then call wait_agent. Repeating it does not accelerate interruption.",
		],
		parameters: Type.Object(
			{
				target: Type.String({
					description:
						"Absolute /root/... task path or path relative to the caller.",
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
					error: `Unknown or invalid interrupt target ${params.target}.`,
				});
			const previousStatus = statusForModel(target);
			const dismissed = dismissActiveRequestFrom(
				target.name,
				`interrupted by ${SELF}`,
			);
			let display: string;
			if (!isActive(target.name)) {
				display = dismissed
					? `Cleared the pending event from ${target.name}; no active turn remains`
					: `${target.name} has no active turn`;
			} else if (target.activity?.startsWith("interrupt requested by ")) {
				display = `Interruption already requested for ${target.name}`;
			} else {
				writeBeacon(target.name, {
					activity: `interrupt requested by ${SELF}`,
				});
				postControl(target.name, {
					id: rid(),
					from: SELF,
					action: "abort",
					ts: now(),
				});
				display = `Requested interruption of ${target.name}`;
			}
			refreshView(ctx);
			return structured({ previous_status: previousStatus }, display);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("warning", `Interrupt ${args.target}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List agents",
		description:
			"List agents in the current /root task tree with stable Codex-shaped statuses.",
		promptSnippet: "list_agents(path_prefix?): inspect collaboration status",
		parameters: Type.Object(
			{
				path_prefix: Type.Optional(
					Type.String({
						description:
							"Absolute or caller-relative task-path prefix without a trailing slash.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, params) {
			if (!runDir) return structured({ agents: [] }, "No agents");
			const rawPrefix = params.path_prefix?.trim();
			if (rawPrefix?.endsWith("/"))
				return structured({
					error: "path_prefix must not have a trailing slash",
				});
			const prefix = !rawPrefix
				? ROOT_TASK_PATH
				: rawPrefix.startsWith("/")
					? rawPrefix
					: `${SELF}/${rawPrefix}`;
			const agents = listAgents()
				.filter(
					(agent) =>
						canAddress(agent) &&
						(agent.name === prefix || agent.name.startsWith(`${prefix}/`)),
				)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((agent) => ({
					agent_name: agent.name,
					agent_status: statusForModel(agent),
					last_task_message: agent.taskName,
				}));
			return structured(
				{ agents },
				`Listed ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
			);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "List agents"), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			return renderToolResult(result, isPartial, theme);
		},
	});

	if (!IS_CHILD) {
		pi.registerTool({
			name: "inspect_agent",
			label: "Inspect agent",
			description:
				"Read any descendant's active session branch, including reasoning, tool calls/results, provider errors, compactions, and assistant messages.",
			promptSnippet: "inspect_agent(target): inspect any descendant session",
			parameters: Type.Object(
				{
					target: Type.String({ description: "Absolute /root/... task path." }),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			async execute(_id, params) {
				if (!runDir) return text("No collaboration run exists.");
				const target = resolveAuthorizedAgent(params.target);
				if (!target || target.name === ROOT_TASK_PATH)
					return text(`Unknown subagent ${params.target}.`);
				return text(agentTranscript(target.name));
			},
		});

		pi.registerTool({
			name: "control_agent",
			label: "Control agent",
			description:
				"Directly steer any descendant or change its Pi thinking level. Use followup_task and interrupt_agent for lifecycle control.",
			promptSnippet:
				"control_agent(target, action, message?, thinking?): steer or retune any descendant",
			parameters: Type.Object(
				{
					target: Type.String({ description: "Absolute /root/... task path." }),
					action: StringEnum(["steer", "set_thinking"] as const),
					message: Type.Optional(
						Type.String({ description: "Required for steer." }),
					),
					thinking: Type.Optional(
						StringEnum(THINKING_LEVELS, {
							description: "Required for set_thinking.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const action =
					params.action === "set_thinking" ? "setThinking" : "steer";
				const result = controlAgent(
					params.target,
					action,
					ctx,
					params.message,
					params.thinking,
				);
				refreshView(ctx);
				return text(result);
			},
		});
	}
}

// --------------------------------------------------------------------------
// Coordination guardrails
// --------------------------------------------------------------------------

let spawnQueuedThisTurn = false;
let activeRequest: ActiveRequest | undefined;

function coordinationPrompt(): string {
	if (activeRequest) {
		const approval = activeRequest.approval;
		if (approval) {
			return [
				`Nested subagent spawn approval request from ${activeRequest.from} (id ${activeRequest.id}).`,
				`Requested child: ${approval.taskPath}`,
				`Task: ${approval.message}`,
				"Decide deliberately; do not rubber-stamp nested delegation.",
				"Approve only if the child task is independent, scoped, non-duplicative of active work, and worth the coordination overhead. Deny if the requester should do the work directly or needs a narrower plan.",
				`Reply with send_message(target: "${activeRequest.from}", reply_to: "${activeRequest.id}", message: "approve") or send_message(..., message: "deny: <reason>"), then call wait_agent again.`,
				coordinationStatus(SELF),
			].join("\n");
		}
		return [
			`Subagent coordination request from ${activeRequest.from} (id ${activeRequest.id}).`,
			activeRequest.kind === "request"
				? `Use any tools needed to satisfy the request, then reply with send_message(target: "${activeRequest.from}", reply_to: "${activeRequest.id}", message: ...), then call wait_agent again.`
				: `Handle or repair this event, then call wait_agent again. Use followup_task to resume ${activeRequest.from} or interrupt_agent to stop its current turn.`,
			`Request: ${activeRequest.body}`,
			coordinationStatus(SELF),
		].join("\n");
	}
	return `${COORDINATION_NOTICE}\n${coordinationStatus(SELF)}`;
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

	pi.on("turn_start", () => {
		spawnQueuedThisTurn = false;
	});

	pi.on("tool_execution_start", (event) => {
		if ((event as { toolName?: string }).toolName === "spawn_agent")
			spawnQueuedThisTurn = true;
	});

	pi.on("context", (event) => {
		if (!runDir || (!activeRequest && !hasTeamWork(SELF))) return;
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: coordinationPrompt() }],
					timestamp: now(),
				} as any,
			],
		};
	});

	pi.on("tool_call", (event) => {
		const toolName = (event as { toolName?: string }).toolName ?? "";
		if (spawnQueuedThisTurn && toolName !== "spawn_agent") {
			return {
				block: true,
				reason:
					"Do not combine spawn_agent with other tools in the same turn. Let it return, then coordinate in the next turn.",
			};
		}
		if (
			runDir &&
			hasTeamWork(SELF) &&
			!activeRequest &&
			toolName !== "spawn_agent" &&
			toolName !== "send_message" &&
			toolName !== "followup_task" &&
			toolName !== "wait_agent" &&
			toolName !== "interrupt_agent" &&
			toolName !== "list_agents" &&
			toolName !== "inspect_agent" &&
			toolName !== "control_agent"
		) {
			return { block: true, reason: coordinationPrompt() };
		}
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
			if (runDir && (activeRequest || hasTeamWork(SELF)))
				pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
		});
	}
}

// --------------------------------------------------------------------------
// Child beacons
// --------------------------------------------------------------------------

function drainControls(pi: ExtensionAPI, ctx: ExtensionContext): void {
	while (true) {
		const claimed = claimControl(SELF);
		if (!claimed) return;
		try {
			const control = claimed.control;
			if (control.action === "abort") {
				writeBeacon(SELF, { activity: `abort requested by ${control.from}` });
				ctx.abort();
			} else if (control.action === "setThinking" && control.thinking) {
				pi.setThinkingLevel(control.thinking);
				piThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
				writeBeacon(SELF, {
					thinking: piThinkingLevel,
					activity: `thinking ${piThinkingLevel}`,
				});
			} else if (control.body) {
				const deliverAs = control.action === "followUp" ? "followUp" : "steer";
				pi.sendUserMessage(control.body, { deliverAs });
				writeBeacon(SELF, { activity: `${deliverAs} from ${control.from}` });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeBeacon(SELF, { activity: `control error: ${message}` });
			if (PARENT)
				post({
					id: rid(),
					from: SELF,
					to: PARENT,
					body: `Direct control failed: ${message}`,
					kind: "attention",
					ts: now(),
				});
		} finally {
			rmSync(claimed.path, { force: true });
		}
	}
}

function startControlWatcher(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ensureDir(controlDir(SELF));
	controlWatcher?.close();
	controlWatcher = watch(controlDir(SELF), () => drainControls(pi, ctx));
	controlWatcher.unref();
	controlFallbackTimer && clearInterval(controlFallbackTimer);
	controlFallbackTimer = setInterval(
		() => drainControls(pi, ctx),
		INBOX_FALLBACK_MS,
	);
	controlFallbackTimer.unref();
	drainControls(pi, ctx);
}

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

		const finalText = (lastAssistantText(messages) || status.errorMessage || "")
			.replace(/\s+/g, " ")
			.trim();
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
let watchdogTimer: ReturnType<typeof setInterval> | undefined;
let controlFallbackTimer: ReturnType<typeof setInterval> | undefined;
let controlWatcher: ReturnType<typeof watch> | undefined;
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

function agentTranscript(name: string, maxChars = 24_000): string {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	if (!beacon) return `No agent named ${name}.`;
	const lines = [
		`# ${name}`,
		beacon.taskName ? `Task: ${beacon.taskName}` : undefined,
		`State: ${beacon.state}${beacon.activity ? ` (${beacon.activity})` : ""}`,
		`Started: ${new Date(beacon.startedAt).toLocaleString()}`,
		beacon.model ? `Model: ${beacon.model}` : undefined,
		beacon.thinking ? `Thinking: ${beacon.thinking}` : undefined,
		"",
	].filter((line): line is string => line !== undefined);

	const file = latestSessionFile(name);
	const transcript = readSessionTranscript(file, maxChars);
	if (file) lines.push(`Session: ${file}`, "");
	if (transcript.error)
		lines.push(`Session read warning: ${transcript.error}`, "");
	if (transcript.lines.length) lines.push(...transcript.lines);
	else if (beacon.lastAssistantText)
		lines.push("Last assistant message:", beacon.lastAssistantText);
	else lines.push("No session entries yet.");
	return lines.join("\n");
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

		let result: string | undefined;
		if (
			action.action === "message" ||
			action.action === "steer" ||
			action.action === "followUp"
		) {
			const label =
				action.action === "message"
					? "Message"
					: action.action === "steer"
						? "Steer"
						: "Follow up";
			const message = await ctx.ui.input(`${label} ${action.name}`, "message");
			if (!message?.trim()) continue;
			result =
				action.action === "message"
					? sendAgentNotice(action.name, message.trim(), ctx)
					: controlAgent(action.name, action.action, ctx, message.trim());
		} else if (action.action === "thinking") {
			const ceiling = piThinkingLevel;
			const choices = THINKING_LEVELS.slice(
				0,
				THINKING_LEVELS.indexOf(ceiling) + 1,
			);
			const level = await ctx.ui.select(
				`Thinking for ${action.name} (root ceiling: ${ceiling})`,
				[...choices],
			);
			if (!level) continue;
			result = controlAgent(
				action.name,
				"setThinking",
				ctx,
				undefined,
				level as ThinkingLevel,
			);
		} else {
			const confirmed = await ctx.ui.confirm(
				action.action === "kill"
					? `Emergency stop ${action.name}?`
					: `Interrupt ${action.name}?`,
				action.action === "kill"
					? "Terminate this task process and all descendant processes?"
					: "Gracefully interrupt the current turn and preserve its session?",
			);
			if (!confirmed) continue;
			result =
				action.action === "kill"
					? killAgents(
							action.name,
							"requested from orchestration dashboard",
						).join("\n")
					: controlAgent(action.name, "abort", ctx);
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
	const trimmed = args.trim();
	if (!trimmed || /^list$/i.test(trimmed)) return runDashboard(ctx);
	const [first, ...rest] = trimmed.split(/\s+/);
	if (/^kill$/i.test(first ?? "")) {
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
// Human prompts (root + UI only): approvals and stuck agents are user decisions
// --------------------------------------------------------------------------

const flagged = new Map<string, number>();
let uiPrompting = false;

function startNestedSpawnApprovalPrompts(ctx: ExtensionContext): void {
	approvalTimer = setInterval(async () => {
		if (!runDir || uiPrompting || nestedSpawnApprovalMode(ctx) !== "user")
			return;
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

function startWatchdog(ctx: ExtensionContext): void {
	watchdogTimer = setInterval(async () => {
		if (!runDir || uiPrompting) return;
		const agents = listAgents();
		const hasLiveChild = new Set(
			agents
				.filter((agent) => !INACTIVE.has(agent.state))
				.map((agent) => agent.parent)
				.filter((parent): parent is string => !!parent),
		);
		for (const agent of agents) {
			if (agent.name === ROOT_TASK_PATH || INACTIVE.has(agent.state)) continue;
			const flaggedAt = flagged.get(agent.name);
			if (flaggedAt !== undefined && agent.updatedAt > flaggedAt)
				flagged.delete(agent.name);
			if (
				flagged.has(agent.name) ||
				agent.state === "queued" ||
				agent.state === "waiting" ||
				hasLiveChild.has(agent.name)
			)
				continue;
			const staleMs = agent.activity ? ACTIVE_TOOL_STALE_MS : STALE_MS;
			if (now() - agent.updatedAt < staleMs) continue;
			flagged.set(agent.name, agent.updatedAt);
			uiPrompting = true;
			let stop = false;
			try {
				stop = await ctx.ui.confirm(
					"Subagent stuck?",
					`${agent.name} — no progress for ${fmtAge(now() - agent.updatedAt)}. Stop it and its descendants?`,
				);
			} finally {
				uiPrompting = false;
			}
			if (stop) {
				const messages = killAgents(
					agent.name,
					`watchdog after ${fmtAge(now() - agent.updatedAt)} without progress`,
				);
				post({
					id: rid(),
					from: agent.name,
					to: ROOT_TASK_PATH,
					body: `${messages.join("; ")}. Inspect the task or use followup_task if repair is needed.`,
					kind: "attention",
					ts: now(),
				});
				refreshView(ctx);
			}
		}
	}, WATCHDOG_MS);
	watchdogTimer.unref();
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
		ensureDir(controlDir(SELF));
		registerChildHooks(pi);
	}

	pi.on("session_shutdown", (_event, ctx) => {
		if (runDir) killAgents("*", "parent session shutting down");
		for (const child of kids.values()) {
			const pid = child.pid;
			if (pid) killPidTree(pid);
		}
		for (const timer of [
			refreshTimer,
			approvalTimer,
			watchdogTimer,
			controlFallbackTimer,
		]) {
			if (timer) clearInterval(timer);
		}
		refreshTimer = undefined;
		approvalTimer = undefined;
		watchdogTimer = undefined;
		controlFallbackTimer = undefined;
		controlWatcher?.close();
		controlWatcher = undefined;
		if (!IS_CHILD && runDir) rmSync(join(runDir, ".root-pid"), { force: true });
		if (!IS_CHILD && ctx.mode === "tui") ctx.ui.setWidget(VIEW_KEY, undefined);
		uiReady = false;
		lastSig = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		piThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
		if (IS_CHILD) startControlWatcher(pi, ctx);
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
				"Open, message, or emergency-stop a task: /subagent </root/task>, /subagent </root/task> <message>, /subagent kill </root/task|*>",
			handler: async (args, cmdCtx) => inspectSubagentCommand(args, cmdCtx),
		});
		startNestedSpawnApprovalPrompts(ctx);
		startWatchdog(ctx);
		refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
		refreshTimer.unref();
		refreshView(ctx);
	});
}

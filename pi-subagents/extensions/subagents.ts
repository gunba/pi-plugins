// pi-subagents — background pi processes as a coordinated team.
//
// A subagent is a fresh `pi --print` child with the same installed capabilities,
// given one task. Coordination is a filesystem mailbox under a shared run dir;
// teams and intercom are emergent from three tools (spawn, message, wait).

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
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
const COORDINATION_NOTICE =
	"Subagent coordination gate: child subagents are active or child messages are unread. Do not do independent work. You may spawn additional subagents, message children, kill a wedged child, or call wait; main may also inspect or directly control any descendant. When wait returns a child request or attention event, use tools if needed, then reply/resume with message or kill the child and call wait again. Read completion result files after wait reports no active subagents or pending messages.";

const TERMINAL = new Set(["done", "error", "stopped"]);
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
type SpawnApproval = { type: "spawn"; name: string; task: string };

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

export function normalizeAgentName(value: string): string {
	const name = value.normalize("NFKC").trim();
	if (!/^\p{L}[\p{L}\p{M}'’-]{0,31}$/u.test(name)) {
		throw new Error(
			"Subagent name must be one first name (letters with optional apostrophe or hyphen, at most 32 characters).",
		);
	}
	return `${name[0]!.toLocaleUpperCase()}${name.slice(1)}`;
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
		`${stamp}_${safeFileSegment(name)}_${beacon?.taskId ?? "task"}_${rid().slice(0, 8)}.md`,
	);
	const status = finalAssistantStatus(messages);
	const body =
		lastAssistantText(messages) ||
		status.errorMessage ||
		(statusNeedsAttention(status) ? "(needs attention)" : "(completed)");
	const header = [
		`# Subagent result: ${name}`,
		"",
		beacon?.taskId ? `Task ID: ${beacon.taskId}` : undefined,
		beacon?.taskName ? `Task: ${beacon.taskName}` : undefined,
		beacon?.parent ? `Parent: ${beacon.parent}` : undefined,
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
	state: "done" | "attention",
	errorMessage?: string,
	recoveryHint?: string,
): string {
	const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
	const label = beacon
		? ` · ${beacon.taskId}${beacon.taskName ? ` · ${beacon.taskName}` : ""}`
		: "";
	const head =
		state === "done"
			? `Completed${label}.`
			: `Needs attention${label}.${errorMessage ? ` ${errorMessage}` : ""}`;
	return `${head}${recoveryHint ? `\nRecovery: ${recoveryHint}` : ""}\nResult file: ${path}`;
}

// --------------------------------------------------------------------------
// Run + identity (module state: each pi process is one agent)
// --------------------------------------------------------------------------

const SELF = process.env.PI_SUBAGENT_NAME || "main";
const PARENT = process.env.PI_SUBAGENT_PARENT || null;
const IS_CHILD = !!process.env.PI_SUBAGENT_NAME;

let runDir = process.env.PI_SUBAGENT_RUN || "";
const kids = new Map<string, ChildProcess>();
let piThinkingLevel: ThinkingLevel = "medium";

function ensureRun(): string {
	if (!runDir) {
		runDir = join(
			BASE,
			`${new Date().toISOString().replace(/[:.]/g, "-")}_${rid().slice(0, 8)}`,
		);
		ensureDir(runDir);
		if (!IS_CHILD) {
			writeFileSync(join(runDir, ".root-pid"), `${process.pid}\n`);
			writeBeacon("main", {
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
	return join(runDir, name);
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
			patch.taskId ?? prev?.taskId ?? (name === "main" ? "main" : taskId()),
		parent: patch.parent ?? prev?.parent ?? (name === SELF ? PARENT : null),
		taskName: patch.taskName ?? prev?.taskName ?? "",
		state,
		activity: patch.activity ?? prev?.activity,
		startedAt: prev?.startedAt ?? patch.startedAt ?? now(),
		updatedAt: now(),
		finishedAt: TERMINAL.has(state) ? (prev?.finishedAt ?? now()) : undefined,
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
	};
	writeJsonAtomic(join(dir, "beacon.json"), beacon);
}

function listAgents(): Beacon[] {
	if (!runDir || !existsSync(runDir)) return [];
	const out: Beacon[] = [];
	for (const entry of readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const b = readJson<Beacon>(join(runDir, entry.name, "beacon.json"));
		if (b) out.push(b);
	}
	return out;
}

function activeChildren(parent: string): Beacon[] {
	const dir = childrenDir(parent);
	if (!existsSync(dir)) return [];
	const out: Beacon[] = [];
	for (const child of readdirSync(dir)) {
		const beacon = readJson<Beacon>(join(agentDir(child), "beacon.json"));
		if (
			beacon &&
			!TERMINAL.has(beacon.state) &&
			(beacon.state === "queued" || isActive(beacon.name))
		)
			out.push(beacon);
	}
	return out;
}

function registerChild(parent: string, child: string): void {
	ensureDir(childrenDir(parent));
	writeFileSync(join(childrenDir(parent), child), "", { flag: "wx" });
}

function hasPendingFresh(name: string): boolean {
	return !!peekFresh(name);
}

function hasTeamWork(name: string): boolean {
	return hasPendingFresh(name) || activeChildren(name).length > 0;
}

function noWaitWorkMessage(name: string): string {
	const children = listAgents().filter((a) => a.parent === name);
	if (!children.length)
		return "No subagents to wait for — spawn a subagent first.";
	const attention = children.filter(
		(a) =>
			a.state === "error" ||
			a.state === "stopped" ||
			(!TERMINAL.has(a.state) && !isActive(a.name)),
	);
	if (attention.length) {
		const names = attention
			.map(
				(a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""} (${a.state})`,
			)
			.join(", ");
		return `No active subagents or pending messages for ${name}. Children needing attention: ${names}. Repair by messaging/resuming the affected agent, or continue if no repair is needed.`;
	}
	return `No active subagents or pending messages for ${name}. Continue normally; do not call wait again until you spawn or message a subagent.`;
}

function coordinationStatus(name: string): string {
	const active = activeChildren(name).map(
		(a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""}`,
	);
	const pending = hasPendingFresh(name) ? "yes" : "no";
	return `active children: ${active.length ? active.join(", ") : "none"}; pending child message: ${pending}`;
}

function terminalRunReadyToHide(): boolean {
	if (!runDir) return false;
	const agents = listAgents().filter((a) => a.name !== "main");
	return terminalRunCanHide(agents, isActive, hasPendingFresh(SELF));
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
		/^\[approval]\s+spawn\s+"([^"]+)":\s*([\s\S]*)$/i,
	);
	return match
		? { type: "spawn", name: match[1] ?? "subagent", task: match[2] ?? "" }
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
	const label = details?.name ? ` "${details.name}"` : "";
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
				details?.task || msg.body,
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
	while (!signal?.aborted) {
		const v = fn();
		if (v !== undefined) return v;
		await waitForDirectoryChange(inboxDir(SELF), signal);
	}
	return undefined;
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
	while (!signal?.aborted) {
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
					continue;
				}
				activeRequest = activeRequestFor(fresh.msg);
				return `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`;
			} finally {
				rmSync(fresh.path, { force: true });
			}
		}
		if (activeChildren(SELF).length === 0) return noWaitWorkMessage(SELF);
		await waitForDirectoryChange(inboxDir(SELF), signal);
	}
	return undefined;
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

function allocName(requested: string): string {
	ensureRun();
	const name = normalizeAgentName(requested);
	if (
		listAgents().some(
			(agent) =>
				agent.name.localeCompare(name, undefined, { sensitivity: "base" }) ===
				0,
		)
	) {
		throw new Error(
			`A subagent named ${name} already exists in this run. Choose another first name.`,
		);
	}
	const namesDir = join(runDir, ".names");
	ensureDir(namesDir);
	const nameLock = join(
		namesDir,
		Buffer.from(name.normalize("NFKC").toLocaleLowerCase()).toString(
			"base64url",
		),
	);
	let reserved = false;
	try {
		writeFileSync(nameLock, name, { flag: "wx" });
		reserved = true;
		mkdirSync(agentDir(name));
		return name;
	} catch (error) {
		if (reserved) rmSync(nameLock, { force: true });
		if ((error as { code?: string }).code === "EEXIST")
			throw new Error(`A subagent named ${name} already exists in this run.`);
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
					parent: SELF,
					taskName: request.taskName,
					thinking: request.thinking,
					state: "spawning",
					startedAt: now(),
				}
			: { thinking: request.thinking, state: "running" },
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
			PI_SUBAGENT_NAME: name,
			PI_SUBAGENT_TASK_ID: request.taskId,
			PI_SUBAGENT_PARENT: SELF,
		},
		stdio: "ignore",
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	if (typeof child.pid === "number")
		writeFileSync(activePidFile(name), `${child.pid}\n`);
	kids.set(name, child);
	rmSync(launchFile(name), { force: true });
	const finishUnexpected = (state: "error" | "stopped", body: string) => {
		rmSync(activeLock(name), { recursive: true, force: true });
		const b = readJson<Beacon>(join(agentDir(name), "beacon.json"));
		if (!b || !TERMINAL.has(b.state)) {
			writeBeacon(name, { state });
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
			"stopped",
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
	};
	if (isActive(name)) return false;
	if (runningDirectChildren().length >= MAX_ACTIVE_CHILDREN) {
		ensureDir(agentDir(name));
		writeJsonAtomic(launchFile(name), request);
		writeBeacon(name, {
			taskId: request.taskId,
			parent: fresh ? SELF : beacon?.parent,
			taskName: request.taskName,
			thinking: request.thinking,
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
	writeBeacon(name, { state: "stopped", activity: "" });
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
	return `${name}: ${pid ? (killed ? `killed pid ${pid}` : `marked stopped; pid ${pid} did not terminate cleanly`) : "marked stopped; no live pid"}${removed ? `; cleared ${removed} pending message${removed === 1 ? "" : "s"}` : ""}`;
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
	const selected = agents.find(
		(agent) =>
			agent.name.localeCompare(selector.trim(), undefined, {
				sensitivity: "base",
			}) === 0 || agent.taskId === selector.trim(),
	);
	const names =
		selector.trim() === "*"
			? (children.get(SELF) ?? [])
					.filter((agent) => agent.state !== "done")
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
	return listAgents().find(
		(agent) =>
			agent.name.localeCompare(normalized, undefined, {
				sensitivity: "base",
			}) === 0 || agent.taskId === normalized,
	);
}

function sendAgentNotice(
	to: string,
	body: string,
	ctx: ExtensionContext,
): string {
	if (!runDir) return "No run yet — spawn a subagent first.";
	const target =
		to === "main"
			? readJson<Beacon>(join(agentDir("main"), "beacon.json"))
			: resolveAgent(to);
	if (!target) return `No agent named or identified by ${to}.`;
	if (
		target.name !== "main" &&
		!isActive(target.name) &&
		target.state !== "queued" &&
		runAgent(target.name, body, ctx, false)
	) {
		if (activeRequest && activeRequest.from === target.name)
			activeRequest = undefined;
		refreshView(ctx);
		return `Re-addressing ${target.name} · ${target.taskId} (resuming its session). Call wait for its result.`;
	}
	post({
		id: rid(),
		from: SELF,
		to: target.name,
		body,
		kind: "notice",
		ts: now(),
	});
	return `Sent to ${target.name} · ${target.taskId}.`;
}

function controlAgent(
	selector: string,
	action: ControlMessage["action"],
	ctx: ExtensionContext,
	body?: string,
	thinking?: ThinkingLevel,
): string {
	if (!runDir) return "No run yet — spawn a subagent first.";
	const target = resolveAgent(selector);
	if (!target || target.name === "main")
		return `No subagent named or identified by ${selector}.`;

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
			return `Queued thinking ${allowed} for ${target.name} · ${target.taskId}.`;
		}
		return `Set ${target.name} · ${target.taskId} to thinking ${allowed} for its next run.`;
	}

	if (action === "abort") {
		if (!isActive(target.name)) return `${target.name} is not running.`;
		postControl(target.name, { id: rid(), from: SELF, action, ts: now() });
		return `Requested a graceful abort from ${target.name} · ${target.taskId}.`;
	}

	const message = body?.trim();
	if (!message) return `A message is required for ${action}.`;
	if (!isActive(target.name)) {
		if (target.state === "queued")
			return `${target.name} is queued; use message for cooperative delivery after it starts.`;
		if (runAgent(target.name, message, ctx, false)) {
			refreshView(ctx);
			return `Resuming ${target.name} · ${target.taskId} with the message.`;
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
	return `Queued ${action === "followUp" ? "follow-up" : "steer"} for ${target.name} · ${target.taskId}.`;
}

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

const text = (t: string) => ({
	content: [{ type: "text" as const, text: t }],
	details: {},
});

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spawn",
		label: "Spawn subagent",
		description:
			"Start a background subagent — a fresh pi with your tools and a clean context — for one delegated task.",
		promptSnippet:
			"spawn(task, name, thinking?): delegate one suitable subtask to a named background subagent",
		promptGuidelines: [
			"Use spawn only when delegation fits: independent parallel work, competing hypotheses, or context-heavy investigation whose details need not stay in your context.",
			"Outline the task for the subagent and be clear about the result you want, e.g. findings, an implementation, changed files, open questions, exact paths/ranges, and how to handle blockers or uncertainty.",
			"Choose a distinct human first name for each subagent. Pi assigns a separate task id for tracking and routing.",
			"Set thinking only when the delegated task needs less reasoning than this agent; a subagent cannot exceed its parent's thinking level.",
			"After spawning one or more subagents, use `wait`, `message`, and `kill` to coordinate. While child subagents are active or messages are unread, pi-subagents only permits orchestration tools; main can also use `inspect_agent` and `control_agent` for direct descendant intervention.",
			"Nested subagent spawn requests need deliberate approval. Approve only when the requested child is independent, scoped, non-duplicative, and worth the coordination overhead; otherwise deny or ask the requester to narrow its plan.",
			"Reply to nested spawn approval requests with exactly `approve` or `deny: <reason>` unless `subagents.nestedSpawnApproval` is `user`, in which case pi-subagents asks the user in a modal and replies for you. A stuck subagent never lets `wait` run with no live work — `wait` is interruptible and `/subagents` shows the subagent tree.",
		],
		parameters: Type.Object({
			task: Type.String({
				description:
					"One delegated objective. Include constraints, done criteria, and the result you want.",
			}),
			name: Type.String({
				description:
					"A distinct human first name chosen for this subagent (for example Maya or Leo).",
			}),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description:
						"Thinking level for the subagent. Defaults to this agent's level and cannot exceed it.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!IS_CHILD && runDir && terminalRunReadyToHide()) {
				rmSync(join(runDir, ".root-pid"), { force: true });
				runDir = "";
				runDismissed = false;
			}
			ensureRun();
			const name = normalizeAgentName(params.name);
			const thinking = thinkingAtOrBelow(
				params.thinking,
				pi.getThinkingLevel() as ThinkingLevel,
			);

			if (IS_CHILD) {
				const reqId = rid();
				post({
					id: reqId,
					from: SELF,
					to: "main",
					body: `[approval] spawn "${name}": ${params.task}`,
					kind: "request",
					approval: { type: "spawn", name, task: params.task },
					ts: now(),
				});
				const reply = await pollFor(
					() => takeReply(SELF, reqId, "main"),
					signal,
				);
				if (!reply) return text("Approval wait interrupted.");
				if (!approvalReplyAllowsSpawn(reply.body))
					return text(`Spawn denied by main: ${reply.body}`);
			}

			const childName = allocName(name);
			const id = allocateTaskId();
			registerChild(SELF, childName);
			const accepted = runAgent(
				childName,
				params.task,
				ctx,
				true,
				taskSummary(params.task),
				id,
				thinking,
			);
			if (!accepted) {
				writeBeacon(childName, { state: "error", activity: "launch rejected" });
				throw new Error(
					`Could not launch ${childName}; its active lock is already held.`,
				);
			}
			refreshView(ctx);
			const state = readJson<Beacon>(
				join(agentDir(childName), "beacon.json"),
			)?.state;
			return text(
				`${state === "queued" ? "Queued" : "Spawned"} ${childName} · ${id} (thinking ${thinking}). Call wait to yield while it works.`,
			);
		},
	});

	pi.registerTool({
		name: "message",
		label: "Message agent",
		description:
			"Send a cooperative mailbox message to another agent by name/task id or to `main`. Set wait:true to ask and block for the reply; use reply_to to answer a question.",
		promptSnippet:
			"message(to, body, reply_to?, wait?): talk to any agent or main",
		promptGuidelines: [
			"Address agents by their name (e.g. 'Alice') or 'main'. To ask a question and block for the answer, set wait:true. To answer a question you received, set reply_to to its id.",
			"Messaging an agent that has finished resumes it from its own memory with your message as a follow-up task; its completion arrives through wait as a result-file notice.",
		],
		parameters: Type.Object({
			to: Type.String({
				description: "Recipient agent name, task id, or 'main'.",
			}),
			body: Type.String({ description: "The message." }),
			reply_to: Type.Optional(
				Type.String({ description: "Id of the message you are answering." }),
			),
			wait: Type.Optional(
				Type.Boolean({ description: "Block until the recipient replies." }),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!runDir) return text("No run yet — spawn a subagent first.");
			const target =
				params.to === "main"
					? readJson<Beacon>(join(agentDir("main"), "beacon.json"))
					: resolveAgent(params.to);
			if (!target) return text(`No agent named or identified by ${params.to}.`);

			// A finished agent has no live process: resume it with this message as a follow-up.
			if (
				target.name !== "main" &&
				!isActive(target.name) &&
				target.state !== "queued" &&
				runAgent(target.name, params.body, ctx, false)
			) {
				if (activeRequest && activeRequest.from === target.name)
					activeRequest = undefined;
				refreshView(ctx);
				return text(
					`Re-addressing ${target.name} · ${target.taskId} (resuming its session). Call wait for its result.`,
				);
			}

			const id = rid();
			post({
				id,
				from: SELF,
				to: target.name,
				body: params.body,
				replyTo: params.reply_to,
				kind: params.wait ? "request" : "notice",
				ts: now(),
			});
			if (
				activeRequest &&
				(params.reply_to === activeRequest.id ||
					(activeRequest.kind !== "request" &&
						target.name === activeRequest.from))
			) {
				activeRequest = undefined;
			}
			if (!params.wait)
				return text(`Sent to ${target.name} · ${target.taskId}.`);
			const reply = await pollFor(
				() => takeReply(SELF, id, target.name),
				signal,
			);
			return text(
				reply ? `${reply.from}: ${reply.body}` : "Reply wait interrupted.",
			);
		},
	});

	pi.registerTool({
		name: "kill",
		label: "Kill subagent",
		description:
			"Force-kill a running or wedged subagent by first name or task id. Use '*' to kill all direct children and their descendants.",
		promptSnippet: "kill(name): hard-stop a wedged subagent",
		promptGuidelines: [
			"Use kill when a subagent is stuck, rate-limited in a replay loop, or cannot be stopped by a normal message.",
			"Killing marks the agent stopped, clears its pending messages to this parent, and removes it from the wait loop. It does not preserve a graceful final answer.",
		],
		parameters: Type.Object({
			name: Type.String({
				description:
					"Agent first name or task id to kill, or '*' for all direct children.",
			}),
			reason: Type.Optional(
				Type.String({ description: "Why the agent is being hard-stopped." }),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!runDir) return text("No run yet — spawn a subagent first.");
			const lines = killAgents(
				params.name,
				params.reason?.trim() || "requested by parent agent",
			);
			refreshView(ctx);
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "wait",
		label: "Wait for subagents",
		description:
			"Yield until a subagent needs you (a question or approval request) or one finishes. Returns immediately when there is no active child or pending message.",
		promptSnippet: "wait(): yield until a subagent needs you or finishes",
		promptGuidelines: [
			"After spawning one or more subagents, call `wait` to yield. It returns when a subagent messages you or when a completion result file is ready. Answer questions with `message`, kill wedged children with `kill`, then `wait` again. If `wait` reports no active subagents or pending messages, stop waiting and continue normally.",
		],
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			if (!runDir) return text("No run yet — spawn a subagent first.");
			activeRequest = undefined;
			if (!hasTeamWork(SELF)) return text(noWaitWorkMessage(SELF));

			writeBeacon(SELF, { state: "waiting", activity: "coordinating" });

			// Questions, approval requests, result-file notices, and crash notices all arrive as messages.
			// If the last child exits without posting anything, do not wait forever: return immediately.
			const event = await waitForTeamEvent(ctx, signal);

			writeBeacon(SELF, { state: "running", activity: "" });
			if (event === undefined && signal?.aborted)
				suppressNextCoordinationNudge = true;
			return text(
				event ??
					"wait cancelled; subagents are still running. Ask for status or call wait again when ready.",
			);
		},
	});

	if (!IS_CHILD) {
		pi.registerTool({
			name: "inspect_agent",
			label: "Inspect subagent",
			description:
				"Read a subagent's active session branch, including user messages, thinking, tool calls/results, provider errors, compactions, and assistant messages.",
			promptSnippet:
				"inspect_agent(agent): inspect any descendant's live or completed session",
			promptGuidelines: [
				"Use inspect_agent to diagnose a stuck or failed descendant directly instead of daisy-chaining status requests through its ancestors.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "Subagent first name or task id." }),
			}),
			executionMode: "sequential",
			async execute(_id, params) {
				if (!runDir) return text("No run yet — spawn a subagent first.");
				const target = resolveAgent(params.agent);
				if (!target || target.name === "main")
					return text(`No subagent named or identified by ${params.agent}.`);
				return text(agentTranscript(target.name));
			},
		});

		pi.registerTool({
			name: "control_agent",
			label: "Control subagent",
			description:
				"Directly steer, queue a follow-up, gracefully abort, or change the thinking level of any descendant. Thinking cannot exceed the main agent's current level.",
			promptSnippet:
				"control_agent(agent, action, message?, thinking?): directly control any descendant",
			promptGuidelines: [
				"Use control_agent steer/follow_up for direct live intervention in a descendant, including deeply nested agents; use abort before kill when the session is responsive.",
				"Use control_agent set_thinking only at a level equal to or lower than the main agent's current thinking level.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "Subagent first name or task id." }),
				action: StringEnum([
					"steer",
					"follow_up",
					"abort",
					"set_thinking",
				] as const),
				message: Type.Optional(
					Type.String({ description: "Required for steer and follow_up." }),
				),
				thinking: Type.Optional(
					StringEnum(THINKING_LEVELS, {
						description: "Required for set_thinking.",
					}),
				),
			}),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const action =
					params.action === "follow_up"
						? "followUp"
						: params.action === "set_thinking"
							? "setThinking"
							: params.action;
				const result = controlAgent(
					params.agent,
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
				`Requested child: ${approval.name}`,
				`Task: ${approval.task}`,
				"Decide deliberately; do not rubber-stamp nested delegation.",
				"Approve only if the child task is independent, scoped, non-duplicative of active work, and worth the coordination overhead. Deny if the requester should do the work directly or needs a narrower plan.",
				`Reply with message(to: "${activeRequest.from}", reply_to: "${activeRequest.id}", body: "approve") or message(..., body: "deny: <reason>"), or kill the requester if it is wedged, then call wait again.`,
				coordinationStatus(SELF),
			].join("\n");
		}
		return [
			`Subagent coordination request from ${activeRequest.from} (id ${activeRequest.id}).`,
			activeRequest.kind === "request"
				? `Use any tools needed to satisfy the request, then reply with message(to: "${activeRequest.from}", reply_to: "${activeRequest.id}", body: ...), then call wait again.`
				: `Use any tools needed to handle or repair this subagent event, then call wait again. If you need to resume the agent, message ${activeRequest.from}; if it is wedged, kill ${activeRequest.from}.`,
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
		if ((event as { toolName?: string }).toolName === "spawn")
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
		if (spawnQueuedThisTurn && toolName !== "spawn") {
			return {
				block: true,
				reason:
					"Do not combine spawn with other tools in the same turn. Let spawn return, then call wait in the next turn.",
			};
		}
		if (
			runDir &&
			hasTeamWork(SELF) &&
			!activeRequest &&
			toolName !== "spawn" &&
			toolName !== "wait" &&
			toolName !== "message" &&
			toolName !== "kill" &&
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
						`Subagent coordination paused after provider backoff: ${backoff}. Send a new message, wait, message, or kill when ready.`,
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
		const needsAttention = statusNeedsAttention(status);
		const recoveryHint = needsAttention
			? providerFailureHint(status)
			: undefined;

		if (!needsAttention && hasTeamWork(SELF)) {
			writeBeacon(SELF, { state: "running", activity: "must wait" });
			pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
			return;
		}

		const finalText = (lastAssistantText(messages) || status.errorMessage || "")
			.replace(/\s+/g, " ")
			.trim();
		if (PARENT) {
			const resultFile = writeResultFile(SELF, messages);
			post({
				id: rid(),
				from: SELF,
				to: PARENT,
				body: resultReadyMessage(
					SELF,
					resultFile,
					needsAttention ? "attention" : "done",
					status.errorMessage,
					recoveryHint,
				),
				kind: needsAttention ? "attention" : "completion",
				ts: now(),
			});
		}
		const terminalPatch: Partial<Beacon> = {
			state: needsAttention ? "stopped" : "done",
		};
		if (finalText)
			terminalPatch.lastAssistantText = finalText.slice(
				0,
				ASSISTANT_PREVIEW_MAX,
			);
		writeBeacon(SELF, terminalPatch);
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
	const workers = agents.filter((agent) => agent.name !== "main");
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
		`# ${name} · ${beacon.taskId}`,
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
					width: "96%",
					minWidth: 60,
					maxHeight: "94%",
					anchor: "top-center",
					margin: 1,
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
				`Thinking for ${action.name} (main ceiling: ${ceiling})`,
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
					? `Kill ${action.name}?`
					: `Abort ${action.name}?`,
				action.action === "kill"
					? "Hard-stop this agent and all of its descendants?"
					: "Request a graceful abort of the current agent run?",
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
			ctx.ui.notify("Usage: /subagent kill <name|task-id|*>", "error");
			return;
		}
		const lines = killAgents(target, "requested from /subagent");
		refreshView(ctx);
		ctx.ui.notify(lines.join("\n"), "warning");
		return;
	}

	const target = resolveAgent(first ?? "");
	if (!target || target.name === "main") {
		ctx.ui.notify(
			`No subagent named or identified by ${first ?? ""}.`,
			"error",
		);
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
				.filter((agent) => !TERMINAL.has(agent.state))
				.map((agent) => agent.parent)
				.filter((parent): parent is string => !!parent),
		);
		for (const agent of agents) {
			if (agent.name === "main" || TERMINAL.has(agent.state)) continue;
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
					`${agent.name} · ${agent.taskId} — no progress for ${fmtAge(now() - agent.updatedAt)}. Stop it and its descendants?`,
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
					to: "main",
					body: `${messages.join("; ")}. Inspect or resume the agent if repair is needed.`,
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
	piThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
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
				const target = args.trim() ? resolveAgent(args.trim()) : undefined;
				await runDashboard(cmdCtx, target?.name);
			},
		});
		pi.registerCommand("subagent", {
			description:
				"Open, message, or kill a subagent: /subagent <name|task-id>, /subagent <name> <message>, /subagent kill <name|task-id|*>",
			handler: async (args, cmdCtx) => inspectSubagentCommand(args, cmdCtx),
		});
		startNestedSpawnApprovalPrompts(ctx);
		startWatchdog(ctx);
		refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
		refreshTimer.unref();
		refreshView(ctx);
	});
}

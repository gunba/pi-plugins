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
  writeFileSync,
} from "node:fs";
import { spawn as spawnChild, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { providerFailureHint } from "./provider-errors.ts";
import { terminalRunCanHide } from "./run-lifecycle.ts";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

function positiveEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const BASE = process.env.PI_SUBAGENTS_DIR || join(homedir(), ".pi", "agent", "subagents");
const VIEW_KEY = "pi-subagents";
const POLL_MS = 400;
const REFRESH_MS = 1000;
const WATCHDOG_MS = 15_000;
const STALE_MS = positiveEnvInt("PI_SUBAGENTS_STALE_MS") ?? 600_000;
const ACTIVE_TOOL_STALE_MS = positiveEnvInt("PI_SUBAGENTS_ACTIVE_TOOL_STALE_MS") ?? 1_800_000;
const RUN_TTL_MS = positiveEnvInt("PI_SUBAGENTS_RUN_TTL_MS") ?? 86_400_000; // sweep runs older than 24h
const FEED_TAIL = positiveEnvInt("PI_SUBAGENTS_FEED_TAIL") ?? 8;
const FEED_MAX = positiveEnvInt("PI_SUBAGENTS_FEED_MAX") ?? 80;
const AGENT_ROWS_COLLAPSED_MAX = positiveEnvInt("PI_SUBAGENTS_AGENT_ROWS_MAX") ?? positiveEnvInt("PI_SUBAGENTS_ROWS") ?? 8;
const COORDINATION_NOTICE =
  "Subagent coordination gate: child subagents are active or child messages are unread. Do not do independent work. You may spawn additional subagents, message children, kill a wedged child, or call wait. When wait returns a child request or attention event, use tools if needed, then reply/resume with message or kill the child and call wait again. Read completion result files after wait reports no active subagents or pending messages.";

const NAMES = [
  "Alice", "Bob", "Cara", "Dan", "Eve", "Finn", "Grace", "Hugo",
  "Iris", "Jack", "Kira", "Leo", "Mia", "Noah", "Opal", "Pia",
  "Quinn", "Rosa", "Sam", "Tara", "Uma", "Vince", "Wren", "Zara",
];

const TERMINAL = new Set(["done", "error", "stopped"]);
const GLYPH: Record<string, string> = {
  spawning: "◌", running: "●", waiting: "◐",
  done: "✓", error: "✗", stopped: "■",
};
const STATE_COLOR: Record<string, ThemeColor> = {
  spawning: "dim", running: "accent", waiting: "warning",
  done: "success", error: "error", stopped: "dim",
};
const SETTINGS_FILE = process.env.PI_SUBAGENTS_SETTINGS || join(BASE, "settings.json");

type NestedSpawnApprovalMode = "agent" | "user";
type SpawnApproval = { type: "spawn"; name: string; task: string };

type Beacon = {
  name: string;
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
  lastAssistantText?: string;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 8);
const ensureDir = (p: string) => mkdirSync(p, { recursive: true });

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n = 0): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function expandPath(value: string, baseDir: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (isAbsolute(value)) return resolve(value);
  return resolve(baseDir, value);
}

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? expandPath(configured, homedir()) : join(homedir(), ".pi", "agent");
}

function parseNestedSpawnApprovalMode(value: unknown): NestedSpawnApprovalMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent") return "agent";
  if (normalized === "user" || normalized === "modal" || normalized === "human") return "user";
  return undefined;
}

function readSubagentsSettings(path: string): Record<string, unknown> {
  return asRecord(readJson<Record<string, unknown>>(path)?.subagents) ?? {};
}

function nestedSpawnApprovalMode(ctx: ExtensionContext): NestedSpawnApprovalMode {
  const envMode = parseNestedSpawnApprovalMode(process.env.PI_SUBAGENTS_NESTED_SPAWN_APPROVAL);
  if (envMode) return envMode;

  const globalSettings = readSubagentsSettings(join(piAgentDir(), "settings.json"));
  const projectSettings = ctx.isProjectTrusted()
    ? readSubagentsSettings(join(ctx.cwd, ".pi", "settings.json"))
    : {};
  const mergedSettings = { ...globalSettings, ...projectSettings };
  return parseNestedSpawnApprovalMode(mergedSettings.nestedSpawnApproval) ?? "agent";
}

// The subagent's final answer. It is never inlined into mailbox messages:
// write it to a result file so the parent chooses when to spend context on it.
function assistantTextFromMessage(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as { type?: string; text?: string }[])
      .filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
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

function finalAssistantStatus(messages: unknown[]): { stopReason?: string; errorMessage?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role === "assistant") return { stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return {};
}

function statusNeedsAttention(status: { stopReason?: string; errorMessage?: string }): boolean {
  return status.stopReason === "error" || status.stopReason === "aborted" || !!status.errorMessage;
}

function providerBackoffMessage(status: { stopReason?: string; errorMessage?: string }): string | undefined {
  const raw = `${status.stopReason ?? ""} ${status.errorMessage ?? ""}`.toLowerCase();
  if (!raw.trim()) return undefined;
  if (
    raw.includes("429")
    || raw.includes("rate_limit")
    || raw.includes("rate limit")
    || raw.includes("too many requests")
    || raw.includes("resource_exhausted")
    || raw.includes("quota")
    || raw.includes("overloaded")
  ) return status.errorMessage || status.stopReason;
  return undefined;
}

function safeFileSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "subagent";
}

function resultDir(): string {
  return join(runDir, "results");
}

function writeResultFile(name: string, messages: unknown[]): string {
  ensureDir(resultDir());
  const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(resultDir(), `${stamp}_${safeFileSegment(name)}_${rid()}.md`);
  const status = finalAssistantStatus(messages);
  const body = lastAssistantText(messages) || status.errorMessage || (statusNeedsAttention(status) ? "(needs attention)" : "(completed)");
  const header = [
    `# Subagent result: ${name}`,
    "",
    beacon?.taskName ? `Task: ${beacon.taskName}` : undefined,
    beacon?.parent ? `Parent: ${beacon.parent}` : undefined,
    status.stopReason ? `Stop reason: ${status.stopReason}` : undefined,
    status.errorMessage ? `Error: ${status.errorMessage}` : undefined,
    `Finished: ${new Date().toISOString()}`,
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
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
  const label = beacon?.taskName ? ` · ${beacon.taskName}` : "";
  const head = state === "done" ? `Completed${label}.` : `Needs attention${label}.${errorMessage ? ` ${errorMessage}` : ""}`;
  return `${head}${recoveryHint ? `\nRecovery: ${recoveryHint}` : ""}\nResult file: ${path}`;
}

// Persisted view toggle (mirrors pi-memedit's settings.json approach).
function loadPluginSettings(): Record<string, unknown> {
  return asRecord(readJson<Record<string, unknown>>(SETTINGS_FILE)) ?? {};
}
function loadView(): boolean {
  const p = loadPluginSettings();
  return typeof p.view === "boolean" ? p.view : true; // on by default
}
function saveView(view: boolean): void {
  ensureDir(BASE);
  writeFileSync(SETTINGS_FILE, `${JSON.stringify({ ...loadPluginSettings(), view }, null, 2)}\n`);
}
function padTo(s: string, w: number): string {
  const len = visibleWidth(s);
  return len >= w ? truncateToWidth(s, w) : s + " ".repeat(w - len);
}

// --------------------------------------------------------------------------
// Run + identity (module state: each pi process is one agent)
// --------------------------------------------------------------------------

const SELF = process.env.PI_SUBAGENT_NAME || "main";
const PARENT = process.env.PI_SUBAGENT_PARENT || null;
const IS_CHILD = !!process.env.PI_SUBAGENT_NAME;

let runDir = process.env.PI_SUBAGENT_RUN || "";
const kids = new Map<string, ChildProcess>();

function ensureRun(): string {
  if (!runDir) {
    runDir = join(BASE, `${new Date().toISOString().replace(/[:.]/g, "-")}_${rid()}`);
    ensureDir(runDir);
    if (!IS_CHILD) writeBeacon("main", { parent: null, state: "running", startedAt: now() });
  }
  return runDir;
}

function agentDir(name: string): string {
  return join(runDir, name);
}
function inboxDir(name: string): string {
  return join(agentDir(name), "inbox");
}
function sessionsDir(): string {
  return join(runDir, "sessions");
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
    lastAssistantText: patch.lastAssistantText ?? prev?.lastAssistantText,
  };
  writeFileSync(join(dir, "beacon.json"), JSON.stringify(beacon));
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
  return listAgents().filter((a) => a.parent === parent && !TERMINAL.has(a.state) && isActive(a.name));
}

function hasPendingFresh(name: string): boolean {
  return !!peekFresh(name);
}

function hasTeamWork(name: string): boolean {
  return hasPendingFresh(name) || activeChildren(name).length > 0;
}

function noWaitWorkMessage(name: string): string {
  const children = listAgents().filter((a) => a.parent === name);
  if (!children.length) return "No subagents to wait for — spawn a subagent first.";
  const attention = children.filter((a) => a.state === "error" || a.state === "stopped" || (!TERMINAL.has(a.state) && !isActive(a.name)));
  if (attention.length) {
    const names = attention.map((a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""} (${a.state})`).join(", ");
    return `No active subagents or pending messages for ${name}. Children needing attention: ${names}. Repair by messaging/resuming the affected agent, or continue if no repair is needed.`;
  }
  return `No active subagents or pending messages for ${name}. Continue normally; do not call wait again until you spawn or message a subagent.`;
}

function coordinationStatus(name: string): string {
  const active = activeChildren(name).map((a) => `${a.name}${a.taskName ? ` · ${a.taskName}` : ""}`);
  const pending = hasPendingFresh(name) ? "yes" : "no";
  return `active children: ${active.length ? active.join(", ") : "none"}; pending child message: ${pending}`;
}

function isCoordinating(a: Beacon): boolean {
  return a.state === "waiting" || activeChildren(a.name).length > 0;
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
  runDir = "";
}

function modelLabel(message: { provider?: string; model?: string }): string | undefined {
  if (!message.model) return undefined;
  return message.provider ? `${message.provider}/${message.model}` : message.model;
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
  if (text) patch.lastAssistantText = text;
  writeBeacon(SELF, patch);
}

function progressSummary(a: Beacon): string {
  const parts: string[] = [];
  if (a.responses) parts.push(`${a.responses}r`);
  if (a.inputTokens || a.outputTokens) parts.push(`↑${fmtTokens(a.inputTokens)} ↓${fmtTokens(a.outputTokens)}`);
  if (a.cacheReadTokens) parts.push(`R${fmtTokens(a.cacheReadTokens)}`);
  if (a.cacheWriteTokens) parts.push(`W${fmtTokens(a.cacheWriteTokens)}`);
  if (a.contextTokens) parts.push(`ctx:${fmtTokens(a.contextTokens)}`);
  if (a.cost) parts.push(`$${a.cost.toFixed(4)}`);
  return parts.join(" ");
}

// Stateless cleanup: drop run directories from past sessions. No main-side bookkeeping.
function sweepOldRuns(): void {
  if (!existsSync(BASE)) return;
  for (const e of readdirSync(BASE, { withFileTypes: true })) {
    if (e.isDirectory() && now() - statSync(join(BASE, e.name)).mtimeMs > RUN_TTL_MS) {
      rmSync(join(BASE, e.name), { recursive: true, force: true });
    }
  }
}

// --------------------------------------------------------------------------
// Mailbox
// --------------------------------------------------------------------------

function appendFeed(line: string): void {
  const feedPath = join(runDir, "feed.log");
  appendFileSync(feedPath, `${line.replace(/\s+/g, " ").slice(0, 160)}\n`);
  const feed = readFeed();
  if (feed.length > FEED_MAX) writeFileSync(feedPath, `${feed.slice(-FEED_MAX).join("\n")}\n`);
}

function post(msg: Mail): void {
  ensureDir(inboxDir(msg.to));
  writeFileSync(join(inboxDir(msg.to), `${msg.ts}-${msg.id}.json`), JSON.stringify(msg));
  appendFeed(`${msg.from}→${msg.to}: ${msg.body}`);
}

function inboxFiles(name: string): string[] {
  const dir = inboxDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
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
function takeReply(name: string, replyTo: string): Mail | undefined {
  for (const f of inboxFiles(name)) {
    const path = join(inboxDir(name), f);
    const msg = readJson<Mail>(path);
    if (msg && msg.replyTo === replyTo) {
      rmSync(path, { force: true });
      return msg;
    }
  }
  return undefined;
}

// Atomically claim a fresh message so wait() and UI approval prompts cannot
// consume the same request. The claim file is not visible to inboxFiles().
function claimFresh(name: string, predicate: (msg: Mail) => boolean = () => true): { path: string; msg: Mail } | undefined {
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

function spawnApprovalDetails(msg: { body: string; approval?: SpawnApproval }): SpawnApproval | undefined {
  if (msg.approval?.type === "spawn") return msg.approval;
  const match = msg.body.match(/^\[approval]\s+spawn\s+"([^"]+)":\s*([\s\S]*)$/i);
  return match ? { type: "spawn", name: match[1] ?? "subagent", task: match[2] ?? "" } : undefined;
}

function isNestedSpawnApproval(msg: Mail): boolean {
  return msg.kind === "request" && !!spawnApprovalDetails(msg);
}

function approvalReplyAllowsSpawn(body: string): boolean {
  return /^\s*approve(?:\s*:\s*.*)?\s*$/i.test(body);
}

function replyToNestedSpawnApproval(msg: Mail, approved: boolean, reason: string): void {
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

async function resolveNestedSpawnApprovalWithUser(ctx: ExtensionContext, msg: Mail): Promise<string> {
  const details = spawnApprovalDetails(msg);
  const label = details?.name ? ` "${details.name}"` : "";
  if (!ctx.hasUI) {
    const reason = "user approval mode is enabled, but this session has no UI to confirm nested spawns";
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
  replyToNestedSpawnApproval(msg, approved, approved ? "" : "user denied nested spawn request");
  return `${approved ? "Approved" : "Denied"} nested spawn${label} from ${msg.from}.`;
}

function isCompletionNotice(msg: Mail): boolean {
  if (msg.kind) return msg.kind === "completion";
  return msg.body.startsWith("Completed") && msg.body.includes("Result file:");
}

function activeRequestFor(msg: Mail): ActiveRequest | undefined {
  if (isCompletionNotice(msg)) return undefined;
  const kind = msg.kind === "request" || msg.kind === "attention" ? msg.kind : "notice";
  return { from: msg.from, id: msg.id, body: msg.body, kind, approval: spawnApprovalDetails(msg) };
}

async function pollFor<T>(fn: () => T | undefined, signal?: AbortSignal): Promise<T | undefined> {
  while (!signal?.aborted) {
    const v = fn();
    if (v !== undefined) return v;
    await sleep(POLL_MS);
  }
  return undefined;
}

async function waitForTeamEvent(ctx: ExtensionContext, signal?: AbortSignal): Promise<string | undefined> {
  while (!signal?.aborted) {
    const fresh = claimFresh(SELF);
    if (fresh) {
      try {
        if (isNestedSpawnApproval(fresh.msg) && nestedSpawnApprovalMode(ctx) === "user") {
          const summary = await resolveNestedSpawnApprovalWithUser(ctx, fresh.msg);
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
    await sleep(POLL_MS);
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Name allocation (mkdir is the atomic lock)
// --------------------------------------------------------------------------

function allocName(): string {
  ensureRun();
  for (let suffix = 0; suffix < 100; suffix++) {
    for (const base of NAMES) {
      const name = suffix === 0 ? base : `${base}${suffix + 1}`;
      try {
        mkdirSync(agentDir(name));
        return name;
      } catch {
        // taken — keep looking
      }
    }
  }
  throw new Error("subagent name pool exhausted");
}

// --------------------------------------------------------------------------
// Spawn a child pi process
// --------------------------------------------------------------------------

// Launch (fresh) or resume (existing session) a subagent process. The `.active`
// lock dir is the atomic liveness signal: it stops two callers resuming the same
// agent at once and tells everyone whether an agent is live or suspended.
function runAgent(name: string, prompt: string, ctx: ExtensionContext, fresh: boolean, taskName = ""): boolean {
  try {
    mkdirSync(activeLock(name)); // claims the agent; throws if already active
  } catch {
    return false;
  }
  ensureDir(inboxDir(name));
  ensureDir(sessionsDir());
  writeBeacon(name, fresh ? { parent: SELF, taskName, state: "spawning", startedAt: now() } : { state: "running" });

  // Persistent session in an isolated store: resumable, but `/resume` never scans it.
  const args = [process.argv[1], "--print", prompt, "--session-id", name, "--session-dir", sessionsDir(), "--exclude-tools", "ask_user"];
  if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);

  const child = spawnChild(process.execPath, args, {
    cwd: ctx.cwd,
    env: { ...process.env, PI_SUBAGENT_RUN: runDir, PI_SUBAGENT_NAME: name, PI_SUBAGENT_PARENT: SELF },
    stdio: "ignore",
    windowsHide: true,
  });
  if (typeof child.pid === "number") writeFileSync(activePidFile(name), `${child.pid}\n`);
  kids.set(name, child);
  const finishUnexpected = (state: "error" | "stopped", body: string) => {
    rmSync(activeLock(name), { recursive: true, force: true });
    const b = readJson<Beacon>(join(agentDir(name), "beacon.json"));
    if (!b || !TERMINAL.has(b.state)) {
      writeBeacon(name, { state });
      post({ id: rid(), from: name, to: SELF, body, kind: "attention", ts: now() });
    }
    kids.delete(name);
  };
  child.on("error", (error) => finishUnexpected("error", `failed to start: ${(error as Error).message}`));
  // Safety net: if the process dies without a clean agent_end, surface it to the launcher.
  child.on("exit", (code) => finishUnexpected("stopped", code === 0 ? "exited before posting a result" : `exited unexpectedly (code ${code})`));
  child.on("exit", () => refreshView(ctx));
  return true;
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
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return result.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function descendantsIncluding(name: string): Beacon[] {
  const agents = listAgents();
  const out: Beacon[] = [];
  const walk = (parent: string) => {
    for (const child of agents.filter((a) => a.parent === parent)) {
      out.push(child);
      walk(child.name);
    }
  };
  const root = agents.find((a) => a.name === name);
  if (root) out.push(root);
  walk(name);
  return out;
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
  rmSync(activeLock(name), { recursive: true, force: true });
  kids.delete(name);
  const removed = removePendingFrom(name);
  if (activeRequest?.from === name) activeRequest = undefined;

  let killed = false;
  if (pid && processAlive(pid)) killed = killPidTree(pid);
  appendFeed(`${SELF}→${name}: killed (${reason})`);
  return `${name}: ${pid ? (killed ? `killed pid ${pid}` : `marked stopped; pid ${pid} did not terminate cleanly`) : "marked stopped; no live pid"}${removed ? `; cleared ${removed} pending message${removed === 1 ? "" : "s"}` : ""}`;
}

function killAgents(selector: string, reason: string): string[] {
  const names = selector.trim() === "*"
    ? listAgents().filter((a) => a.parent === SELF && a.state !== "done").flatMap((a) => descendantsIncluding(a.name).map((b) => b.name))
    : descendantsIncluding(selector.trim()).map((a) => a.name);
  const unique = [...new Set(names)].filter((name) => name !== SELF);
  if (!unique.length) return [`No agent matched ${selector}.`];
  return unique.reverse().map((name) => killOneAgent(name, reason));
}

function sendAgentNotice(to: string, body: string, ctx: ExtensionContext): string {
  if (!runDir) return "No run yet — spawn a subagent first.";
  const known = to === "main" || existsSync(join(agentDir(to), "beacon.json"));
  if (!known) return `No agent named ${to}.`;
  if (to !== "main" && !isActive(to) && runAgent(to, body, ctx, false)) {
    if (activeRequest && activeRequest.from === to) activeRequest = undefined;
    refreshView(ctx);
    return `Re-addressing ${to} (resuming its session). Call wait for its result.`;
  }
  post({ id: rid(), from: SELF, to, body, kind: "notice", ts: now() });
  return `Sent to ${to}.`;
}

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn",
    label: "Spawn subagent",
    description:
      "Start a background subagent — a fresh pi with your tools and a clean context — for one delegated task.",
    promptSnippet: "spawn(task, name): delegate one suitable subtask to a background subagent",
    promptGuidelines: [
      "Use spawn only when delegation fits: independent parallel work, competing hypotheses, or context-heavy investigation whose details need not stay in your context.",
      "Outline the task for the subagent and be clear about the result you want, e.g. findings, an implementation, changed files, open questions, exact paths/ranges, and how to handle blockers or uncertainty.",
      "After spawning one or more subagents, use `wait`, `message`, and `kill` to coordinate. While child subagents are active or messages are unread, pi-subagents only permits coordination: `spawn`, `wait`, `message`, or `kill`.",
      "Nested subagent spawn requests need deliberate approval. Approve only when the requested child is independent, scoped, non-duplicative, and worth the coordination overhead; otherwise deny or ask the requester to narrow its plan.",
      "Reply to nested spawn approval requests with exactly `approve` or `deny: <reason>` unless `subagents.nestedSpawnApproval` is `user`, in which case pi-subagents asks the user in a modal and replies for you. A stuck subagent never lets `wait` run with no live work — `wait` is interruptible and `/subagents` shows the subagent tree.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "One delegated objective. Include constraints, done criteria, and the result you want." }),
      name: Type.String({ description: "A short task name you choose for this subagent (e.g. 'auth-race repro'), shown in the team view." }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      ensureRun();

      if (IS_CHILD) {
        const reqId = rid();
        post({
          id: reqId,
          from: SELF,
          to: "main",
          body: `[approval] spawn "${params.name}": ${params.task}`,
          kind: "request",
          approval: { type: "spawn", name: params.name, task: params.task },
          ts: now(),
        });
        const reply = await pollFor(() => takeReply(SELF, reqId), signal);
        if (!reply) return text("Approval wait interrupted.");
        if (!approvalReplyAllowsSpawn(reply.body)) return text(`Spawn denied by main: ${reply.body}`);
      }

      const childName = allocName();
      runAgent(childName, params.task, ctx, true, params.name);
      refreshView(ctx);
      return text(`Spawned ${childName} · ${params.name}. Call wait to yield while it works.`);
    },
  });

  pi.registerTool({
    name: "message",
    label: "Message agent",
    description: "Send a message to another agent by name or to `main`. Set wait:true to ask and block for the reply; use reply_to to answer a question.",
    promptSnippet: "message(to, body, reply_to?, wait?): talk to any agent or main",
    promptGuidelines: [
      "Address agents by their name (e.g. 'Alice') or 'main'. To ask a question and block for the answer, set wait:true. To answer a question you received, set reply_to to its id.",
      "Messaging an agent that has finished resumes it from its own memory with your message as a follow-up task; its completion arrives through wait as a result-file notice.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name, or 'main'." }),
      body: Type.String({ description: "The message." }),
      reply_to: Type.Optional(Type.String({ description: "Id of the message you are answering." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until the recipient replies." })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!runDir) return text("No run yet — spawn a subagent first.");
      const known = params.to === "main" || existsSync(join(agentDir(params.to), "beacon.json"));
      if (!known) return text(`No agent named ${params.to}.`);

      // A finished agent has no live process: resume it with this message as a follow-up.
      if (params.to !== "main" && !isActive(params.to) && runAgent(params.to, params.body, ctx, false)) {
        if (activeRequest && activeRequest.from === params.to) activeRequest = undefined;
        refreshView(ctx);
        return text(`Re-addressing ${params.to} (resuming its session). Call wait for its result.`);
      }

      const id = rid();
      post({ id, from: SELF, to: params.to, body: params.body, replyTo: params.reply_to, kind: params.wait ? "request" : "notice", ts: now() });
      if (activeRequest && (params.reply_to === activeRequest.id || (activeRequest.kind !== "request" && params.to === activeRequest.from))) {
        activeRequest = undefined;
      }
      if (!params.wait) return text(`Sent to ${params.to}.`);
      const reply = await pollFor(() => takeReply(SELF, id), signal);
      return text(reply ? `${reply.from}: ${reply.body}` : "Reply wait interrupted.");
    },
  });

  pi.registerTool({
    name: "kill",
    label: "Kill subagent",
    description: "Force-kill a running or wedged subagent by name. Use '*' to kill all direct children and their descendants.",
    promptSnippet: "kill(name): hard-stop a wedged subagent",
    promptGuidelines: [
      "Use kill when a subagent is stuck, rate-limited in a replay loop, or cannot be stopped by a normal message.",
      "Killing marks the agent stopped, clears its pending messages to this parent, and removes it from the wait loop. It does not preserve a graceful final answer.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Agent name to kill (e.g. 'Bob'), or '*' for all direct children." }),
      reason: Type.Optional(Type.String({ description: "Why the agent is being hard-stopped." })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!runDir) return text("No run yet — spawn a subagent first.");
      const lines = killAgents(params.name, params.reason?.trim() || "requested by parent agent");
      refreshView(ctx);
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "wait",
    label: "Wait for subagents",
    description: "Yield until a subagent needs you (a question or approval request) or one finishes. Returns immediately when there is no active child or pending message.",
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
      if (event === undefined && signal?.aborted) suppressNextCoordinationNudge = true;
      return text(event ?? "wait cancelled; subagents are still running. Ask for status or call wait again when ready.");
    },
  });
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
  pi.on("input", (event, ctx) => {
    if ((event as { source?: string }).source !== "extension") hideCompletedRun(ctx);
  });

  pi.on("turn_start", () => {
    spawnQueuedThisTurn = false;
  });

  pi.on("tool_execution_start", (event) => {
    if ((event as { toolName?: string }).toolName === "spawn") spawnQueuedThisTurn = true;
  });

  pi.on("context", (event) => {
    if (!runDir || (!activeRequest && !hasTeamWork(SELF))) return;
    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: coordinationPrompt() }], timestamp: now() } as any,
      ],
    };
  });

  pi.on("tool_call", (event) => {
    const toolName = (event as { toolName?: string }).toolName ?? "";
    if (spawnQueuedThisTurn && toolName !== "spawn") {
      return {
        block: true,
        reason: "Do not combine spawn with other tools in the same turn. Let spawn return, then call wait in the next turn.",
      };
    }
    if (runDir && hasTeamWork(SELF) && !activeRequest && toolName !== "spawn" && toolName !== "wait" && toolName !== "message" && toolName !== "kill") {
      return { block: true, reason: coordinationPrompt() };
    }
  });

  // If the agent stops without waiting while children are still live (or child
  // messages are unread), immediately continue with an explicit wait-only nudge.
  if (!IS_CHILD) {
    pi.on("agent_end", (event, ctx) => {
      const messages = (event as { messages?: unknown[] }).messages ?? [];
      const status = finalAssistantStatus(messages);
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
      if (runDir && (activeRequest || hasTeamWork(SELF))) pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
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
  // On completion the subagent pushes only a result-file notice to its parent.
  // If it still has live children or unread child messages, it is not allowed to
  // finish; continue the agent loop with an explicit wait-only nudge instead.
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const status = finalAssistantStatus(messages);
    const needsAttention = statusNeedsAttention(status);
    const recoveryHint = needsAttention ? providerFailureHint(status) : undefined;

    if (!needsAttention && hasTeamWork(SELF)) {
      writeBeacon(SELF, { state: "running", activity: "must wait" });
      pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
      return;
    }

    const finalText = (lastAssistantText(messages) || status.errorMessage || "").replace(/\s+/g, " ").trim();
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
    const terminalPatch: Partial<Beacon> = { state: needsAttention ? "stopped" : "done" };
    if (finalText) terminalPatch.lastAssistantText = finalText;
    writeBeacon(SELF, terminalPatch);
  });
}

// --------------------------------------------------------------------------
// Team view — a styled, live panel above the editor (root + UI; on by default)
// --------------------------------------------------------------------------

let uiReady = false;
let viewEnabled = true;
let agentRowsExpanded = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let approvalTimer: ReturnType<typeof setInterval> | undefined;
let expandShortcutUnsubscribe: (() => void) | undefined;
let lastSig: string | undefined;
let suppressNextCoordinationNudge = false;
let lastProviderBackoffNoticeAt = 0;

// Active agents show a live timer; finished agents freeze at their duration.
function elapsed(b: Beacon): string {
  return fmtAge((b.finishedAt ?? now()) - b.startedAt);
}

function readFeed(): string[] {
  try {
    return readFileSync(join(runDir, "feed.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

type AgentTreeRow = {
  agent: Beacon;
  depth: number;
  order: number;
};

type CollapsedAgentRows = {
  visible: AgentTreeRow[];
  hiddenCount: number;
  hiddenDoneCount: number;
};

function flattenAgentRows(agents = listAgents()): AgentTreeRow[] {
  // main owns the panel (the title); its children/grandchildren form the tree.
  const byParent = new Map<string | null, Beacon[]>();
  for (const agent of agents) {
    if (agent.name === "main") continue;
    if (!byParent.has(agent.parent)) byParent.set(agent.parent, []);
    byParent.get(agent.parent)!.push(agent);
  }

  const rows: AgentTreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const agent of (byParent.get(parent) ?? []).sort((x, y) => x.startedAt - y.startedAt)) {
      rows.push({ agent, depth, order: rows.length });
      walk(agent.name, depth + 1);
    }
  };
  walk("main", 0);
  return rows;
}

function agentRowsOverflow(agents = listAgents()): boolean {
  return flattenAgentRows(agents).length > AGENT_ROWS_COLLAPSED_MAX;
}

// A plain change-detector so we only repaint when something actually moved.
function viewSignature(agents: Beacon[]): string {
  const rows = agents.map((a) => `${a.name}:${a.state}:${a.activity ?? ""}:${elapsed(a)}:${progressSummary(a)}:${a.lastAssistantText ?? ""}`).join("|");
  return `${agentRowsExpanded ? "expanded" : "collapsed"}#${rows}#${readFeed().slice(-FEED_TAIL).join("|")}`;
}

function boxLines(theme: Theme, width: number, label: string, rows: string[], minRows = rows.length): string[] {
  const W = Math.max(24, width);
  const inner = W - 4;
  const B = (s: string) => theme.fg("borderAccent", s);
  const titledBar = (open: string, close: string) => {
    const lead = `${open}─ `;
    const dashes = Math.max(0, W - 1 - visibleWidth(lead) - visibleWidth(label) - 1);
    return B(lead) + theme.bold(theme.fg("accent", label)) + " " + B("─".repeat(dashes) + close);
  };
  const frame = (content: string) => `${B("│")} ${padTo(content, inner)} ${B("│")}`;
  const out = [titledBar("╭", "╮")];
  for (let i = 0; i < Math.max(minRows, rows.length); i++) out.push(frame(rows[i] ?? ""));
  out.push(B(`╰${"─".repeat(W - 2)}╯`));
  return out;
}

function rowHidePriority(row: AgentTreeRow): number {
  if (row.agent.state === "done") return 0;
  if (row.agent.state === "error" || row.agent.state === "stopped") return 2;
  return 1;
}

function hasVisibleDescendant(rows: AgentTreeRow[], index: number, hidden: Set<number>): boolean {
  const depth = rows[index]!.depth;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.depth <= depth) return false;
    if (!hidden.has(row.order)) return true;
  }
  return false;
}

function nextRowToHide(rows: AgentTreeRow[], hidden: Set<number>): number | undefined {
  let best: number | undefined;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (hidden.has(row.order) || hasVisibleDescendant(rows, i, hidden)) continue;
    const priority = rowHidePriority(row);
    if (best === undefined || priority < bestPriority || (priority === bestPriority && row.order < rows[best]!.order)) {
      best = i;
      bestPriority = priority;
    }
  }
  return best;
}

function collapseAgentRows(rows: AgentTreeRow[]): CollapsedAgentRows {
  if (rows.length <= AGENT_ROWS_COLLAPSED_MAX) return { visible: rows, hiddenCount: 0, hiddenDoneCount: 0 };
  if (AGENT_ROWS_COLLAPSED_MAX <= 1) {
    return { visible: [], hiddenCount: rows.length, hiddenDoneCount: rows.filter((row) => row.agent.state === "done").length };
  }

  const targetVisible = AGENT_ROWS_COLLAPSED_MAX - 1; // keep one line for the expansion hint.
  const hidden = new Set<number>();
  while (rows.length - hidden.size > targetVisible) {
    const index = nextRowToHide(rows, hidden);
    if (index === undefined) break;
    hidden.add(rows[index]!.order);
  }

  const visible = rows.filter((row) => !hidden.has(row.order));
  const hiddenDoneCount = rows.filter((row) => hidden.has(row.order) && row.agent.state === "done").length;
  return { visible, hiddenCount: hidden.size, hiddenDoneCount };
}

function hiddenRowsSummary(collapsed: CollapsedAgentRows): string {
  const rowWord = collapsed.hiddenCount === 1 ? "row" : "rows";
  if (collapsed.hiddenDoneCount === collapsed.hiddenCount && collapsed.hiddenCount > 0) {
    return `… ${collapsed.hiddenCount} completed ${rowWord} hidden (ctrl+o expands)`;
  }
  if (collapsed.hiddenDoneCount > 0) {
    const doneWord = collapsed.hiddenDoneCount === 1 ? "row" : "rows";
    return `… ${collapsed.hiddenCount} ${rowWord} hidden, ${collapsed.hiddenDoneCount} completed ${doneWord} first (ctrl+o expands)`;
  }
  return `… ${collapsed.hiddenCount} ${rowWord} hidden (ctrl+o expands)`;
}

function renderAgentRow(theme: Theme, inner: number, row: AgentTreeRow): string {
  const a = row.agent;
  const color = STATE_COLOR[a.state] ?? "muted";
  const head = `${"  ".repeat(row.depth)}${theme.fg(color, GLYPH[a.state] ?? "•")} ${theme.bold(theme.fg("text", a.name))}`
    + (a.taskName ? theme.fg("muted", ` · ${a.taskName}`) : "")
    + `  ${theme.fg(color, a.state)}`
    + (a.activity ? theme.fg("dim", `  ${a.activity}`) : "");
  const progress = progressSummary(a);
  const right = theme.fg("dim", progress ? `${progress}  ${elapsed(a)}` : elapsed(a));
  const snippet = (a.lastAssistantText ?? "").replace(/\s+/g, " ").trim();
  const available = inner - visibleWidth(head) - visibleWidth(right) - 3;
  const middle = snippet && available >= 14 ? theme.fg("dim", ` — ${truncateToWidth(snippet, available)}`) : "";
  const left = `${head}${middle}`;
  const gap = inner - visibleWidth(left) - visibleWidth(right);
  return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : padTo(left, inner);
}

function agentRows(theme: Theme, inner: number): string[] {
  const rows = flattenAgentRows();
  if (!rows.length) return [theme.fg("dim", "no subagents yet")];
  if (agentRowsExpanded || rows.length <= AGENT_ROWS_COLLAPSED_MAX) return rows.map((row) => renderAgentRow(theme, inner, row));

  const collapsed = collapseAgentRows(rows);
  return [theme.fg("dim", hiddenRowsSummary(collapsed)), ...collapsed.visible.map((row) => renderAgentRow(theme, inner, row))];
}

function feedRows(theme: Theme): string[] {
  const feed = readFeed().slice(-FEED_TAIL);
  if (!feed.length) return [theme.fg("dim", "no feed yet")];
  return feed.map((line) => {
    const i = line.indexOf(": ");
    const route = i < 0 ? line : line.slice(0, i);
    const body = i < 0 ? "" : line.slice(i + 2);
    return `${theme.fg("accent", route)}  ${theme.fg("dim", body)}`;
  });
}

function subagentsLabel(): string {
  if (!agentRowsOverflow()) return "Subagents";
  return agentRowsExpanded ? "Subagents all (ctrl+o)" : "Subagents (ctrl+o)";
}

function teamLines(theme: Theme, width: number): string[] {
  const W = Math.max(38, Math.min(width, 180));
  if (W >= 92) {
    const feedW = Math.max(34, Math.min(58, Math.floor(W * 0.34)));
    const agentsW = W - feedW - 1;
    const agents = agentRows(theme, agentsW - 4);
    const height = Math.max(1, agents.length);
    const feed = feedRows(theme).slice(-height);
    const left = boxLines(theme, agentsW, subagentsLabel(), agents, height);
    const right = boxLines(theme, feedW, "feed", feed, height);
    return left.map((line, i) => `${line} ${right[i]}`);
  }

  const agentsW = Math.min(W, 78);
  const agents = boxLines(theme, agentsW, subagentsLabel(), agentRows(theme, agentsW - 4));
  const feed = boxLines(theme, agentsW, "feed", feedRows(theme));
  return [...agents, ...feed];
}

function installExpandShortcut(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  expandShortcutUnsubscribe?.();
  expandShortcutUnsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, "ctrl+o")) return undefined;
    if (!agentRowsOverflow()) {
      agentRowsExpanded = false;
      return undefined;
    }

    agentRowsExpanded = !agentRowsExpanded;
    lastSig = undefined;
    refreshView(ctx);
    return undefined;
  });
}

function refreshView(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const agents = runDir ? listAgents() : [];
  if (agentRowsExpanded && !agentRowsOverflow(agents)) agentRowsExpanded = false;
  if (!viewEnabled || agents.length === 0) {
    if (lastSig !== undefined) {
      ctx.ui.setWidget(VIEW_KEY, undefined);
      lastSig = undefined;
    }
    return;
  }
  const sig = viewSignature(agents);
  if (sig === lastSig) return;
  lastSig = sig;
  ctx.ui.setWidget(VIEW_KEY, (_tui, theme): Component => ({ render: (w: number) => teamLines(theme, w), invalidate() {} }), {
    placement: "aboveEditor",
  });
}

function toggleView(ctx: ExtensionContext): void {
  viewEnabled = !viewEnabled;
  saveView(viewEnabled);
  lastSig = undefined;
  refreshView(ctx);
  if (ctx.hasUI) ctx.ui.notify(`Subagent team view ${viewEnabled ? "on" : "off"} (persisted)`, "info");
}

function latestSessionFile(name: string): string | undefined {
  const dir = sessionsDir();
  if (!existsSync(dir)) return undefined;
  const suffix = `_${name}.jsonl`;
  return readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .map((file) => join(dir, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function messageTextForTranscript(message: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }): string {
  if (message.role === "assistant") {
    const text = assistantTextFromMessage(message).trim();
    if (text) return text;
    if (message.errorMessage) return `[${message.stopReason ?? "error"}] ${message.errorMessage}`;
    return message.stopReason ? `[${message.stopReason}]` : "";
  }
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as { type?: string; text?: string; name?: string }[])
      .map((block) => block.text ?? block.name ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function agentTranscript(name: string, maxChars = 24_000): string {
  const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
  if (!beacon) return `No agent named ${name}.`;
  const lines = [
    `# ${name}${beacon.taskName ? ` · ${beacon.taskName}` : ""}`,
    `State: ${beacon.state}${beacon.activity ? ` (${beacon.activity})` : ""}`,
    `Started: ${new Date(beacon.startedAt).toLocaleString()}`,
    beacon.model ? `Model: ${beacon.model}` : undefined,
    "",
  ].filter((line): line is string => line !== undefined);

  const file = latestSessionFile(name);
  if (!file) {
    lines.push(beacon.lastAssistantText ? `## Last assistant message\n\n${beacon.lastAssistantText}` : "No session transcript found for this agent.");
    return lines.join("\n");
  }

  lines.push(`Transcript: ${file}`, "");
  let chars = lines.join("\n").length;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const event = (() => {
      try { return JSON.parse(raw) as { message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } }; }
      catch { return undefined; }
    })();
    const message = event?.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = messageTextForTranscript(message).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    const entry = [`## ${message.role}`, "", text, ""];
    lines.push(...entry);
    chars += entry.join("\n").length + 1;
    if (chars > maxChars) {
      lines.push("… transcript truncated …");
      break;
    }
  }
  return lines.join("\n");
}

async function inspectSubagentCommand(args: string, ctx: ExtensionContext): Promise<void> {
  if (!runDir) {
    ctx.ui.notify("No subagent run is active.", "info");
    return;
  }
  const trimmed = args.trim();
  if (!trimmed || /^list$/i.test(trimmed)) {
    const rows = listAgents().filter((a) => a.name !== "main").map((a) => `${a.name} · ${a.taskName || "(untitled)"} — ${a.state}`);
    ctx.ui.notify(rows.length ? rows.join("\n") : "No subagents yet.", "info");
    return;
  }
  const [first, ...rest] = trimmed.split(/\s+/);
  if (/^kill$/i.test(first ?? "")) {
    const target = rest[0];
    if (!target) {
      ctx.ui.notify("Usage: /subagent kill <name|*>", "error");
      return;
    }
    const lines = killAgents(target, "requested from /subagent");
    refreshView(ctx);
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }

  const name = first ?? "";
  const inlineMessage = rest.join(" ").trim();
  if (inlineMessage) {
    ctx.ui.notify(sendAgentNotice(name, inlineMessage, ctx), "info");
    return;
  }

  await ctx.ui.editor(`Subagent ${name}`, agentTranscript(name));
  const followUp = await ctx.ui.input(`Message ${name}?`, "leave blank to close");
  if (followUp?.trim()) ctx.ui.notify(sendAgentNotice(name, followUp.trim(), ctx), "info");
}

// --------------------------------------------------------------------------
// Human prompts (root + UI only): approvals and stuck agents are user decisions
// --------------------------------------------------------------------------

const flagged = new Set<string>();
let uiPrompting = false;

function startNestedSpawnApprovalPrompts(ctx: ExtensionContext): void {
  approvalTimer = setInterval(async () => {
    if (!runDir || uiPrompting || nestedSpawnApprovalMode(ctx) !== "user") return;
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
}

function startWatchdog(ctx: ExtensionContext): void {
  setInterval(async () => {
    if (!runDir || uiPrompting) return;
    // Only direct children: those this session can actually stop.
    for (const a of listAgents()) {
      if (a.parent !== SELF || TERMINAL.has(a.state) || flagged.has(a.name)) continue;
      if (isCoordinating(a)) continue;
      const staleMs = a.activity ? ACTIVE_TOOL_STALE_MS : STALE_MS;
      if (now() - a.updatedAt < staleMs) continue;
      flagged.add(a.name);
      uiPrompting = true;
      let stop = false;
      try {
        stop = await ctx.ui.confirm(
          "Subagent stuck?",
          `${a.name} · ${a.taskName} — no progress for ${fmtAge(now() - a.updatedAt)}. Stop it?`,
        );
      } finally {
        uiPrompting = false;
      }
      if (stop) {
        const message = killOneAgent(a.name, `watchdog after ${fmtAge(now() - a.updatedAt)} without progress`);
        post({ id: rid(), from: a.name, to: SELF, body: `${message}. You may repair it by messaging/resuming the agent if needed.`, kind: "attention", ts: now() });
        refreshView(ctx);
      }
    }
  }, WATCHDOG_MS);
}

// --------------------------------------------------------------------------
// Entry
// --------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
  registerCoordinationHooks(pi);

  if (IS_CHILD) {
    ensureDir(inboxDir(SELF));
    registerChildHooks(pi);
  }

  pi.on("session_shutdown", () => {
    for (const child of kids.values()) child.kill();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (approvalTimer) clearInterval(approvalTimer);
    approvalTimer = undefined;
    expandShortcutUnsubscribe?.();
    expandShortcutUnsubscribe = undefined;
    uiReady = false;
    lastSig = undefined;
  });

  // Root + interactive only: the team view and its watchdog (registered once).
  pi.on("session_start", (_event, ctx) => {
    if (IS_CHILD || ctx.mode !== "tui" || uiReady) return;
    uiReady = true;
    viewEnabled = loadView();
    installExpandShortcut(ctx);
    sweepOldRuns();
    pi.registerCommand("subagents", {
      description: "Toggle the live subagent team view (persisted, on by default).",
      handler: async (_args, cmdCtx) => toggleView(cmdCtx),
    });
    pi.registerCommand("subagent", {
      description: "Inspect, message, or kill a subagent: /subagent <name>, /subagent <name> <message>, /subagent kill <name|*>",
      handler: async (args, cmdCtx) => inspectSubagentCommand(args, cmdCtx),
    });
    startNestedSpawnApprovalPrompts(ctx);
    startWatchdog(ctx);
    refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
  });
}

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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const BASE = process.env.PI_SUBAGENTS_DIR || join(homedir(), ".pi", "agent", "subagents");
const VIEW_KEY = "pi-subagents";
const POLL_MS = 400;
const REFRESH_MS = 1000;
const WATCHDOG_MS = 15_000;
const STALE_MS = Number(process.env.PI_SUBAGENTS_STALE_MS) || 120_000;
const RUN_TTL_MS = Number(process.env.PI_SUBAGENTS_RUN_TTL_MS) || 86_400_000; // sweep runs older than 24h
const FEED_TAIL = 8;
const COORDINATION_NOTICE =
  "Subagent coordination gate: child subagents are active or child messages are unread. Do not do independent work. Call wait. When wait returns a child request or error, handle that event with normal tools if needed, then reply/resume with message and call wait again. Do not read completion result files until wait reports that no active subagents or pending messages remain.";

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

type Beacon = {
  name: string;
  parent: string | null;
  taskName: string;
  state: string;
  activity?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
};

type Mail = {
  id: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  kind?: "request" | "completion" | "attention" | "notice";
  ts: number;
};

type ActiveRequest = {
  from: string;
  id: string;
  body: string;
  kind: "request" | "attention" | "notice";
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

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// The subagent's final answer. It is never inlined into mailbox messages:
// write it to a result file so the parent chooses when to spend context on it.
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as { type?: string; text?: string }[])
        .filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
    }
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

function resultReadyMessage(name: string, path: string, state: "done" | "attention", errorMessage?: string): string {
  const beacon = readJson<Beacon>(join(agentDir(name), "beacon.json"));
  const label = beacon?.taskName ? ` · ${beacon.taskName}` : "";
  const head = state === "done" ? `Completed${label}.` : `Needs attention${label}.${errorMessage ? ` ${errorMessage}` : ""}`;
  return `${head}\nResult file: ${path}`;
}

// Persisted view toggle (mirrors pi-memedit's settings.json approach).
function loadView(): boolean {
  try {
    const p = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { view?: unknown };
    return typeof p.view === "boolean" ? p.view : true;
  } catch {
    return true; // on by default
  }
}
function saveView(view: boolean): void {
  ensureDir(BASE);
  writeFileSync(SETTINGS_FILE, `${JSON.stringify({ view }, null, 2)}\n`);
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

function post(msg: Mail): void {
  ensureDir(inboxDir(msg.to));
  writeFileSync(join(inboxDir(msg.to), `${msg.ts}-${msg.id}.json`), JSON.stringify(msg));
  appendFileSync(join(runDir, "feed.log"), `${msg.from}→${msg.to}: ${msg.body.replace(/\s+/g, " ").slice(0, 160)}\n`);
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

function isCompletionNotice(msg: Mail): boolean {
  if (msg.kind) return msg.kind === "completion";
  return msg.body.startsWith("Completed") && msg.body.includes("Result file:");
}

function activeRequestFor(msg: Mail): ActiveRequest | undefined {
  if (isCompletionNotice(msg)) return undefined;
  const kind = msg.kind === "request" || msg.kind === "attention" ? msg.kind : "notice";
  return { from: msg.from, id: msg.id, body: msg.body, kind };
}

async function pollFor<T>(fn: () => T | undefined, signal?: AbortSignal): Promise<T | undefined> {
  while (!signal?.aborted) {
    const v = fn();
    if (v !== undefined) return v;
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

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn",
    label: "Spawn subagent",
    description:
      "Start a background subagent — a fresh pi with your tools and a clean context — to do one task in parallel.",
    promptSnippet: "spawn(task, name): start a background subagent for independent parallel work",
    promptGuidelines: [
      "Subagents are background pi processes with your tools and no shared memory — give each one objective and its done criteria. Use them for independent parallel work (competing hypotheses, wide searches, parallel builds).",
      "After spawning your team, call `wait` and let them run rather than duplicating their work. While child subagents are active or messages are unread, pi-subagents only permits coordination: `wait` or `message`.",
      "Nested subagents need your approval: reply 'approve' or 'deny' when a subagent asks to spawn one. A stuck subagent never lets `wait` run with no live work — `wait` is interruptible and `/subagents` shows the whole team.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "One objective and its done criteria. The subagent starts cold — say everything it needs." }),
      name: Type.String({ description: "A short task name you choose for this subagent (e.g. 'auth-race repro'), shown in the team view." }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      ensureRun();

      if (IS_CHILD) {
        const reqId = rid();
        post({ id: reqId, from: SELF, to: "main", body: `[approval] spawn "${params.name}": ${params.task}`, kind: "request", ts: now() });
        const reply = await pollFor(() => takeReply(SELF, reqId), signal);
        if (!reply) return text("Approval wait interrupted.");
        if (!/approve/i.test(reply.body)) return text(`Spawn denied by main: ${reply.body}`);
      }

      const childName = allocName();
      runAgent(childName, params.task, ctx, true, params.name);
      refreshView(ctx);
      return text(`Spawned ${childName} · ${params.name}. Call wait to yield while the team works.`);
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
    name: "wait",
    label: "Wait for team",
    description: "Yield until a subagent needs you (a question or approval request) or one finishes. Returns immediately when there is no active child or pending message.",
    promptSnippet: "wait(): yield until a subagent needs you or finishes",
    promptGuidelines: [
      "After spawning your team, call `wait` to yield. It returns when a subagent messages you or when a completion result file is ready. Answer questions with `message`, then `wait` again. If `wait` reports no active subagents or pending messages, stop waiting and continue normally.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _params, signal, _onUpdate) {
      if (!runDir) return text("No run yet — spawn a subagent first.");
      activeRequest = undefined;
      if (!hasTeamWork(SELF)) return text(noWaitWorkMessage(SELF));

      writeBeacon(SELF, { state: "waiting", activity: "coordinating" });

      // Questions, approval requests, result-file notices, and crash notices all arrive as messages.
      // If the last child exits without posting anything, do not wait forever: return immediately.
      const event = await pollFor(() => {
        const fresh = peekFresh(SELF);
        if (fresh) {
          rmSync(fresh.path, { force: true });
          activeRequest = activeRequestFor(fresh.msg);
          return `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`;
        }
        if (activeChildren(SELF).length === 0) return noWaitWorkMessage(SELF);
        return undefined;
      }, signal);

      writeBeacon(SELF, { state: "running", activity: "" });
      return text(event ?? "wait interrupted.");
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
    return [
      `Subagent coordination request from ${activeRequest.from} (id ${activeRequest.id}).`,
      activeRequest.kind === "request"
        ? `Use any tools needed to satisfy the request, then reply with message(to: "${activeRequest.from}", reply_to: "${activeRequest.id}", body: ...), then call wait again.`
        : `Use any tools needed to handle or repair this subagent event, then call wait again. If you need to resume the agent, message ${activeRequest.from}.`,
      `Request: ${activeRequest.body}`,
      coordinationStatus(SELF),
    ].join("\n");
  }
  return `${COORDINATION_NOTICE}\n${coordinationStatus(SELF)}`;
}

function registerCoordinationHooks(pi: ExtensionAPI): void {
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
    if (runDir && hasTeamWork(SELF) && !activeRequest && toolName !== "wait" && toolName !== "message") {
      return { block: true, reason: coordinationPrompt() };
    }
  });

  // If the agent stops without waiting while children are still live (or child
  // messages are unread), immediately continue with an explicit wait-only nudge.
  if (!IS_CHILD) {
    pi.on("agent_end", () => {
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
  // On completion the subagent pushes only a result-file notice to its parent.
  // If it still has live children or unread child messages, it is not allowed to
  // finish; continue the agent loop with an explicit wait-only nudge instead.
  pi.on("agent_end", (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const status = finalAssistantStatus(messages);
    const needsAttention = statusNeedsAttention(status);

    if (!needsAttention && hasTeamWork(SELF)) {
      writeBeacon(SELF, { state: "running", activity: "must wait" });
      pi.sendUserMessage(coordinationPrompt(), { deliverAs: "followUp" });
      return;
    }

    if (PARENT) {
      const resultFile = writeResultFile(SELF, messages);
      post({
        id: rid(),
        from: SELF,
        to: PARENT,
        body: resultReadyMessage(SELF, resultFile, needsAttention ? "attention" : "done", status.errorMessage),
        kind: needsAttention ? "attention" : "completion",
        ts: now(),
      });
    }
    writeBeacon(SELF, { state: needsAttention ? "stopped" : "done" });
  });
}

// --------------------------------------------------------------------------
// Team view — a styled, live panel above the editor (root + UI; on by default)
// --------------------------------------------------------------------------

let uiReady = false;
let viewEnabled = true;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastSig: string | undefined;

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

// A plain change-detector so we only repaint when something actually moved.
function viewSignature(agents: Beacon[]): string {
  const rows = agents.map((a) => `${a.name}:${a.state}:${a.activity ?? ""}:${elapsed(a)}`).join("|");
  return `${rows}#${readFeed().slice(-FEED_TAIL).join("|")}`;
}

function teamLines(theme: Theme, width: number): string[] {
  const agents = listAgents();
  const W = Math.max(38, Math.min(width, 78));
  const inner = W - 4;
  const B = (s: string) => theme.fg("borderAccent", s);
  const frame = (content: string) => `${B("│")} ${padTo(content, inner)} ${B("│")}`;
  const titledBar = (open: string, close: string, label: string) => {
    const lead = `${open}─ `;
    const dashes = Math.max(0, W - 1 - visibleWidth(lead) - visibleWidth(label) - 1);
    return B(lead) + theme.bold(theme.fg("accent", label)) + " " + B("─".repeat(dashes) + close);
  };

  const out: string[] = [titledBar("╭", "╮", "Subagents")];

  // main owns the panel (the title); its children/grandchildren form the tree.
  const byParent = new Map<string | null, Beacon[]>();
  for (const a of agents) {
    if (a.name === "main") continue;
    if (!byParent.has(a.parent)) byParent.set(a.parent, []);
    byParent.get(a.parent)!.push(a);
  }
  const rows: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.startedAt - y.startedAt)) {
      const color = STATE_COLOR[a.state] ?? "muted";
      const head = `${"  ".repeat(depth)}${theme.fg(color, GLYPH[a.state] ?? "•")} ${theme.bold(theme.fg("text", a.name))}`
        + (a.taskName ? theme.fg("muted", ` · ${a.taskName}`) : "")
        + `  ${theme.fg(color, a.state)}`
        + (a.activity ? theme.fg("dim", `  ${a.activity}`) : "");
      const right = theme.fg("dim", elapsed(a));
      const gap = inner - visibleWidth(head) - visibleWidth(right);
      rows.push(gap >= 1 ? `${head}${" ".repeat(gap)}${right}` : padTo(head, inner));
      walk(a.name, depth + 1);
    }
  };
  walk("main", 0);
  if (!rows.length) rows.push(theme.fg("dim", "no subagents yet"));
  for (const r of rows) out.push(frame(r));

  const feed = readFeed().slice(-FEED_TAIL);
  if (feed.length) {
    out.push(titledBar("├", "┤", "feed"));
    for (const line of feed) {
      const i = line.indexOf(": ");
      const route = i < 0 ? line : line.slice(0, i);
      const body = i < 0 ? "" : line.slice(i + 2);
      out.push(frame(`${theme.fg("accent", route)}  ${theme.fg("dim", body)}`));
    }
  }

  out.push(B(`╰${"─".repeat(W - 2)}╯`));
  return out;
}

function refreshView(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const agents = runDir ? listAgents() : [];
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
  ctx.ui.setWidget(VIEW_KEY, (_tui, theme): Component => ({ render: (w: number) => teamLines(theme, w) }), {
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

// --------------------------------------------------------------------------
// Watchdog (root + UI only): stuck agents are a human decision, never a timeout
// --------------------------------------------------------------------------

const flagged = new Set<string>();
let prompting = false;

function startWatchdog(ctx: ExtensionContext): void {
  setInterval(async () => {
    if (!runDir || prompting) return;
    // Only direct children: those this session can actually stop.
    for (const a of listAgents()) {
      if (a.parent !== SELF || TERMINAL.has(a.state) || flagged.has(a.name)) continue;
      if (now() - a.updatedAt < STALE_MS) continue;
      flagged.add(a.name);
      prompting = true;
      const stop = await ctx.ui.confirm(
        "Subagent stuck?",
        `${a.name} · ${a.taskName} — no progress for ${fmtAge(now() - a.updatedAt)}. Stop it?`,
      );
      prompting = false;
      if (stop) {
        kids.get(a.name)?.kill();
        writeBeacon(a.name, { state: "stopped" });
        post({ id: rid(), from: a.name, to: SELF, body: `stopped by watchdog after ${fmtAge(now() - a.updatedAt)} without progress. You may repair it by messaging/resuming the agent if needed.`, kind: "attention", ts: now() });
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
  });

  // Root + interactive only: the team view and its watchdog (registered once).
  pi.on("session_start", (_event, ctx) => {
    if (IS_CHILD || !ctx.hasUI || uiReady) return;
    uiReady = true;
    viewEnabled = loadView();
    sweepOldRuns();
    pi.registerCommand("subagents", {
      description: "Toggle the live subagent team view (persisted, on by default).",
      handler: async (_args, cmdCtx) => toggleView(cmdCtx),
    });
    startWatchdog(ctx);
    refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
  });
}

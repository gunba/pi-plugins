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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const RESULT_MAX = 2000;

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

type Beacon = {
  name: string;
  parent: string | null;
  taskName: string;
  state: string;
  activity?: string;
  startedAt: number;
  updatedAt: number;
};

type Mail = {
  id: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  ts: number;
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

// The subagent's final answer, to push to its parent on completion.
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content.slice(0, RESULT_MAX);
    if (Array.isArray(m.content)) {
      return (m.content as { type?: string; text?: string }[])
        .filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n").slice(0, RESULT_MAX);
    }
  }
  return "";
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
function isActive(name: string): boolean {
  return existsSync(activeLock(name));
}

function writeBeacon(name: string, patch: Partial<Beacon>): void {
  const dir = agentDir(name);
  ensureDir(dir);
  const prev = readJson<Beacon>(join(dir, "beacon.json"));
  const beacon: Beacon = {
    name,
    parent: patch.parent ?? prev?.parent ?? (name === SELF ? PARENT : null),
    taskName: patch.taskName ?? prev?.taskName ?? "",
    state: patch.state ?? prev?.state ?? "running",
    activity: patch.activity ?? prev?.activity,
    startedAt: prev?.startedAt ?? patch.startedAt ?? now(),
    updatedAt: now(),
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
  kids.set(name, child);
  // Safety net: if the process dies without a clean agent_end, surface it to the launcher.
  child.on("exit", (code) => {
    rmSync(activeLock(name), { recursive: true, force: true });
    const b = readJson<Beacon>(join(agentDir(name), "beacon.json"));
    if (!b || !TERMINAL.has(b.state)) {
      writeBeacon(name, { state: code === 0 ? "done" : "error" });
      post({ id: rid(), from: name, to: SELF, body: code === 0 ? "(completed)" : `exited unexpectedly (code ${code})`, ts: now() });
    }
    kids.delete(name);
  });
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
      "After spawning your team, call `wait` and let them run rather than duplicating their work. They can't reach the user, so they ask you — investigate if needed, then reply.",
      "Nested subagents need your approval: reply 'approve' or 'deny' when a subagent asks to spawn one. A stuck subagent never blocks you — `wait` is interruptible and `/subagents` shows the whole team.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "One objective and its done criteria. The subagent starts cold — say everything it needs." }),
      name: Type.String({ description: "A short task name you choose for this subagent (e.g. 'auth-race repro'), shown in the team view." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      ensureRun();

      if (IS_CHILD) {
        const reqId = rid();
        post({ id: reqId, from: SELF, to: "main", body: `[approval] spawn "${params.name}": ${params.task}`, ts: now() });
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
      "Messaging an agent that has finished resumes it from its own memory with your message as a follow-up task; its result returns like a spawn — call wait.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name, or 'main'." }),
      body: Type.String({ description: "The message." }),
      reply_to: Type.Optional(Type.String({ description: "Id of the message you are answering." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until the recipient replies." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!runDir) return text("No run yet — spawn a subagent first.");
      const known = params.to === "main" || existsSync(join(agentDir(params.to), "beacon.json"));
      if (!known) return text(`No agent named ${params.to}.`);

      // A finished agent has no live process: resume it with this message as a follow-up.
      if (params.to !== "main" && !isActive(params.to) && runAgent(params.to, params.body, ctx, false)) {
        refreshView(ctx);
        return text(`Re-addressing ${params.to} (resuming its session). Call wait for its result.`);
      }

      const id = rid();
      post({ id, from: SELF, to: params.to, body: params.body, replyTo: params.reply_to, ts: now() });
      if (!params.wait) return text(`Sent to ${params.to}.`);
      const reply = await pollFor(() => takeReply(SELF, id), signal);
      return text(reply ? `${reply.from}: ${reply.body}` : "Reply wait interrupted.");
    },
  });

  pi.registerTool({
    name: "wait",
    label: "Wait for team",
    description: "Yield until a subagent needs you (a question or approval request) or one finishes. Always interruptible.",
    promptSnippet: "wait(): yield until a subagent needs you or finishes",
    promptGuidelines: [
      "After spawning your team, call `wait` to yield. It returns when a subagent messages you or one reaches a terminal state. Answer with `message`, then `wait` again. Don't poll; `wait` wakes you.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate) {
      if (!runDir) return text("No run yet — spawn a subagent first.");
      if (!IS_CHILD) writeBeacon("main", { state: "waiting", activity: "coordinating" });

      // Questions, approval requests, results, and crash notices all arrive as messages.
      const event = await pollFor(() => {
        const fresh = peekFresh(SELF);
        if (!fresh) return undefined;
        rmSync(fresh.path, { force: true });
        return `${fresh.msg.from} (id ${fresh.msg.id}): ${fresh.msg.body}`;
      }, signal);

      if (!IS_CHILD) writeBeacon("main", { state: "running", activity: "" });
      return text(event ?? "wait interrupted.");
    },
  });
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
  // On completion the subagent pushes its result to its parent and exits — the
  // parent learns the outcome from the message, holding no state of its own.
  pi.on("agent_end", (event) => {
    if (PARENT) {
      const result = lastAssistantText((event as { messages?: unknown[] }).messages ?? []);
      post({ id: rid(), from: SELF, to: PARENT, body: result || "(completed)", ts: now() });
    }
    writeBeacon(SELF, { state: "done" });
  });
}

// --------------------------------------------------------------------------
// Team view (root + UI only)
// --------------------------------------------------------------------------

let viewShown = false;
let uiReady = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function renderView(): string[] {
  const agents = listAgents();
  if (!agents.length) return ["No subagents in this run."];

  const byParent = new Map<string | null, Beacon[]>();
  for (const a of agents) {
    const k = a.name === "main" ? null : a.parent;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(a);
  }

  const lines: string[] = ["Team — pi-subagents"];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.startedAt - y.startedAt)) {
      const pad = "  ".repeat(depth);
      const label = a.name === "main" ? a.name : `${a.name} · ${a.taskName}`;
      const act = a.activity ? `  ${a.activity}` : "";
      lines.push(`${pad}${GLYPH[a.state] ?? "•"} ${label}   ${a.state}${act}   ${fmtAge(now() - a.startedAt)}`);
      walk(a.name, depth + 1);
    }
  };
  // root nodes: main (parent null) plus any orphan
  walk(null, 0);

  const feedPath = join(runDir, "feed.log");
  if (existsSync(feedPath)) {
    const feed = readFileSync(feedPath, "utf8").trim().split("\n").slice(-FEED_TAIL);
    if (feed.length) lines.push("— feed —", ...feed);
  }
  return lines;
}

function refreshView(ctx: ExtensionContext): void {
  if (viewShown && ctx.hasUI) ctx.ui.setWidget(VIEW_KEY, renderView(), { placement: "aboveEditor" });
}

function toggleView(ctx: ExtensionContext): void {
  viewShown = !viewShown;
  if (viewShown) {
    refreshView(ctx);
    refreshTimer = setInterval(() => refreshView(ctx), REFRESH_MS);
  } else {
    ctx.ui.setWidget(VIEW_KEY, undefined);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
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
    sweepOldRuns();
    pi.registerCommand("subagents", {
      description: "Toggle the live subagent team view.",
      handler: async (_args, cmdCtx) => toggleView(cmdCtx),
    });
    startWatchdog(ctx);
  });
}

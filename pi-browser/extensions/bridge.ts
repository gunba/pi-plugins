import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRIDGE_DIR = process.env.PI_BROWSER_BRIDGE_DIR || join(homedir(), ".pi", "agent", "pi-browser", "bridge");
const HEARTBEAT_MS = 2_000;
const POLL_MS = 700;

type BridgeCommand = {
  id: string;
  type: "prompt" | "follow_up" | "abort";
  message?: string;
  createdAt: number;
};

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let commandTimer: ReturnType<typeof setInterval> | undefined;
let currentSessionId: string | undefined;
let currentHeartbeatPath: string | undefined;
let processing = false;

function dir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function sessionsDir(): string {
  return join(BRIDGE_DIR, "sessions");
}

function inboxDir(sessionId: string): string {
  return join(BRIDGE_DIR, "inbox", sessionId);
}

function heartbeatPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

function writeHeartbeat(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  dir(sessionsDir());
  currentSessionId = sessionId;
  currentHeartbeatPath = heartbeatPath(sessionId);
  writeFileSync(currentHeartbeatPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    sessionId,
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName(),
    cwd: ctx.cwd,
    mode: ctx.mode,
    isIdle: ctx.isIdle(),
    hasPendingMessages: ctx.hasPendingMessages(),
    updatedAt: Date.now(),
  }, null, 2)}\n`);
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return undefined; }
}

function nextCommand(sessionId: string): { path: string; command: BridgeCommand } | undefined {
  const inbox = inboxDir(sessionId);
  if (!existsSync(inbox)) return undefined;
  for (const file of readdirSync(inbox).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(inbox, file);
    const command = readJson<BridgeCommand>(path);
    if (!command?.id || !command.type) {
      rmSync(path, { force: true });
      continue;
    }
    return { path, command };
  }
  return undefined;
}

async function processCommands(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (processing) return;
  const sessionId = currentSessionId;
  if (!sessionId) return;
  processing = true;
  try {
    for (;;) {
      const next = nextCommand(sessionId);
      if (!next) return;
      try {
        const command = next.command;
        if (command.type === "abort") {
          ctx.abort();
        } else {
          const message = command.message?.trim();
          if (message) {
            if (command.type === "follow_up") {
              if (ctx.isIdle()) pi.sendUserMessage(message);
              else pi.sendUserMessage(message, { deliverAs: "followUp" });
            } else {
              if (ctx.isIdle()) pi.sendUserMessage(message);
              else pi.sendUserMessage(message, { deliverAs: "steer" });
            }
          }
        }
      } finally {
        unlinkSync(next.path);
      }
    }
  } finally {
    processing = false;
  }
}

function stopBridge(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (commandTimer) clearInterval(commandTimer);
  heartbeatTimer = undefined;
  commandTimer = undefined;
  if (currentHeartbeatPath) rmSync(currentHeartbeatPath, { force: true });
  currentSessionId = undefined;
  currentHeartbeatPath = undefined;
}

export default function bridge(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    stopBridge();
    // Browser RPC workers are already managed directly by pi-browser. The bridge is
    // for desktop/TUI sessions so the phone UI can see and steer them.
    if (ctx.mode !== "tui") return;
    writeHeartbeat(ctx);
    heartbeatTimer = setInterval(() => writeHeartbeat(ctx), HEARTBEAT_MS);
    commandTimer = setInterval(() => { processCommands(pi, ctx).catch(() => undefined); }, POLL_MS);
  });

  pi.on("agent_start", (_event, ctx) => { if (ctx.mode === "tui") writeHeartbeat(ctx); });
  pi.on("agent_end", (_event, ctx) => { if (ctx.mode === "tui") writeHeartbeat(ctx); });
  pi.on("session_shutdown", stopBridge);
}

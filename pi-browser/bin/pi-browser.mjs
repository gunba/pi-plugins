#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const MAX_EVENTS = 1200;
const MAX_SESSION_FILES = 300;
const COMMAND_TIMEOUT_MS = 45_000;
const TOKEN_FILE = join(os.homedir(), ".config", "pi-browser", "env");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || join(AGENT_DIR, "sessions");
const BRIDGE_DIR = process.env.PI_BROWSER_BRIDGE_DIR || join(AGENT_DIR, "pi-browser", "bridge");
const DESKTOP_STALE_MS = 30_000;
const DIRECTORY_ENTRY_LIMIT = 300;
const WORKSPACE_SUGGESTION_LIMIT = 80;
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const host = args.host ?? process.env.PI_BROWSER_HOST ?? DEFAULT_HOST;
const port = Number(args.port ?? process.env.PI_BROWSER_PORT ?? DEFAULT_PORT);
const token = args.token ?? process.env.PI_BROWSER_TOKEN ?? process.env.PI_WEB_TOKEN ?? await readTokenFile() ?? randomBytes(24).toString("base64url");
const workers = new Map();

if (!process.env.PI_BROWSER_TOKEN && !process.env.PI_WEB_TOKEN && !args.token) await writeTokenFile(token);

class Worker {
  constructor({ cwd, name, sessionPath }) {
    this.id = randomUUID().slice(0, 8);
    this.cwd = cwd || process.cwd();
    this.name = name || undefined;
    this.sessionPath = sessionPath || undefined;
    this.createdAt = Date.now();
    this.lastEventAt = this.createdAt;
    this.events = [];
    this.clients = new Set();
    this.pending = new Map();
    this.state = { isStreaming: false, pendingMessageCount: 0 };
    this.stderr = [];
    this.exited = false;

    const argv = ["--mode", "rpc", ...(this.name ? ["--name", this.name] : [])];
    this.child = spawn("pi", argv, { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.addEvent({ type: "browser_worker_start", workerId: this.id, cwd: this.cwd, name: this.name, sessionPath: this.sessionPath, pid: this.child.pid, timestamp: Date.now() });
    attachJsonl(this.child.stdout, (line) => this.onLine(line));
    attachText(this.child.stderr, (text) => this.onStderr(text));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.rejectAll(new Error(`pi exited (${signal ?? code ?? "unknown"})`));
      this.addEvent({ type: "browser_worker_exit", code, signal, timestamp: Date.now() });
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
      this.addEvent({ type: "browser_worker_error", error: error.message, timestamp: Date.now() });
    });
  }

  async init() {
    if (!this.sessionPath) return;
    const response = await this.send({ type: "switch_session", sessionPath: this.sessionPath }, 60_000);
    if (!response.success) throw new Error(response.error || "switch_session failed");
  }

  onLine(line) {
    let event;
    try { event = JSON.parse(line); }
    catch (error) {
      this.addEvent({ type: "browser_parse_error", line, error: String(error), timestamp: Date.now() });
      return;
    }
    if (event.type === "response" && event.id && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id);
      clearTimeout(pending.timer);
      this.pending.delete(event.id);
      pending.resolve(event);
    }
    this.applyEvent(event);
    this.addEvent({ ...event, receivedAt: Date.now() });
  }

  onStderr(text) {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      this.stderr.push(line);
      if (this.stderr.length > 60) this.stderr.shift();
      this.addEvent({ type: "browser_stderr", text: line, timestamp: Date.now() });
    }
  }

  applyEvent(event) {
    if (event.type === "agent_start") this.state.isStreaming = true;
    if (event.type === "agent_end") this.state.isStreaming = false;
    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp : [];
      this.state.steering = steering;
      this.state.followUp = followUp;
      this.state.pendingMessageCount = steering.length + followUp.length;
    }
    if (event.type === "response" && event.command === "get_state" && event.success && event.data) this.state = { ...this.state, ...event.data };
  }

  addEvent(event) {
    this.lastEventAt = Date.now();
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  summary() {
    return { id: this.id, cwd: this.cwd, name: this.name, sessionPath: this.sessionPath, pid: this.child.pid, createdAt: this.createdAt, lastEventAt: this.lastEventAt, exited: this.exited, state: this.state, stderr: this.stderr.slice(-8) };
  }

  send(command, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (this.exited) throw new Error("worker has exited");
    const id = command.id || randomUUID();
    const wire = { ...command, id };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${wire.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify(wire)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      });
    });
  }

  sendRaw(command) {
    if (this.exited) throw new Error("worker has exited");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  subscribe(res) {
    this.clients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ worker: this.summary(), events: this.events })}\n\n`);
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 20_000);
    res.on("close", () => { clearInterval(ping); this.clients.delete(res); });
  }

  stop() {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, 3_000).unref();
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(url, res);
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/api/status") return json(res, 200, { ok: true, cwd: process.cwd(), sessionsDir: SESSIONS_DIR, workers: [...workers.values()].map((w) => w.summary()), desktopSessions: await listDesktopSessions() });
    if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: await listSessions() });
    if (url.pathname === "/api/session" && req.method === "GET") return json(res, 200, await readSession(url.searchParams.get("path") || ""));
    if (url.pathname === "/api/workspaces" && req.method === "GET") return json(res, 200, await listWorkspaces());
    if (url.pathname === "/api/fs/dirs" && req.method === "GET") return json(res, 200, await listDirectories(url.searchParams.get("path") || os.homedir()));
    if (url.pathname === "/api/fs/dirs" && req.method === "POST") return createDirectory(req, res);
    if (url.pathname === "/api/workers" && req.method === "GET") return json(res, 200, { workers: [...workers.values()].map((w) => w.summary()) });
    if (url.pathname === "/api/workers" && req.method === "POST") return createWorker(req, res);
    const match = url.pathname.match(/^\/api\/workers\/([^/]+)(?:\/(.*))?$/);
    if (match) return workerRoute(req, res, match[1], match[2] || "");
    const desktopMatch = url.pathname.match(/^\/api\/desktop\/([^/]+)(?:\/(.*))?$/);
    if (desktopMatch) return desktopRoute(req, res, desktopMatch[1], desktopMatch[2] || "");
    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  const shownHost = host === "0.0.0.0" ? localAddress() || "127.0.0.1" : host;
  console.log(`pi-browser listening on http://${shownHost}:${port}`);
  console.log(`token: ${token}`);
  console.log(`open: http://${shownHost}:${port}/#token=${encodeURIComponent(token)}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  for (const worker of workers.values()) worker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4_000).unref();
}

async function createWorker(req, res) {
  const body = await readJson(req);
  let cwd = typeof body.cwd === "string" && body.cwd.trim() ? resolve(body.cwd.trim()) : process.cwd();
  let sessionPath;
  if (typeof body.sessionPath === "string" && body.sessionPath.trim()) {
    sessionPath = assertSessionPath(body.sessionPath.trim());
    const meta = await sessionMeta(sessionPath);
    if (meta.cwd) cwd = meta.cwd;
  }
  if (!existsSync(cwd)) return json(res, 400, { error: `cwd does not exist: ${cwd}` });
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  const worker = new Worker({ cwd, name, sessionPath });
  workers.set(worker.id, worker);
  try { await worker.init(); }
  catch (error) { worker.stop(); workers.delete(worker.id); throw error; }
  return json(res, 201, { worker: worker.summary() });
}

async function workerRoute(req, res, id, action) {
  const worker = workers.get(id);
  if (!worker) return json(res, 404, { error: "unknown worker" });
  if (action === "events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    worker.subscribe(res);
    return;
  }
  if (action === "" && req.method === "DELETE") {
    worker.stop(); workers.delete(id); return json(res, 200, { ok: true });
  }
  if (action === "prompt" && req.method === "POST") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) return json(res, 400, { error: "message required" });
    const mode = body.mode === "steer" || body.mode === "follow_up" ? body.mode : "prompt";
    const command = mode === "steer" ? { type: "steer", message } : mode === "follow_up" ? { type: "follow_up", message } : { type: "prompt", message, ...(body.streamingBehavior ? { streamingBehavior: body.streamingBehavior } : {}) };
    const response = await worker.send(command, 60_000);
    return json(res, response.success ? 200 : 400, response);
  }
  if (action === "abort" && req.method === "POST") return json(res, 200, await worker.send({ type: "abort" }));
  if (action === "state" && req.method === "GET") return json(res, 200, await worker.send({ type: "get_state" }));
  if (action === "ui" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.id) return json(res, 400, { error: "extension UI id required" });
    worker.sendRaw({ type: "extension_ui_response", id: String(body.id), ...(body.cancelled ? { cancelled: true } : {}), ...("value" in body ? { value: body.value } : {}), ...("confirmed" in body ? { confirmed: !!body.confirmed } : {}) });
    return json(res, 200, { ok: true });
  }
  if (action === "rpc" && req.method === "POST") return json(res, 200, await worker.send(await readJson(req), 60_000));
  return json(res, 404, { error: "not found" });
}

async function desktopRoute(req, res, sessionId, action) {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId || safeId !== sessionId) return json(res, 400, { error: "invalid desktop session id" });
  const session = (await listDesktopSessions({ includeStale: true })).find((item) => item.sessionId === sessionId);
  if (!session) return json(res, 404, { error: "desktop session is not registered; run /reload in that Pi session" });
  if (action === "prompt" && req.method === "POST") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) return json(res, 400, { error: "message required" });
    await writeBridgeCommand(sessionId, { type: body.mode === "follow_up" ? "follow_up" : "prompt", message });
    return json(res, 200, { ok: true });
  }
  if (action === "abort" && req.method === "POST") {
    await writeBridgeCommand(sessionId, { type: "abort" });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

async function listDesktopSessions(options = {}) {
  const dir = join(BRIDGE_DIR, "sessions");
  let names;
  try { names = await readdir(dir); }
  catch { return []; }
  const now = Date.now();
  const out = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try {
      const item = JSON.parse(await readFile(join(dir, name), "utf8"));
      const stale = now - Number(item.updatedAt || 0) > DESKTOP_STALE_MS;
      if (stale && !options.includeStale) continue;
      out.push({ ...item, kind: "desktop", stale });
    } catch {}
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

async function writeBridgeCommand(sessionId, command) {
  const inbox = join(BRIDGE_DIR, "inbox", sessionId);
  await mkdir(inbox, { recursive: true });
  const id = randomUUID();
  const payload = { id, createdAt: Date.now(), ...command };
  const tmp = join(inbox, `${Date.now()}-${id}.tmp`);
  const final = tmp.replace(/\.tmp$/, ".json");
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(tmp, final);
  return payload;
}

async function listWorkspaces() {
  const home = os.homedir();
  const candidates = [];
  for (const desktop of await listDesktopSessions({ includeStale: true })) {
    if (desktop.cwd) candidates.push({ path: desktop.cwd, label: workspaceName(desktop.cwd), source: "running" });
  }
  for (const session of await listSessions()) {
    if (session.cwd) candidates.push({ path: session.cwd, label: workspaceName(session.cwd), source: "recent" });
  }
  candidates.push(
    { path: join(home, "Desktop", "Projects"), label: "Desktop Projects", source: "common" },
    { path: join(home, "Projects"), label: "Projects", source: "common" },
    { path: join(home, "Code"), label: "Code", source: "common" },
    { path: join(home, "Developer"), label: "Developer", source: "common" },
    { path: join(home, "Desktop"), label: "Desktop", source: "common" },
    { path: home, label: "Home", source: "common" },
    { path: join(home, "Documents"), label: "Documents", source: "common" },
    { path: join(home, "Downloads"), label: "Downloads", source: "common" },
    { path: process.cwd(), label: "Server cwd", source: "current" },
  );
  const seen = new Set();
  const workspaces = [];
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    if (seen.has(path) || !isDirectory(path)) continue;
    seen.add(path);
    workspaces.push({ ...candidate, path, displayPath: shortFsPath(path) });
    if (workspaces.length >= WORKSPACE_SUGGESTION_LIMIT) break;
  }
  return { defaultPath: workspaces[0]?.path || home, home, workspaces };
}

async function listDirectories(input) {
  const path = resolve(input || os.homedir());
  if (!isDirectory(path)) throw new Error(`not a directory: ${path}`);
  const parent = dirname(path) === path ? undefined : dirname(path);
  const entries = [];
  let truncated = false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    entries.push({ name: entry.name, path: join(path, entry.name), displayPath: shortFsPath(join(path, entry.name)) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (entries.length > DIRECTORY_ENTRY_LIMIT) {
    entries.length = DIRECTORY_ENTRY_LIMIT;
    truncated = true;
  }
  return { path, displayPath: shortFsPath(path), parent, parentDisplayPath: parent ? shortFsPath(parent) : undefined, entries, truncated };
}

async function createDirectory(req, res) {
  const body = await readJson(req);
  const parent = resolve(String(body.parent || os.homedir()));
  if (!isDirectory(parent)) return json(res, 400, { error: `parent is not a directory: ${parent}` });
  const name = String(body.name || "").trim();
  if (!validDirectoryName(name)) return json(res, 400, { error: "folder name must be a single normal directory name" });
  const path = join(parent, name);
  if (existsSync(path)) return json(res, 409, { error: `folder already exists: ${path}` });
  await mkdir(path, { recursive: false, mode: 0o755 });
  return json(res, 201, { name, path, displayPath: shortFsPath(path), parent, parentDisplayPath: shortFsPath(parent) });
}

function validDirectoryName(name) {
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !/[\0\r\n]/.test(name);
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

function workspaceName(path) {
  return basename(path) || path;
}

function shortFsPath(path) {
  const home = os.homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

async function listSessions() {
  const files = [];
  await walk(SESSIONS_DIR, files);
  const out = [];
  for (const path of files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, MAX_SESSION_FILES)) out.push(await sessionMeta(path));
  return out;
}

async function walk(dir, files) {
  let entries;
  try { entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true })); }
  catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
}

async function sessionMeta(path) {
  const stat = statSync(path);
  const meta = { path, id: undefined, cwd: undefined, name: undefined, firstUser: "", modifiedAt: stat.mtimeMs, size: stat.size, messageCount: 0 };
  await readJsonLines(path, (entry) => {
    if (entry.type === "session") { meta.id = entry.id; meta.cwd = entry.cwd; }
    if (entry.type === "session_info" && entry.name) meta.name = entry.name;
    if (entry.type === "message") {
      meta.messageCount += 1;
      if (!meta.firstUser && entry.message?.role === "user") meta.firstUser = plainText(entry.message.content).slice(0, 160);
    }
  }, 400);
  meta.title = meta.name || meta.firstUser || meta.id || path.split("/").pop();
  return meta;
}

async function readSession(path) {
  const sessionPath = assertSessionPath(path);
  const entries = [];
  let header;
  await readJsonLines(sessionPath, (entry) => {
    if (entry.type === "session") header = entry;
    entries.push(entry);
  });
  return { path: sessionPath, header, entries, messages: entries.map(displayEntry).filter(Boolean) };
}

function displayEntry(entry) {
  if (entry.type === "session_info") return { id: entry.id, type: "info", role: "system", text: `Session: ${entry.name}`, timestamp: entry.timestamp };
  if (entry.type !== "message") return undefined;
  const m = entry.message || {};
  if (m.role === "user") return { id: entry.id, type: "message", role: "user", text: plainText(m.content), timestamp: entry.timestamp };
  if (m.role === "assistant") return { id: entry.id, type: "message", role: "assistant", text: plainText(m.content), timestamp: entry.timestamp };
  if (m.role === "toolResult") return { id: entry.id, type: "tool", role: "tool", text: `${m.toolName || "tool"}: ${plainText(m.content)}`, timestamp: entry.timestamp, isError: !!m.isError };
  if (m.role === "bashExecution") return { id: entry.id, type: "tool", role: "bash", text: `$ ${m.command}\n${m.output || ""}`, timestamp: entry.timestamp };
  return undefined;
}

function plainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text") return part.text || "";
    if (part.type === "thinking") return "";
    if (part.type === "toolCall") return `\n[tool: ${part.name || "tool"}]`;
    if (part.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function assertSessionPath(input) {
  const path = resolve(input);
  const rel = relative(resolve(SESSIONS_DIR), path);
  if (rel.startsWith("..") || rel === "" || resolve(SESSIONS_DIR) === path || !path.endsWith(".jsonl")) throw new Error("invalid session path");
  return path;
}

async function readJsonLines(path, onEntry, maxLines = Infinity) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let buffer = "";
  let count = 0;
  for await (const chunk of stream) {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        try { onEntry(JSON.parse(line)); } catch {}
        count += 1; if (count >= maxLines) { stream.destroy(); return; }
      }
    }
  }
  if (buffer.trim() && count < maxLines) { try { onEntry(JSON.parse(buffer)); } catch {} }
}

async function serveStatic(url, res) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = resolve(PUBLIC_DIR, `.${pathname}`);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME.get(extname(file)) || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    const data = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(data);
  }
}

function authorized(req) {
  if (!token) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${token}`) return true;
  try {
    const url = new URL(req.url || "/", "http://localhost");
    return url.searchParams.get("token") === token;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}
function json(res, code, value) { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
function attachJsonl(stream, onLine) {
  const decoder = new StringDecoder("utf8"); let buffer = "";
  stream.on("data", (chunk) => { buffer += decoder.write(chunk); for (;;) { const idx = buffer.indexOf("\n"); if (idx < 0) break; const line = buffer.slice(0, idx).replace(/\r$/, ""); buffer = buffer.slice(idx + 1); if (line.trim()) onLine(line); } });
  stream.on("end", () => { buffer += decoder.end(); const line = buffer.replace(/\r$/, ""); if (line.trim()) onLine(line); });
}
function attachText(stream, onText) { const decoder = new StringDecoder("utf8"); stream.on("data", (chunk) => onText(decoder.write(chunk))); stream.on("end", () => { const rest = decoder.end(); if (rest) onText(rest); }); }
function localAddress() { const nets = os.networkInterfaces(); for (const entries of Object.values(nets)) for (const n of entries || []) if (n.family === "IPv4" && !n.internal) return n.address; return undefined; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === "--help" || arg === "-h") out.help = true; else if (arg === "--host") out.host = argv[++i]; else if (arg === "--port" || arg === "-p") out.port = argv[++i]; else if (arg === "--token") out.token = argv[++i]; else throw new Error(`unknown argument: ${arg}`); } return out; }
async function readTokenFile() { try { const text = await readFile(TOKEN_FILE, "utf8"); return text.match(/^PI_BROWSER_TOKEN=(.+)$/m)?.[1]?.trim() || text.match(/^PI_WEB_TOKEN=(.+)$/m)?.[1]?.trim(); } catch { return undefined; } }
async function writeTokenFile(value) { await mkdir(dirname(TOKEN_FILE), { recursive: true }); await import("node:fs/promises").then((fs) => fs.writeFile(TOKEN_FILE, `PI_BROWSER_TOKEN=${value}\n`, { mode: 0o600 })); }
function printHelp() { console.log(`pi-browser\n\nUsage: pi-browser [--host 127.0.0.1] [--port 8080] [--token secret]\n\nOpen: http://host:port/#token=secret\n`); }

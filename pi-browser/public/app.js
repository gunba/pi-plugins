const $ = (id) => document.getElementById(id);
let token = localStorage.piBrowserToken || "";
let activeWorker = localStorage.piBrowserWorker || "";
let eventSource;
let sessions = [];
let workers = [];
let deferredInstall;
let selectedWorker;
let selectedWorkspace = localStorage.piBrowserWorkspace || "";
let workspaces = [];
let workerOrder = [];
let toolRows = new Map();
let statusBase = "";
let statusEntries = new Map();
let folderPath = "";
let sessionPollTimer;
let sessionRefreshTimer;
let sessionsLoadedAt = 0;
let desktopSessionCursor;
let streamingRenderTimer;
let streamingRenderBody;
let scrollTimer;

const SESSION_LIST_LIMIT = 120;
const SESSION_REFRESH_MS = 45_000;
const DESKTOP_POLL_MS = 2_500;
const SESSION_TAIL_LIMIT = 260;
const STREAM_RENDER_MS = 80;
const MAX_RICH_TEXT_CHARS = 180_000;
const MAX_CODE_LINES = 2_000;

if (location.hash.startsWith("#token=")) {
  token = decodeURIComponent(location.hash.slice(7));
  localStorage.piBrowserToken = token;
  history.replaceState(null, "", location.pathname + location.search);
}

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; $("install").hidden = false; });
$("install").onclick = async () => { await deferredInstall?.prompt(); $("install").hidden = true; };

function headers() { return token ? { Authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" }; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (response.status === 401) {
    token = prompt("Pi Browser token") || "";
    localStorage.piBrowserToken = token;
    if (!token) throw new Error("token required");
    return api(path, options);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
function fmtTime(value) { return value ? new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; }
function messageCountLabel(session) { return `${session.messageCountTruncated ? "≥" : ""}${session.messageCount || 0} msgs`; }
function shortPath(path) { return path?.replace(/^\/home\/jordan/, "~") || ""; }
function pathName(path) { const parts = String(path || "").split("/").filter(Boolean); return parts.at(-1) || path || "Workspace"; }
function label(role) { return role === "assistant" ? "Pi" : role === "user" ? "You" : role || "event"; }
function updateStatusLine() {
  $("status").textContent = [statusBase, ...statusEntries.values()].filter(Boolean).join(" · ") || "Connected";
}

async function loadWorkspaces() {
  try {
    const data = await api("/api/workspaces");
    workspaces = data.workspaces || [];
    if (!selectedWorkspace) selectedWorkspace = data.defaultPath || workspaces[0]?.path || "";
    renderWorkspaceSelect();
  } catch (error) {
    $("status").textContent = error.message;
  }
}

function chooseWorkspace(path, addToSuggestions = true) {
  selectedWorkspace = path;
  localStorage.piBrowserWorkspace = path;
  if (addToSuggestions && path && !workspaces.some((workspace) => workspace.path === path)) {
    workspaces.unshift({ path, label: pathName(path), displayPath: shortPath(path), source: "chosen" });
  }
  renderWorkspaceSelect();
}

function renderWorkspaceSelect() {
  const select = $("workspace");
  if (!select) return;
  select.textContent = "";
  let options = workspaces;
  if (selectedWorkspace && !options.some((workspace) => workspace.path === selectedWorkspace)) {
    options = [{ path: selectedWorkspace, label: pathName(selectedWorkspace), displayPath: shortPath(selectedWorkspace), source: "chosen" }, ...options];
  }
  for (const workspace of options) {
    const option = document.createElement("option");
    option.value = workspace.path;
    option.textContent = `${workspace.label || pathName(workspace.path)} — ${workspace.displayPath || shortPath(workspace.path)}`;
    select.append(option);
  }
  select.value = selectedWorkspace || options[0]?.path || "";
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    workers = stableWorkers([
      ...(status.workers || []).map((worker) => ({ ...worker, kind: "rpc" })),
      ...(status.desktopSessions || []).map(normalizeDesktopSession),
    ]);
    selectedWorker = workers.find((worker) => worker.id === activeWorker) || selectedWorker;
    statusBase = `${workers.length} worker${workers.length === 1 ? "" : "s"} · ${status.sessionsDir}`;
    updateStatusLine();
    renderWorkers();
    updateComposerState();
  } catch (error) { $("status").textContent = error.message; }
}

async function loadSessions(options = {}) {
  if (!options.force && sessionsLoadedAt && Date.now() - sessionsLoadedAt < SESSION_REFRESH_MS) return;
  try {
    sessions = (await api(`/api/sessions?limit=${SESSION_LIST_LIMIT}${options.force ? "&force=1" : ""}`)).sessions || [];
    sessionsLoadedAt = Date.now();
    renderSessions();
  } catch (error) { $("status").textContent = error.message; }
}

function stableWorkers(nextWorkers) {
  const byId = new Map(nextWorkers.map((worker) => [worker.id, worker]));
  workerOrder = workerOrder.filter((id) => byId.has(id));
  for (const worker of nextWorkers) if (!workerOrder.includes(worker.id)) workerOrder.push(worker.id);
  return workerOrder.map((id) => byId.get(id)).filter(Boolean);
}

function renderWorkers() {
  const fragment = document.createDocumentFragment();
  for (const worker of workers) {
    const button = document.createElement("button");
    button.className = `item ${worker.id === activeWorker ? "active" : ""}`;
    const kind = worker.kind === "desktop" ? "desktop" : "browser";
    button.innerHTML = `<strong>${escapeHtml(worker.name || worker.state?.sessionName || worker.id)}</strong><span class="meta">${kind} · ${worker.state?.isStreaming ? "running" : worker.exited ? "exited" : worker.stale ? "stale" : "idle"} · ${escapeHtml(shortPath(worker.cwd))}</span>`;
    button.onclick = () => selectWorker(worker.id);
    fragment.append(button);
  }
  $("workers").replaceChildren(fragment);
}

function renderSessions() {
  const fragment = document.createDocumentFragment();
  const filter = $("session-filter").value.toLowerCase();
  for (const session of sessions.filter((s) => `${s.title} ${s.cwd} ${s.firstUser}`.toLowerCase().includes(filter)).slice(0, 80)) {
    const button = document.createElement("button");
    button.className = "item";
    button.innerHTML = `<strong>${escapeHtml(session.title || session.id || "session")}</strong><span class="meta">${escapeHtml(shortPath(session.cwd))} · ${fmtTime(session.modifiedAt)} · ${messageCountLabel(session)}</span>`;
    button.onclick = () => openSession(session);
    fragment.append(button);
  }
  $("sessions").replaceChildren(fragment);
}

async function openFolderDialog(startPath) {
  const dialog = $("folder-dialog");
  dialog.showModal();
  await loadFolder(startPath || selectedWorkspace || "");
}

async function loadFolder(path) {
  const data = await api(`/api/fs/dirs?path=${encodeURIComponent(path || "")}`);
  folderPath = data.path;
  $("folder-path").textContent = data.displayPath || shortPath(data.path);
  $("folder-up").disabled = !data.parent;
  $("folder-up").onclick = () => data.parent && loadFolder(data.parent).catch((error) => alert(error.message));
  const list = $("folder-list");
  list.textContent = "";
  for (const entry of data.entries || []) {
    const button = document.createElement("button");
    button.className = "item";
    button.innerHTML = `<strong>📁 ${escapeHtml(entry.name)}</strong><span class="meta">${escapeHtml(entry.displayPath || shortPath(entry.path))}</span>`;
    button.onclick = () => loadFolder(entry.path).catch((error) => alert(error.message));
    list.append(button);
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "folder-empty";
    empty.textContent = "No visible folders here.";
    list.append(empty);
  }
  if (data.truncated) addBubble("remote", "Folder list was truncated. Choose a narrower parent folder.", "browser");
}

async function createFolder() {
  const name = $("folder-name").value.trim();
  if (!name) return;
  try {
    const created = await api("/api/fs/dirs", { method: "POST", body: JSON.stringify({ parent: folderPath, name }) });
    $("folder-name").value = "";
    chooseWorkspace(created.path);
    await loadFolder(created.path);
  } catch (error) {
    alert(error.message);
  }
}

async function openSession(session) {
  closeSidebar();
  desktopSessionCursor = undefined;
  $("title").textContent = session.title || session.id || "Session";
  const data = await api(`/api/session?path=${encodeURIComponent(session.path)}&tail=${SESSION_TAIL_LIMIT}`);
  renderMessages(data.messages || []);
  if (confirm("Start a browser-controlled Pi worker for this session?")) {
    const created = await api("/api/workers", { method: "POST", body: JSON.stringify({ sessionPath: session.path }) });
    await refreshStatus();
    selectWorker(created.worker.id);
  }
}

async function selectWorker(id) {
  closeSidebar();
  activeWorker = id; localStorage.piBrowserWorker = id;
  renderWorkers();
  if (eventSource) eventSource.close();
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  desktopSessionCursor = undefined;
  const worker = workers.find((w) => w.id === id);
  selectedWorker = worker;
  $("title").textContent = worker?.name || worker?.state?.sessionName || `Pi ${id}`;
  updateComposerState();
  $("messages").textContent = "";
  if (worker?.kind === "desktop") {
    await loadDesktopSession(worker, { reset: true });
    sessionPollTimer = setInterval(() => loadDesktopSession(worker).catch(() => undefined), DESKTOP_POLL_MS);
    return;
  }
  eventSource = new EventSource(`/api/workers/${id}/events?token=${encodeURIComponent(token)}`, { withCredentials: false });
  eventSource.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    selectedWorker = data.worker;
    $("title").textContent = data.worker?.name || data.worker?.state?.sessionName || `Pi ${id}`;
    updateComposerState();
    renderEvents(data.events || []);
  });
  eventSource.onmessage = (event) => appendEvent(JSON.parse(event.data));
  eventSource.onerror = () => $("status").textContent = "event stream disconnected";
}

function normalizeDesktopSession(session) {
  return {
    id: `desktop:${session.sessionId}`,
    kind: "desktop",
    sessionId: session.sessionId,
    cwd: session.cwd,
    name: session.sessionName || `Desktop ${session.sessionId?.slice(0, 6)}`,
    sessionPath: session.sessionFile,
    createdAt: session.updatedAt,
    lastEventAt: session.updatedAt,
    stale: session.stale,
    state: { isStreaming: !session.isIdle, sessionName: session.sessionName, pendingMessageCount: session.hasPendingMessages ? 1 : 0 },
  };
}

async function loadDesktopSession(worker, options = {}) {
  if (!worker.sessionPath) return addBubble("remote", "Desktop session has no session file yet.", "desktop");
  const cursorMatches = desktopSessionCursor?.path === worker.sessionPath;
  const query = cursorMatches && !options.reset
    ? `after=${desktopSessionCursor.nextOffset}`
    : `tail=${SESSION_TAIL_LIMIT}`;
  const data = await api(`/api/session?path=${encodeURIComponent(worker.sessionPath)}&${query}`);
  desktopSessionCursor = { path: worker.sessionPath, nextOffset: data.nextOffset ?? data.size ?? desktopSessionCursor?.nextOffset ?? 0 };
  if (data.reset || !cursorMatches || options.reset) renderMessages(data.messages || []);
  else appendMessages(data.messages || []);
}

function renderMessages(messages) {
  flushStreamingRender();
  toolRows.clear();
  const root = $("messages");
  const fragment = document.createDocumentFragment();
  for (const m of messages) appendMessage(m, fragment);
  root.replaceChildren(fragment);
  root.scrollTop = root.scrollHeight;
}
function appendMessages(messages) {
  if (!messages.length) return;
  const root = $("messages");
  const fragment = document.createDocumentFragment();
  for (const m of messages) appendMessage(m, fragment);
  root.append(fragment);
  scheduleScrollToBottom();
}
function renderEvents(events) {
  flushStreamingRender();
  toolRows.clear();
  const root = $("messages");
  root.textContent = "";
  for (const e of events) appendEvent(e, false);
  root.scrollTop = root.scrollHeight;
}
function appendMessage(m, parent = $("messages")) {
  if (!m.text?.trim()) return;
  if (m.type === "tool" || m.role === "tool" || m.role === "bash") return addTranscriptTool(m, parent);
  addBubble(m.role, m.text, label(m.role), parent);
}
function appendEvent(e, scroll = true) {
  applyLiveState(e);
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") return appendDelta(e.assistantMessageEvent.delta || "");
  if (e.type === "message_end" && e.message) return appendCompletedMessage(e.message);
  if (e.type === "tool_execution_start") return upsertToolRow(e, "running");
  if (e.type === "tool_execution_update") return upsertToolRow(e, "running", plain(e.partialResult?.content));
  if (e.type === "tool_execution_end") return upsertToolRow(e, e.isError ? "error" : "done", plain(e.result?.content), e.isError);
  if (e.type === "extension_ui_request") return handleUiRequest(e);
  if (e.type === "extension_error" || e.type === "browser_worker_error") return addBubble("error", e.error || summarizeEvent(e), "error");
  if (e.type === "browser_stderr") return addBubble("error", e.text || "", "stderr");
  if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}
function appendCompletedMessage(message) {
  const text = plain(message.content);
  if (!text.trim()) return;
  if (message.role === "assistant") return finishAssistantMessage(text);
  if (message.role === "user") { if (consumePendingUserEcho(text)) return; return addBubble("user", text, "You"); }
  if (message.role === "toolResult") return;
  return addBubble(message.role || "remote", text, label(message.role));
}
function appendDelta(text) {
  let bubble = document.querySelector(".msg.assistant.streaming");
  if (!bubble) bubble = addBubble("assistant streaming", "", "Pi");
  const body = bubble.querySelector(".rich");
  body.rawText = `${body.rawText || ""}${text}`;
  scheduleStreamingRender(body);
  scheduleScrollToBottom();
}
function finishAssistantMessage(text) {
  flushStreamingRender();
  const bubble = document.querySelector(".msg.assistant.streaming");
  if (!bubble) return appendMessage({ role: "assistant", text });
  bubble.classList.remove("streaming");
  const body = bubble.querySelector(".rich");
  body.rawText = text;
  renderRichText(body, text, "assistant");
  scheduleScrollToBottom();
}
function consumePendingUserEcho(text) {
  const normalized = normalizeText(text);
  for (const bubble of document.querySelectorAll(".msg.user.pending-user")) {
    if (normalizeText(bubble.dataset.pendingUserText || "") === normalized) {
      bubble.classList.remove("pending-user");
      delete bubble.dataset.pendingUserText;
      return true;
    }
  }
  return false;
}
function normalizeText(text) { return String(text || "").trim().replace(/\s+/g, " "); }
function scheduleStreamingRender(body) {
  streamingRenderBody = body;
  if (streamingRenderTimer) return;
  streamingRenderTimer = setTimeout(flushStreamingRender, STREAM_RENDER_MS);
}
function flushStreamingRender() {
  if (streamingRenderTimer) clearTimeout(streamingRenderTimer);
  streamingRenderTimer = undefined;
  const body = streamingRenderBody;
  streamingRenderBody = undefined;
  if (body?.isConnected) renderRichText(body, body.rawText || "", "assistant");
}
function scheduleScrollToBottom() {
  if (scrollTimer) return;
  scrollTimer = requestAnimationFrame(() => {
    scrollTimer = undefined;
    const root = $("messages");
    root.scrollTop = root.scrollHeight;
  });
}
function addBubble(cls, text, title, parent = $("messages")) {
  const div = document.createElement("div"); div.className = `msg ${cls}`;
  const l = document.createElement("span"); l.className = "label"; l.textContent = title;
  const body = document.createElement("div"); body.className = "rich"; body.rawText = text || "";
  renderRichText(body, text || "", cls);
  div.append(l, body); parent.append(div); return div;
}
function addTranscriptTool(message, parent = $("messages")) {
  const row = createToolRow(parent);
  const toolName = message.role === "bash" ? "bash" : "tool";
  row.div.className = `msg tool compact ${message.isError ? "error" : ""}`;
  row.labelEl.textContent = toolName;
  row.summary.textContent = `${message.isError ? "✗" : "✓"} ${toolName} — ${firstLine(message.text)}`;
  setLazyToolContent(row, message.text || "", !!message.isError);
  return row.div;
}

function upsertToolRow(event, state, text = "", isError = false) {
  const id = event.toolCallId || `${event.toolName || "tool"}-${event.receivedAt || event.timestamp || Date.now()}`;
  let row = toolRows.get(id);
  if (!row) {
    row = createToolRow($("messages"));
    toolRows.set(id, row);
  }
  row.div.className = `msg tool compact ${isError ? "error" : ""}`;
  row.labelEl.textContent = event.toolName || "tool";
  row.summary.textContent = toolSummary(event, state, text);
  setLazyToolContent(row, text || summarizeToolArgs(event), !!isError || row.details.open);
  scheduleScrollToBottom();
  return row.div;
}

function createToolRow(parent) {
  const div = document.createElement("div"); div.className = "msg tool compact";
  const labelEl = document.createElement("span"); labelEl.className = "label"; labelEl.textContent = "tool";
  const body = document.createElement("div"); body.className = "rich tool-row";
  const details = document.createElement("details"); details.className = "tool-details";
  const summary = document.createElement("summary");
  const content = document.createElement("div"); content.className = "tool-content";
  const row = { div, labelEl, details, summary, content, rawText: "" };
  details.ontoggle = () => { if (details.open) renderLazyToolContent(row); };
  details.append(summary, content); body.append(details); div.append(labelEl, body); parent.append(div);
  return row;
}

function setLazyToolContent(row, text, open) {
  row.rawText = text || "";
  row.content.dataset.rendered = "";
  row.content.textContent = "";
  row.details.open = open;
  if (open) renderLazyToolContent(row);
}

function renderLazyToolContent(row) {
  if (row.content.dataset.rendered === "1") return;
  row.content.textContent = "";
  renderRichText(row.content, row.rawText || "", "tool");
  row.content.dataset.rendered = "1";
}
function toolSummary(event, state, text) {
  const icon = state === "error" ? "✗" : state === "done" ? "✓" : "▶";
  const name = event.toolName || "tool";
  const hint = firstLine(text) || summarizeToolArgs(event);
  return hint ? `${icon} ${name} — ${hint}` : `${icon} ${name}`;
}
function summarizeToolArgs(event) {
  const args = event.args || {};
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.url === "string") return args.url;
  if (typeof args.query === "string") return args.query;
  return "";
}
function firstLine(text) {
  const line = String(text || "").split("\n").map((item) => item.trim()).find(Boolean) || "";
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}
function renderRichText(root, text, cls = "") {
  root.textContent = "";
  let value = String(text || "");
  if (value.length > MAX_RICH_TEXT_CHARS) value = `${value.slice(0, MAX_RICH_TEXT_CHARS)}\n\n[Browser preview truncated at ${MAX_RICH_TEXT_CHARS.toLocaleString()} characters]`;
  if (!value) return;
  if ((cls.includes("tool") || cls.includes("bash")) && looksLikeDiff(value)) return root.append(renderCodeBlock(value, "diff"));
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fence.exec(value))) {
    renderMarkdownText(root, value.slice(last, match.index));
    root.append(renderCodeBlock(match[2].replace(/\n$/, ""), match[1].trim()));
    last = fence.lastIndex;
  }
  renderMarkdownText(root, value.slice(last));
}
function renderMarkdownText(root, text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const heading = lines[i].match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      h.innerHTML = inlineMarkdown(heading[2]);
      root.append(h); i++; continue;
    }
    if (/^\s*[-*]\s+/.test(lines[i])) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement("li"); li.innerHTML = inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, "")); ul.append(li); i++;
      }
      root.append(ul); continue;
    }
    if (/^>\s?/.test(lines[i])) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      const bq = document.createElement("blockquote"); bq.innerHTML = inlineMarkdown(quote.join("\n")).replace(/\n/g, "<br>"); root.append(bq); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) paragraph.push(lines[i++]);
    const p = document.createElement("p"); p.innerHTML = inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>"); root.append(p);
  }
}
function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function renderCodeBlock(text, lang = "") {
  const pre = document.createElement("pre"); pre.className = "code-block";
  if (lang) { const l = document.createElement("span"); l.className = "code-lang"; l.textContent = lang; pre.append(l); }
  const code = document.createElement("code");
  const lines = String(text).split("\n");
  for (const line of lines.slice(0, MAX_CODE_LINES)) {
    const span = document.createElement("span"); span.className = `code-line ${diffLineClass(line, lang)}`.trim(); span.textContent = line || " "; code.append(span);
  }
  if (lines.length > MAX_CODE_LINES) {
    const span = document.createElement("span"); span.className = "code-line meta"; span.textContent = `[Browser preview truncated at ${MAX_CODE_LINES.toLocaleString()} lines]`; code.append(span);
  }
  pre.append(code); return pre;
}
function diffLineClass(line, lang = "") {
  if (lang === "diff" || looksLikeDiffLine(line)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git")) return "file";
    if (line.startsWith("@@")) return "meta";
    if (line.startsWith("+") && !line.startsWith("+++")) return "add";
    if (line.startsWith("-") && !line.startsWith("---")) return "del";
  }
  return "";
}
function looksLikeDiff(text) { return /^(diff --git|@@ |\+\+\+ |--- )/m.test(text) || String(text).split("\n").filter(looksLikeDiffLine).length >= 3; }
function looksLikeDiffLine(line) { return /^[+\-][^+\-]/.test(line) || /^@@/.test(line); }
function summarizeEvent(e) { if (e.type === "queue_update") return `steering ${e.steering?.length || 0}, follow-up ${e.followUp?.length || 0}`; if (e.error) return e.error; return JSON.stringify(e); }
function plain(content) { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((p)=>p?.type === "text" ? p.text : p?.type === "toolCall" ? `[tool: ${p.name}]` : p?.type === "image" ? "[image]" : "").filter(Boolean).join("\n"); }

async function send(mode = currentSendMode()) {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const message = $("prompt").value.trim(); if (!message) return;
  $("prompt").value = "";
  const bubble = addBubble("user", message, mode === "prompt" ? "You" : mode === "steer" ? "You · steer" : "You · follow-up");
  bubble.classList.add("pending-user");
  bubble.dataset.pendingUserText = message;
  const url = selectedWorker?.kind === "desktop" ? `/api/desktop/${selectedWorker.sessionId}/prompt` : `/api/workers/${activeWorker}/prompt`;
  try { await api(url, { method: "POST", body: JSON.stringify({ mode, message }) }); }
  catch (error) { addBubble("error", error.message, "send failed"); }
}
async function quickScreenshot() {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const extra = $("prompt").value.trim(); $("prompt").value = "";
  const message = extra ? `The user requested a screenshot. Use host_screenshot, then answer this: ${extra}` : "The user requested a screenshot. Use host_screenshot to inspect the current host desktop and briefly describe what matters.";
  const mode = currentSendMode();
  const bubble = addBubble("user", message, mode === "steer" ? "Screenshot request · steer" : "Screenshot request");
  bubble.classList.add("pending-user");
  bubble.dataset.pendingUserText = message;
  const url = selectedWorker?.kind === "desktop" ? `/api/desktop/${selectedWorker.sessionId}/prompt` : `/api/workers/${activeWorker}/prompt`;
  await api(url, { method: "POST", body: JSON.stringify({ mode, message }) });
}

async function handleUiRequest(e) {
  if (e.method === "notify") { addBubble(e.notifyType === "error" ? "error" : "remote", e.message || "", "notification"); return; }
  if (e.method === "setStatus") {
    const key = e.statusKey || e.id || "status";
    if (e.statusText) statusEntries.set(key, e.statusText);
    else statusEntries.delete(key);
    updateStatusLine();
    return;
  }
  if (e.method === "setTitle") { if (e.title) document.title = e.title; return; }
  if (e.method === "set_editor_text") { $("prompt").value = e.text || ""; return; }
  if (e.method === "setWidget") return;
  const dialog = $("dialog"), title = $("dialog-title"), body = $("dialog-body"), actions = $("dialog-actions");
  title.textContent = e.title || e.method; body.textContent = e.message || e.placeholder || ""; actions.textContent = "";
  const reply = (payload) => api(`/api/workers/${activeWorker}/ui`, { method: "POST", body: JSON.stringify({ id: e.id, ...payload }) }).catch((err)=>alert(err.message));
  if (e.method === "confirm") { button("Cancel", () => reply({ confirmed: false })); button("OK", () => reply({ confirmed: true })); }
  else if (e.method === "select") { for (const option of e.options || []) button(option, () => reply({ value: option })); button("Cancel", () => reply({ cancelled: true })); }
  else if (e.method === "input" || e.method === "editor") { const input = document.createElement(e.method === "editor" ? "textarea" : "input"); input.value = e.prefill || ""; input.placeholder = e.placeholder || ""; body.replaceChildren(input); button("Cancel", () => reply({ cancelled: true })); button("Send", () => reply({ value: input.value })); setTimeout(()=>input.focus(), 50); }
  else button("OK", () => reply({ cancelled: true }));
  function button(text, fn) { const b = document.createElement("button"); b.value = "default"; b.textContent = text; b.onclick = fn; actions.append(b); }
  dialog.showModal();
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function openSidebar() { document.body.classList.add("sidebar-open"); }
function closeSidebar() { document.body.classList.remove("sidebar-open"); }
function toggleSidebar() { document.body.classList.toggle("sidebar-open"); }

$("sidebar-toggle").onclick = toggleSidebar;
$("sidebar-backdrop").onclick = closeSidebar;
$("session-filter").oninput = renderSessions;
$("workspace").onchange = () => chooseWorkspace($("workspace").value, false);
$("browse").onclick = () => openFolderDialog(selectedWorkspace).catch((error) => alert(error.message));
$("folder-use").onclick = () => { chooseWorkspace(folderPath); $("folder-dialog").close(); };
$("folder-close").onclick = () => $("folder-dialog").close();
$("folder-create").onclick = createFolder;
$("folder-name").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); createFolder(); } });
$("new").onclick = async () => {
  if (!selectedWorkspace) return alert("Choose a workspace first.");
  const created = await api("/api/workers", { method: "POST", body: JSON.stringify({ cwd: selectedWorkspace, name: $("name").value }) });
  await refreshStatus();
  selectWorker(created.worker.id);
};
$("send").onclick = () => send(); $("follow").onclick = () => send("follow_up"); $("screenshot").onclick = quickScreenshot;
$("abort").onclick = () => activeWorker && api(selectedWorker?.kind === "desktop" ? `/api/desktop/${selectedWorker.sessionId}/abort` : `/api/workers/${activeWorker}/abort`, { method: "POST", body: "{}" });
$("state").onclick = () => {
  if (!activeWorker) return;
  if (selectedWorker?.kind === "desktop") return addBubble("remote", JSON.stringify(selectedWorker, null, 2), "state");
  return api(`/api/workers/${activeWorker}/state`).then((s)=>addBubble("remote", JSON.stringify(s.data || s, null, 2), "state"));
};
$("stop").onclick = async () => {
  if (!activeWorker) return;
  if (selectedWorker?.kind === "desktop") return alert("Desktop Pi sessions are controlled by their terminal. Use Abort to stop the current turn.");
  if (confirm("Stop this Pi worker?")) { await api(`/api/workers/${activeWorker}`, { method: "DELETE" }); activeWorker = ""; localStorage.removeItem("piBrowserWorker"); if (eventSource) eventSource.close(); await refreshStatus(); }
};
$("prompt").addEventListener("keydown", (e)=>{ if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

function currentSendMode() { return selectedWorker?.state?.isStreaming ? "steer" : "prompt"; }
function updateComposerState() {
  const sendButton = $("send");
  if (!sendButton) return;
  sendButton.textContent = currentSendMode() === "steer" ? "Steer" : "Send";
  sendButton.title = currentSendMode() === "steer" ? "Agent is running; send as steering" : "Agent is idle; send now";
}
function applyLiveState(event) {
  if (!selectedWorker) return;
  let changed = false;
  if (event.type === "agent_start") { selectedWorker.state = { ...(selectedWorker.state || {}), isStreaming: true }; changed = true; }
  if (event.type === "agent_end") { selectedWorker.state = { ...(selectedWorker.state || {}), isStreaming: false }; changed = true; }
  if (event.type === "queue_update") {
    selectedWorker.state = { ...(selectedWorker.state || {}), steering: event.steering || [], followUp: event.followUp || [], pendingMessageCount: (event.steering?.length || 0) + (event.followUp?.length || 0) };
    changed = true;
  }
  if (changed) {
    updateComposerState();
    renderWorkers();
  }
}

Promise.all([loadWorkspaces(), refreshStatus(), loadSessions({ force: true })]).then(()=>{ if (activeWorker) selectWorker(activeWorker).catch(()=>{}); });
setInterval(refreshStatus, 5_000);
sessionRefreshTimer = setInterval(() => loadSessions().catch(() => undefined), SESSION_REFRESH_MS);
window.addEventListener("focus", () => { refreshStatus(); loadSessions().catch(() => undefined); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshStatus(); loadSessions().catch(() => undefined); } });

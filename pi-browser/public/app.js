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
let folderPath = "";
let sessionPollTimer;

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
function shortPath(path) { return path?.replace(/^\/home\/jordan/, "~") || ""; }
function pathName(path) { const parts = String(path || "").split("/").filter(Boolean); return parts.at(-1) || path || "Workspace"; }
function label(role) { return role === "assistant" ? "Pi" : role === "user" ? "You" : role || "event"; }

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

async function refreshAll() {
  try {
    const status = await api("/api/status");
    workers = [
      ...(status.workers || []).map((worker) => ({ ...worker, kind: "rpc" })),
      ...(status.desktopSessions || []).map(normalizeDesktopSession),
    ];
    selectedWorker = workers.find((worker) => worker.id === activeWorker) || selectedWorker;
    $("status").textContent = `${workers.length} worker${workers.length === 1 ? "" : "s"} · ${status.sessionsDir}`;
    renderWorkers();
    updateComposerState();
    sessions = (await api("/api/sessions")).sessions || [];
    renderSessions();
  } catch (error) { $("status").textContent = error.message; }
}

function renderWorkers() {
  const root = $("workers"); root.textContent = "";
  for (const worker of workers.sort((a,b)=>b.createdAt-a.createdAt)) {
    const button = document.createElement("button");
    button.className = `item ${worker.id === activeWorker ? "active" : ""}`;
    const kind = worker.kind === "desktop" ? "desktop" : "browser";
    button.innerHTML = `<strong>${escapeHtml(worker.name || worker.state?.sessionName || worker.id)}</strong><span class="meta">${kind} · ${worker.state?.isStreaming ? "running" : worker.exited ? "exited" : worker.stale ? "stale" : "idle"} · ${escapeHtml(shortPath(worker.cwd))}</span>`;
    button.onclick = () => selectWorker(worker.id);
    root.append(button);
  }
}

function renderSessions() {
  const root = $("sessions"); root.textContent = "";
  const filter = $("session-filter").value.toLowerCase();
  for (const session of sessions.filter((s) => `${s.title} ${s.cwd} ${s.firstUser}`.toLowerCase().includes(filter)).slice(0, 80)) {
    const button = document.createElement("button");
    button.className = "item";
    button.innerHTML = `<strong>${escapeHtml(session.title || session.id || "session")}</strong><span class="meta">${escapeHtml(shortPath(session.cwd))} · ${fmtTime(session.modifiedAt)} · ${session.messageCount} msgs</span>`;
    button.onclick = () => openSession(session);
    root.append(button);
  }
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
  $("title").textContent = session.title || session.id || "Session";
  const data = await api(`/api/session?path=${encodeURIComponent(session.path)}`);
  renderMessages(data.messages || []);
  if (confirm("Start a browser-controlled Pi worker for this session?")) {
    const created = await api("/api/workers", { method: "POST", body: JSON.stringify({ sessionPath: session.path }) });
    await refreshAll();
    selectWorker(created.worker.id);
  }
}

async function selectWorker(id) {
  activeWorker = id; localStorage.piBrowserWorker = id;
  renderWorkers();
  if (eventSource) eventSource.close();
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  const worker = workers.find((w) => w.id === id);
  selectedWorker = worker;
  $("title").textContent = worker?.name || worker?.state?.sessionName || `Pi ${id}`;
  updateComposerState();
  $("messages").textContent = "";
  if (worker?.kind === "desktop") {
    await loadDesktopSession(worker);
    sessionPollTimer = setInterval(() => loadDesktopSession(worker).catch(() => undefined), 2_000);
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

async function loadDesktopSession(worker) {
  if (!worker.sessionPath) return addBubble("remote", "Desktop session has no session file yet.", "desktop");
  const data = await api(`/api/session?path=${encodeURIComponent(worker.sessionPath)}`);
  renderMessages(data.messages || []);
}

function renderMessages(messages) { const root = $("messages"); root.textContent = ""; for (const m of messages) appendMessage(m); root.scrollTop = root.scrollHeight; }
function renderEvents(events) { const root = $("messages"); root.textContent = ""; for (const e of events) appendEvent(e, false); root.scrollTop = root.scrollHeight; }
function appendMessage(m) {
  if (!m.text?.trim()) return;
  addBubble(m.role, m.text, label(m.role));
}
function appendEvent(e, scroll = true) {
  applyLiveState(e);
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") return appendDelta(e.assistantMessageEvent.delta || "");
  if (e.type === "message_end" && e.message) return appendMessage({ role: e.message.role, text: plain(e.message.content) });
  if (e.type === "tool_execution_start") return addBubble("tool", `${e.toolName}`, "tool start");
  if (e.type === "tool_execution_end") return addBubble(e.isError ? "error" : "tool", plain(e.result?.content), `${e.toolName} result`);
  if (e.type === "extension_ui_request") return handleUiRequest(e);
  if (e.type?.startsWith("browser_") || e.type === "queue_update" || e.type === "agent_start" || e.type === "agent_end") addBubble("remote", summarizeEvent(e), e.type);
  if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}
function appendDelta(text) {
  let bubble = document.querySelector(".msg.assistant.streaming");
  if (!bubble) bubble = addBubble("assistant streaming", "", "Pi");
  bubble.lastChild.textContent += text;
  $("messages").scrollTop = $("messages").scrollHeight;
}
function addBubble(cls, text, title) {
  const div = document.createElement("div"); div.className = `msg ${cls}`;
  const l = document.createElement("span"); l.className = "label"; l.textContent = title;
  const body = document.createTextNode(text || "");
  div.append(l, body); $("messages").append(div); return div;
}
function summarizeEvent(e) { if (e.type === "queue_update") return `steering ${e.steering?.length || 0}, follow-up ${e.followUp?.length || 0}`; if (e.error) return e.error; return JSON.stringify(e); }
function plain(content) { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((p)=>p?.type === "text" ? p.text : p?.type === "toolCall" ? `[tool: ${p.name}]` : p?.type === "image" ? "[image]" : "").filter(Boolean).join("\n"); }

async function send(mode = currentSendMode()) {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const message = $("prompt").value.trim(); if (!message) return;
  $("prompt").value = "";
  addBubble("user", message, mode === "prompt" ? "You" : mode === "steer" ? "You · steer" : "You · follow-up");
  const url = selectedWorker?.kind === "desktop" ? `/api/desktop/${selectedWorker.sessionId}/prompt` : `/api/workers/${activeWorker}/prompt`;
  try { await api(url, { method: "POST", body: JSON.stringify({ mode, message }) }); }
  catch (error) { addBubble("error", error.message, "send failed"); }
}
async function quickScreenshot() {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const extra = $("prompt").value.trim(); $("prompt").value = "";
  const message = extra ? `The user requested a screenshot. Use host_screenshot, then answer this: ${extra}` : "The user requested a screenshot. Use host_screenshot to inspect the current host desktop and briefly describe what matters.";
  const mode = currentSendMode();
  addBubble("user", message, mode === "steer" ? "Screenshot request · steer" : "Screenshot request");
  const url = selectedWorker?.kind === "desktop" ? `/api/desktop/${selectedWorker.sessionId}/prompt` : `/api/workers/${activeWorker}/prompt`;
  await api(url, { method: "POST", body: JSON.stringify({ mode, message }) });
}

async function handleUiRequest(e) {
  if (e.method === "notify") { addBubble("remote", e.message || "", "notification"); return; }
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
  await refreshAll();
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
  if (confirm("Stop this Pi worker?")) { await api(`/api/workers/${activeWorker}`, { method: "DELETE" }); activeWorker = ""; localStorage.removeItem("piBrowserWorker"); if (eventSource) eventSource.close(); await refreshAll(); }
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
  if (event.type === "agent_start") selectedWorker.state = { ...(selectedWorker.state || {}), isStreaming: true };
  if (event.type === "agent_end") selectedWorker.state = { ...(selectedWorker.state || {}), isStreaming: false };
  if (event.type === "queue_update") selectedWorker.state = { ...(selectedWorker.state || {}), steering: event.steering || [], followUp: event.followUp || [], pendingMessageCount: (event.steering?.length || 0) + (event.followUp?.length || 0) };
  updateComposerState();
  renderWorkers();
}

Promise.all([loadWorkspaces(), refreshAll()]).then(()=>{ if (activeWorker) selectWorker(activeWorker).catch(()=>{}); });
setInterval(refreshAll, 5_000);
window.addEventListener("focus", refreshAll);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

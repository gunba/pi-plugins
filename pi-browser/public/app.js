const $ = (id) => document.getElementById(id);
let token = localStorage.piBrowserToken || "";
let activeWorker = localStorage.piBrowserWorker || "";
let eventSource;
let sessions = [];
let workers = [];
let deferredInstall;

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
function label(role) { return role === "assistant" ? "Pi" : role === "user" ? "You" : role || "event"; }

async function refreshAll() {
  try {
    const status = await api("/api/status");
    workers = status.workers || [];
    $("status").textContent = `${workers.length} worker${workers.length === 1 ? "" : "s"} · ${status.sessionsDir}`;
    renderWorkers();
    sessions = (await api("/api/sessions")).sessions || [];
    renderSessions();
  } catch (error) { $("status").textContent = error.message; }
}

function renderWorkers() {
  const root = $("workers"); root.textContent = "";
  for (const worker of workers.sort((a,b)=>b.createdAt-a.createdAt)) {
    const button = document.createElement("button");
    button.className = `item ${worker.id === activeWorker ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(worker.name || worker.state?.sessionName || worker.id)}</strong><span class="meta">${worker.state?.isStreaming ? "running" : worker.exited ? "exited" : "idle"} · ${escapeHtml(shortPath(worker.cwd))}</span>`;
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
  const worker = workers.find((w) => w.id === id);
  $("title").textContent = worker?.name || worker?.state?.sessionName || `Pi ${id}`;
  $("messages").textContent = "";
  eventSource = new EventSource(`/api/workers/${id}/events?token=${encodeURIComponent(token)}`, { withCredentials: false });
  eventSource.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    $("title").textContent = data.worker?.name || data.worker?.state?.sessionName || `Pi ${id}`;
    renderEvents(data.events || []);
  });
  eventSource.onmessage = (event) => appendEvent(JSON.parse(event.data));
  eventSource.onerror = () => $("status").textContent = "event stream disconnected";
}

function renderMessages(messages) { const root = $("messages"); root.textContent = ""; for (const m of messages) appendMessage(m); root.scrollTop = root.scrollHeight; }
function renderEvents(events) { const root = $("messages"); root.textContent = ""; for (const e of events) appendEvent(e, false); root.scrollTop = root.scrollHeight; }
function appendMessage(m) {
  if (!m.text?.trim()) return;
  addBubble(m.role, m.text, label(m.role));
}
function appendEvent(e, scroll = true) {
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

async function send(mode) {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const message = $("prompt").value.trim(); if (!message) return;
  $("prompt").value = "";
  addBubble("user", message, mode === "prompt" ? "You" : mode);
  try { await api(`/api/workers/${activeWorker}/prompt`, { method: "POST", body: JSON.stringify({ mode, message }) }); }
  catch (error) { addBubble("error", error.message, "send failed"); }
}
async function quickScreenshot() {
  if (!activeWorker) return alert("Start or select a Pi worker first.");
  const extra = $("prompt").value.trim(); $("prompt").value = "";
  const message = extra ? `The user requested a screenshot. Use host_screenshot, then answer this: ${extra}` : "The user requested a screenshot. Use host_screenshot to inspect the current host desktop and briefly describe what matters.";
  addBubble("user", message, "Screenshot request");
  await api(`/api/workers/${activeWorker}/prompt`, { method: "POST", body: JSON.stringify({ mode: "prompt", message }) });
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

$("refresh").onclick = refreshAll; $("session-filter").oninput = renderSessions;
$("new").onclick = async () => { const created = await api("/api/workers", { method: "POST", body: JSON.stringify({ cwd: $("cwd").value, name: $("name").value }) }); await refreshAll(); selectWorker(created.worker.id); };
$("send").onclick = () => send("prompt"); $("steer").onclick = () => send("steer"); $("follow").onclick = () => send("follow_up"); $("screenshot").onclick = quickScreenshot;
$("abort").onclick = () => activeWorker && api(`/api/workers/${activeWorker}/abort`, { method: "POST", body: "{}" });
$("state").onclick = () => activeWorker && api(`/api/workers/${activeWorker}/state`).then((s)=>addBubble("remote", JSON.stringify(s.data || s, null, 2), "state"));
$("stop").onclick = async () => { if (activeWorker && confirm("Stop this Pi worker?")) { await api(`/api/workers/${activeWorker}`, { method: "DELETE" }); activeWorker = ""; localStorage.removeItem("piBrowserWorker"); if (eventSource) eventSource.close(); await refreshAll(); } };
$("prompt").addEventListener("keydown", (e)=>{ if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send("prompt"); } });
$("voice").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("Speech recognition is not available in this browser. Use the Android keyboard microphone instead.");
  const recognition = new SR(); recognition.lang = navigator.language || "en-US"; recognition.interimResults = true;
  recognition.onresult = (event) => { let text = ""; for (const result of event.results) text += result[0].transcript; $("prompt").value = text; };
  recognition.start();
};

refreshAll().then(()=>{ if (activeWorker) selectWorker(activeWorker).catch(()=>{}); });
setInterval(refreshAll, 10_000);

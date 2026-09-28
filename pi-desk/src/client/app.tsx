import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Markdown from "react-markdown";
import { FileLink } from "./file-view.tsx";
import { ReferenceContext } from "./reference-origin.tsx";
import { api, ApiError, subscribe, onUpgrade } from "./connection.ts";
import type { BrowserAccount } from "./account.ts";
import { RELEASE } from "../shared/release.ts";
import { ResumeConversation } from "./resume.tsx";
import { Computers } from "./computers.tsx";
import { OsIcon } from "./os-icon.tsx";
import { FolderField } from "./folder-picker.tsx";
import { connectionLabel, connectionTone } from "./connection-state.ts";
import { Inspector, Modal, Navigation } from "./surfaces.tsx";
import { useConfirmation } from "./confirmation.tsx";
import { ControlActivity, ControlHistory, EditorSuggestion } from "./control-status.tsx";
import { isControl } from "../shared/controls.ts";
import { openView, panelViews } from "./work-views.ts";
import type { WorkspaceState as HostState } from "./workspace.ts";
import { AssetImage, AssetLink } from "./assets.tsx";
import { AttachmentList, useAttachments } from "./attachments.tsx";
import { ArtifactLink, DiffCard } from "./artifact-view.tsx";
import { CodeBlock, Elapsed, LiveOutput } from "./transcript-parts.tsx";
import { Devices } from "./devices.tsx";
import { DraftRecovery } from "./draft-recovery.tsx";
import { SessionControls } from "./session-controls.tsx";
import { ConversationFooter } from "./conversation-footer.tsx";
import { NativeQueue } from "./native-queue.tsx";
import { AgentPane } from "./agent-pane.tsx";
import { ViewPreviews } from "./view-previews.tsx";
import { CloseSummary } from "./close-summary.tsx";
import { composerKey, type Delivery } from "./composer-keys.ts";
import { PendingInputs } from "./pending-inputs.tsx";
import type { InputStatus, PromptCommand } from "../shared/inputs.ts";
import { DetailsView } from "./details-view.tsx";
import { ExternalLinks } from "./external-links.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { LedgerCard } from "./ledger-card.tsx";
import type { Ledger } from "../../../pi-context-ledger/model.ts";
import type { UiConversation, UiDetails } from "../../../pi-ui/index.ts";
import { cacheTranscript, trimCaches, reconcileHistory, reduceEvents, transcriptKey, type ClientState } from "./state.ts";
import type {
  ChatMessage,
  HistoryPage,
  InteractionSnapshot,
  SessionView,
  WorkerCommand,
} from "../shared/protocol.ts";
import type { UiAnswer } from "../../../pi-ui/index.ts";

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const title = (session: SessionView) =>
  session.snapshot?.name ?? session.name ?? "New conversation";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const draftKey = (key: string) => `pi-desk:draft:${key}`;
const emptyMessages: NonNullable<ClientState["messages"][string]> = [];
export function App({ account }: { account?: BrowserAccount }) {
  const [state, setState] = useState<ClientState>({ messages: {} });
  const [authorized, setAuthorized] = useState<boolean | undefined>();
  const [upgrade, setUpgrade] = useState<string>();
  useEffect(() => onUpgrade(setUpgrade), []);
  const [selected, setSelected] = useState(
    localStorage.getItem("pi-desk:selected") ?? "",
  );
  const [transportConnected, setConnected] = useState(false);
  const [localEpoch, setEpoch] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState<
    "work" | "settings" | "view" | "agents" | undefined
  >();
  const [create, setCreate] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createRequest = useRef(0);
  const [focusedView, setFocusedView] = useState("");
  const [focusedAgent, setFocusedAgent] = useState("");
  const autoAgents = useRef("");
  const [cwd, setCwd] = useState("");
  const [newComputer, setNewComputer] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState("");
  const attachments = useAttachments(selected, setError);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [latestRequest, setLatestRequest] = useState(0);
  const [dismissedQuestion, setDismissedQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const questionDrafts = useRef(new Map<string, QuestionDraft>());
  const [dismissedNotices, setDismissedNotices] = useState<string[]>([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const session = state.host?.sessions.find(
    (session) => session.key === selected,
  );
  const previousSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!session && previousSession.current === selected) {
      setSelected(""); setPanel(undefined);
    }
    previousSession.current = session?.key;
  }, [session?.key, selected]);
  const canCompose = session?.state === "starting" || session?.state === "ready";
  const currentComputer = state.host?.computers?.find(computer => computer.id === session?.computer);
  const connected = state.host?.computers
    ? currentComputer?.connected ?? state.host.computers.some(computer => computer.connected)
    : transportConnected;
  const epoch = currentComputer?.epoch ?? localEpoch;
  const ui = session?.ui;
  const controls = session?.controls ?? [];
  const controlBusy = controls.some(control => control.state === "running");
  const closing = controls.some(control => control.kind === "close" && control.state === "running");
  const confirmation = useConfirmation(`${authorized}:${selected}:${session?.activation}:${ui?.generation}:${connected}`);
  const confirmationContext = session ? `${currentComputer?.name ?? "This computer"} · ${title(session)}` : "";
  const visibleViews = panelViews(ui?.views ?? [], panel, focusedView);
  const agentViews = (ui?.views ?? []).filter(view => view.kind === "conversation");
  const activeAgents = agentViews.filter(view => (view.data as UiConversation).active).length;
  const chooseAgent = (id: string) => { setFocusedAgent(id); localStorage.setItem(`pi-desk:agent-selection:${selected}`, id); };
  useEffect(() => { setFocusedAgent(localStorage.getItem(`pi-desk:agent-selection:${selected}`) ?? ""); }, [selected]);
  useEffect(() => {
    if (panel === "view" && agentViews.some(view => view.id === focusedView)) { chooseAgent(focusedView); setPanel("agents"); }
    const activation = `${selected}:${session?.activation}`;
    if (activeAgents && autoAgents.current !== activation) {
      autoAgents.current = activation;
      if (!panel && !document.activeElement?.matches("input,textarea,[contenteditable=true]")
        && matchMedia("(min-width:1181px)").matches) setPanel("agents");
    }
  }, [panel, focusedView, activeAgents, selected, session?.activation, ui]);
  const questions = ui?.interactions ?? [];
  const question = questions.find(question => question.id === activeQuestion) ?? questions[0];
  useEffect(() => {
    if (!questions.some(question => question.id === activeQuestion)) setActiveQuestion(questions[0]?.id ?? "");
  }, [questions, activeQuestion]);
  useEffect(() => {
    const pending = new Set(state.host?.sessions.flatMap(session =>
      session.ui?.interactions.map(question => `${session.key}/${question.id}`) ?? []));
    for (const id of questionDrafts.current.keys()) if (!pending.has(id)) questionDrafts.current.delete(id);
  }, [state.host?.sessions]);
  const messages = state.messages[selected] ?? emptyMessages;
  const storeHistory = useCallback((source: string | undefined, page: HistoryPage) => {
    setState(previous => {
      if (previous.host?.sessions.find(session => session.key === selected)?.ui?.generation !== page.generation) return previous;
      const messages = { ...previous.messages }, key = transcriptKey(selected, source);
      cacheTranscript(messages, key, reconcileHistory(messages[key] ?? [], page));
      const focused = source ? [selected, key] : previous.focused ?? [selected];
      trimCaches(messages, focused);
      return { ...previous, messages, focused };
    });
  }, [selected]);
  useEffect(() => {
    if ((panel !== "work" && panel !== "view") || !focusedView) return;
    const card = [...document.querySelectorAll<HTMLElement>("[data-view]")].find(element => element.dataset.view === focusedView);
    card?.scrollIntoView({ block: "start" });
  }, [panel, focusedView, selected]);
  const busy =
    controlBusy ||
    session?.snapshot?.activity === "running" ||
    session?.snapshot?.activity === "waiting" ||
    !!session?.inputs?.some(input => input.state === "sending") ||
    !!question;
  const notice = ui?.notifications
    .filter(
      (item) => !dismissedNotices.includes(item.id) && item.level !== "info",
    )
    .at(-1);

  const refresh = async () => {
    try {
      const host = await api<HostState>("/state");
      setState((previous) => reduceEvents(previous, [{ type: "state", state: host }]));
      setAuthorized(true);
      setError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthorized(false);
      else setError(errorText(error));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!authorized || upgrade) return;
    return subscribe(
      (batch) => {
        setState((previous) => reduceEvents(previous, batch));
        for (const event of batch) {
          if (event.type === "worker" && event.key === selectedRef.current && event.message.type === "open_view") {
            const destination = openView(event.message.view, event.message.section);
            setPanel(destination.panel); setFocusedView(destination.focused ?? "");
          }
        }
      },
      (online) => {
        setConnected(online);
        if (online) setEpoch((value) => value + 1);
        else
          void api("/state").catch((error) => {
            if (error instanceof ApiError && error.status === 401)
              setAuthorized(false);
          });
      },
    );
  }, [authorized, upgrade]);
  useEffect(() => {
    setDraft(localStorage.getItem(draftKey(selected)) ?? "");
    setState(previous => ({ ...previous, focused: [selected] }));
    localStorage.setItem("pi-desk:selected", selected);
  }, [selected]);

  async function command(command: WorkerCommand, id: string = crypto.randomUUID()) {
    if (!session?.ui) throw new Error("Session is still starting.");
    return api(`/sessions/${selected}/command`, {
      id,
      generation: session.ui.generation,
      command,
    });
  }
  const run = (command: WorkerCommand) => {
    void commandPromise(command);
  };
  async function commandPromise(value: WorkerCommand) {
    try {
      await command(value);
    } catch (error) {
      setError(`${errorText(error)}${isControl(value) ? " Check Recent operations in Settings before trying again." : ""}`);
    }
  }
  async function newSession(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    const request = ++createRequest.current;
    setCreating(true); setCreateError("");
    try {
      const result = await api<{ key: string }>("/sessions", { cwd }, newComputer);
      if (request !== createRequest.current) return;
      setSelected(result.key);
      setCreate(false);
      setSidebar(false);
      setPanel(undefined);
    } catch (error) {
      if (request === createRequest.current) setCreateError(errorText(error));
    } finally { if (request === createRequest.current) setCreating(false); }
  }
  async function restartSession() {
    if (!session || !connected) return;
    try {
      await api(`/sessions/${session.key}/restart`, {});
    } catch (error) { setError(errorText(error)); }
  }
  function openNewConversation() {
    const computer = currentComputer?.connected ? currentComputer : state.host?.computers?.find(computer => computer.connected);
    createRequest.current++; setCreateError(""); setCreating(false);
    setNewComputer(computer?.id);
    setCwd(session && session.computer === computer?.id ? session.cwd : computer?.cwd ?? state.host?.cwd ?? "");
    setCreate(true);
  }
  function closeNewConversation() { createRequest.current++; setCreate(false); setCreating(false); }
  async function closeSession() {
    if (!session?.activation || !await confirmation.request({
      title: "Close conversation?", context: confirmationContext, accept: "Close conversation",
      body: <CloseSummary session={session} />,
    })) return;
    setPanel(undefined);
    try { await api(`/sessions/${session.key}/close`, { id: crypto.randomUUID(), activation: session.activation }); }
    catch (error) { setError(errorText(error)); }
  }
  async function send(delivery: Delivery = "steer") {
    if ((!draft.trim() && !attachments.files.length) || !attachments.ready || sendingRef.current || controlBusy || !connected
      || !session?.activation || !["starting", "ready"].includes(session.state)) return;
    const text = draft;
    const fileIds = attachments.files.map(file => file.id);
    sendingRef.current = true; setSending(true);
    try {
      const receiptKey = `pi-desk:submission:${selected}`;
      const previous = JSON.parse(localStorage.getItem(receiptKey) ?? "null") as {
        id: string; activation: string; generation?: string; fingerprint: string; behavior?: "steer" | "followUp"; requiresConfirmation?: boolean;
      } | null;
      const uploaded = await attachments.upload(session.key, value => api(`/sessions/${selected}/uploads`, {
        activation: session.activation, command: value,
      }));
      const prompt: PromptCommand = {
        kind: "prompt", text, ...(uploaded.length ? { attachments: uploaded } : {}),
      };
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(prompt)))),
        byte => byte.toString(16).padStart(2, "0")).join("");
      const reusable = previous?.activation === session.activation && !previous.requiresConfirmation && previous.fingerprint === fingerprint;
      if (previous && !reusable
        && !await confirmation.request({
          title: "Send this message again?", context: confirmationContext, accept: "Send again", cancel: "Keep draft",
          body: <>
            <p>The earlier delivery was not confirmed. Check its history first.
              Sending now could duplicate a message that already arrived.</p>
            {text && <pre className="confirmation-preview">{text.slice(0, 2000)}{text.length > 2000 ? "…" : ""}</pre>}
            {!!fileIds.length && <p>{fileIds.length} attachment{fileIds.length === 1 ? "" : "s"}</p>}
          </>,
        })) return;
      const receipt = reusable ? previous! : {
        id: crypto.randomUUID(), activation: session.activation,
        generation: session.state === "starting" ? undefined : session.ui?.generation,
        fingerprint, behavior: session.state === "starting" ? "followUp" as const : delivery,
      };
      localStorage.setItem(receiptKey, JSON.stringify(receipt));
      try {
        const result = await api<{ input: InputStatus }>(`/sessions/${selected}/inputs`, {
          id: receipt.id, activation: receipt.activation, generation: receipt.generation,
          command: { ...prompt, behavior: receipt.behavior },
        });
        if (!["queued", "sending", "accepted"].includes(result.input.state)) {
          localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
          throw new Error(result.input.error ?? "This message was cancelled. It was not sent again.");
        }
      }
      catch (error) {
        if (JSON.parse(localStorage.getItem(receiptKey) ?? "null")?.id === receipt.id) {
          if (error instanceof ApiError && error.status === 409) localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
        }
        throw error;
      }
      if (JSON.parse(localStorage.getItem(receiptKey) ?? "null")?.id === receipt.id) localStorage.removeItem(receiptKey);
      if (localStorage.getItem(draftKey(selected)) === text) localStorage.removeItem(draftKey(selected));
      if (selectedRef.current === selected) { setDraft(""); setLatestRequest(value => value + 1); }
      try { await attachments.clear(fileIds); }
      catch { setError("Message queued on the computer, but this device could not clear its attachment draft. Remove those files before sending another message."); }
    } catch (error) {
      setError(`${errorText(error)} Your draft has been kept.`);
    } finally {
      sendingRef.current = false; setSending(false);
    }
  }

  if (upgrade) return <main className="pair-page">
    <div className="brand-mark">π</div><h1>Update Pi Desk</h1><p role="alert">{upgrade}</p>
    <button onClick={() => location.reload()}>Reload app</button>
  </main>;
  if (authorized === false)
    return (
      <main className="pair-page">
        <div className="brand-mark">π</div>
        <h1>Access unavailable</h1>
        <p>{account ? "Sign in again to open your account workspace." : "Run pi-desk open --local on this computer to authorize local recovery."}</p>
        <button onClick={() => location.reload()}>Reload app</button>
        <p className="error-text" role="alert">
          {error}
        </p>
      </main>
    );
  if (!state.host)
    return (
      <main className="pair-page">
        <div className="brand-mark">π</div>
        <p>{error || "Connecting to your workspace…"}</p>
      </main>
    );

  const host = state.host;
  return (
    <div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <Navigation open={sidebar} close={() => setSidebar(false)}>
        <div className="brand">
          <span className="brand-mark small">π</span>
          <strong>Pi Desk</strong>
        </div>
        <button className="new-chat" onClick={openNewConversation}>
          <span>＋</span> New conversation
        </button>
        <button className="resume-chat" onClick={() => { setResumeOpen(true); setSidebar(false); }}>
          <span>◷</span> Resume conversation
        </button>
        <div className="nav-label">
          Sessions <span>{state.host.sessions.length}</span>
        </div>
        <nav className="session-list">
          {(state.host.computers ?? [{ id: undefined, name: state.host.name, platform: state.host.platform, connected,
            connection: connected ? "connected" as const : "reconnecting" as const }]).map(computer => <section key={computer.id ?? "local"} aria-label={computer.name}>
          <div className="computer-heading">
            <span className="computer-name" title={computer.name}><OsIcon platform={computer.platform} /><strong>{computer.name}</strong></span>
            <small title={connectionLabel(computer)}><span className={`status-dot ${connectionTone(computer)}`} />{connectionLabel(computer)}</small>
          </div>
          {computer.connection === "upgrade" && <div className="sidebar-hint upgrade-hint"><p>Update this computer and the app. Native conversations are retained.</p>
            <button onClick={() => location.reload()}>Reload app</button></div>}
          {host.sessions.filter(item => item.computer === computer.id)
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.created - a.created)
            .map((item) => (
              <button
                key={item.key}
                className={`session-item ${selected === item.key ? "selected" : ""}`}
                onClick={() => {
                  setSelected(item.key);
                  setSidebar(false);
                  setPanel(undefined);
                }}
              >
                <span
                  className={`status-dot ${item.interrupted ? "interrupted" : item.snapshot?.activity ?? item.state}`}
                />
                <span>
                  <strong>{item.pinned ? "★ " : ""}{title(item)}</strong>
                  <small>{item.interrupted || item.state === "failed" ? "Interrupted · " : ""}{basename(item.cwd)}</small>
                </span>
              </button>
            ))}
          {computer.connection !== "upgrade" && !host.sessions.some(item => item.computer === computer.id) &&
            <p className="sidebar-hint">{computer.connected ? "No open sessions." : "Connect to see open sessions."}</p>}
          </section>)}
        </nav>
        <div className="sidebar-bottom">
          <button
            onClick={() => {
              setPanel("settings");
              setSidebar(false);
            }}
          >
            ⚙ <span>Settings & tools</span>
          </button>
          <div className="host-label" title="Connections from this browser">
            <span
              className={`status-dot ${connectionTone({ connection: transportConnected ? "connected" : host.computers?.[0]?.connection ?? "connecting" })}`}
            />
            <span>{state.host.name}</span>
            <small>{host.computers ? `${host.computers.filter(computer => computer.connected).length}/${host.computers.length} connected` : connected ? "Connected" : "Reconnecting"}</small>
          </div>
        </div>
      </Navigation>
      <main className="main" data-primary-focus tabIndex={-1}>
        <header className="topbar">
          <button
            className="icon-button mobile-nav"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            ☰
          </button>
          <div className="conversation-heading">
            <span>{session ? `${currentComputer ? `${currentComputer.name} · ` : ""}${basename(session.cwd)}` : "Your workspace"}</span>
            <strong>{session ? title(session) : "Welcome"}</strong>
          </div>
          <div className="top-actions">
            {session?.activation && <button
              className="close-conversation" title="Close this session and remove it from the workspace" aria-label="Close conversation"
              disabled={!connected || closing || sending} onClick={() => void closeSession()}>{closing ? "Closing…" : "Close"}</button>}
            {session?.snapshot && (
              <button
                className={`work-button ${question ? "attention" : ""}`}
                onClick={() => setPanel(panel === "work" ? undefined : "work")}
              >
                <span className={`status-dot ${session.snapshot.activity}`} />
                {question ? "Needs your input" : busy ? "Working" : "Work"}
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Conversation settings"
              onClick={() =>
                setPanel(panel === "settings" ? undefined : "settings")
              }
            >
              •••
            </button>
          </div>
        </header>
        {!connected && (
          <div className="connection-banner">
            {host.computers?.length === 0 ? "No computers yet. Add one in Settings."
              : currentComputer ? `${currentComputer.name}: ${connectionLabel(currentComputer)}. ${currentComputer.error ?? ""}`
              : !host.computers ? "Reconnecting to this computer…"
              : host.computers.every(computer => computer.connection === "paused") ? "This app is paused. Pi sessions stay on their computers."
              : host.computers.every(computer => computer.connection === "network-offline") ? "This device is offline."
              : "Connecting to your computers…"}
          </div>
        )}
        <ViewPreviews views={(ui?.views ?? []).filter(view => !view.scope)} open={id => { setFocusedView(id); setPanel("view"); }} />
        {!!agentViews.length && <button type="button" className={`agent-activity-bar${panel === "agents" ? " selected" : ""}`}
          aria-expanded={panel === "agents"} onClick={() => setPanel(panel === "agents" ? undefined : "agents")}>
          <strong>Agents</strong><span>{activeAgents} active · {agentViews.length} total</span><span>View →</span>
        </button>}
        {session && <ControlActivity key={`${selected}:controls`} session={selected} controls={controls} />}
        {session && <PendingInputs key={`${selected}:inputs`} session={session} connected={connected} report={setError} />}
        {session && !canCompose && messages.length > 0 && (
          <div className="connection-banner">
            <span>{session.error || "Pi was interrupted. Resume to continue."}</span>
            <button disabled={!connected} onClick={() => void restartSession()}>{session.file ? "Resume" : "Retry"}</button>
          </div>
        )}
        {session?.snapshot?.extensions.some(extension => extension.error) && <div className="error-banner" role="alert">
          Some Pi extensions failed to load. Prompts are paused until they are fixed.
          <button onClick={() => setPanel("settings")}>View errors</button>
        </div>}
        {host.directoryError && <div className="connection-banner" role="status">{host.directoryError}</div>}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="error-banner" role="status">
            <span>{notice.text}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() =>
                setDismissedNotices((previous) => [...previous, notice.id])
              }
            >
              ×
            </button>
          </div>
        )}
        <TranscriptView key={`${selected}/${session?.ui?.generation ?? ""}`}
          session={selected} generation={session?.ui?.generation ?? ""}
          connected={connected && session?.state === "ready"} epoch={epoch}
          messages={messages} onLatest={storeHistory} latestRequest={latestRequest}
          renderMessage={message => <Message message={message} sessionKey={selected} />}
          empty={
              <div className="welcome">
                <div className="welcome-mark">π</div>
                <div className="eyebrow">
                  {session
                    ? basename(session.cwd)
                    : "A LITTLE SPACE TO THINK BIG"}
                </div>
                <h1>
                  {session && !canCompose ? "Pi is not running"
                    : session?.state === "starting" ? controlBusy ? "Updating this conversation…" : "Opening this conversation…"
                    : session ? "What shall we work on?" : "Make something good."}
                </h1>
                <p>
                  {session && !canCompose ? session.error || "Resume Pi to load this conversation. Nothing has been resent." : session
                    ? "Your tools, context, and conversations. All in one place."
                    : "Start a conversation in any project. Pick it up on any device."}
                </p>
                {!session && (
                  <button className="primary" onClick={openNewConversation}>
                    Start a conversation <span>↗</span>
                  </button>
                )}
                {session && !canCompose && <>
                  <button className="primary" disabled={!connected} onClick={() => void restartSession()}>
                    {session.file ? "Resume" : "Retry"}
                  </button>
                  {!!draft.trim() && <p className="muted">Your unsent draft is kept on this device.</p>}
                </>}
                {session?.state === "starting" && !controlBusy && (
                  <p className="muted">Loading your Pi setup. You can send now; messages will wait on this computer.</p>
                )}
              </div>
          }
          footer={busy && (
              <div className="activity-line">
                <span className="pulse-dot" />
                {question ? "Waiting for your answer" : "Pi is working…"}
              </div>
          )}
        />
        {session && canCompose && (
          <div className="composer-dock">
            {ui && <EditorSuggestion key={selected} session={selected} id={ui.editorId} text={ui.editorText}
              draft={draft} context={confirmationContext} edit={text => { setDraft(text); localStorage.setItem(draftKey(selected), text); }} />}
            {question && (
              <button
                className="question-banner"
                onClick={() => setDismissedQuestion("")}
              >
                <span>✦</span>
                <strong>{question.scope ? `${question.scope.label}: ` : ""}{question.form.title}</strong>
                <span>{questions.length > 1 ? `${questions.length} questions →` : "Answer →"}</span>
              </button>
            )}
            {session.snapshot && <NativeQueue queue={session.snapshot.queue} />}
            <form className={`composer${draggingFiles ? " file-drop" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}
              onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDraggingFiles(true); } }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
              onDrop={event => {
                event.preventDefault(); setDraggingFiles(false);
                if (!sending && attachments.ready) attachments.add(event.dataTransfer.files);
              }}>
              <AttachmentList files={attachments.files} disabled={sending} remove={attachments.remove} />
              <input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" disabled={sending || !attachments.ready}
                onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
              <textarea
                aria-label="Message Pi"
                disabled={sending}
                placeholder={
                  busy
                    ? "Steer Pi, or queue a follow-up…"
                    : "Ask Pi anything about your project…"
                }
                value={draft}
                rows={3}
                onPaste={event => {
                  if (event.clipboardData.files.length) { event.preventDefault(); attachments.add(event.clipboardData.files); }
                }}
                onChange={(event) => {
                  setDraft(event.target.value);
                  localStorage.setItem(draftKey(selected), event.target.value);
                }}
                onKeyDown={(event) => {
                  const action = composerKey({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing },
                    matchMedia("(pointer:fine)").matches);
                  if (!action) return;
                  event.preventDefault();
                  if (action === "newline") {
                    const editor = event.currentTarget, start = editor.selectionStart;
                    const text = `${draft.slice(0, start)}\n${draft.slice(editor.selectionEnd)}`;
                    setDraft(text); localStorage.setItem(draftKey(selected), text);
                    requestAnimationFrame(() => editor.setSelectionRange(start + 1, start + 1));
                  } else {
                    void send(action);
                  }
                }}
              />
              <div className="composer-controls">
                <div className="model-controls">
                  {session.snapshot && <>
                  <select
                    aria-label="Model"
                    disabled={busy || !connected || session.state !== "ready"}
                    value={
                      session.snapshot?.model
                        ? `${session.snapshot.model.provider}:${session.snapshot.model.id}`
                        : ""
                    }
                    onChange={(event) => {
                      const model = session.snapshot?.models.find(
                        (model) =>
                          `${model.provider}:${model.id}` ===
                          event.target.value,
                      );
                      if (model)
                        run({
                          kind: "model",
                          provider: model.provider,
                          id: model.id,
                        });
                    }}
                  >
                    {session.snapshot?.models.map((model) => (
                      <option
                        key={`${model.provider}:${model.id}`}
                        value={`${model.provider}:${model.id}`}
                      >
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Reasoning level"
                    value={session.snapshot?.thinking ?? ""}
                    disabled={busy || !connected || session.state !== "ready"}
                    onChange={(event) =>
                      run({ kind: "thinking", level: event.target.value })
                    }
                  >
                    {session.snapshot?.thinkingLevels.map((level) => (
                      <option key={level} value={level}>
                        {level === "off"
                          ? "No reasoning"
                          : `${level} reasoning`}
                      </option>
                    ))}
                  </select>
                  </>}
                </div>
                <div className="send-controls">
                  <button type="button" className="icon-button" aria-label="Attach files" title="Attach files (up to 8 MiB each)"
                    disabled={sending || !attachments.ready} onClick={() => fileInput.current?.click()}>＋</button>
                  {busy && !controlBusy && (
                    <button type="button" className="queue-button" aria-label="Queue follow-up"
                      title="After current work · Alt+Enter or Ctrl+Q"
                      disabled={sending || !connected || !attachments.ready || !session.activation || !["starting", "ready"].includes(session.state)
                        || (!draft.trim() && !attachments.files.length)}
                      onClick={() => void send("followUp")}>Queue</button>
                  )}
                  {busy && controls.every(control => control.state !== "running" || ["compact", "navigate"].includes(control.kind)) && (
                    <button
                      className="stop-button"
                      type="button"
                      aria-label="Stop Pi"
                      disabled={!connected}
                      onClick={() => run({ kind: "abort" })}
                    >
                      ■
                    </button>
                  )}
                  <button
                    type="button"
                    className={`send-button${busy && !controlBusy ? " steer-button" : ""}`}
                    aria-label={busy && !controlBusy ? "Steer Pi" : "Send message"}
                    title="Enter sends or steers · Shift/Alt-click queues a follow-up"
                    onClick={event => void send(event.altKey || event.shiftKey ? "followUp" : "steer")}
                    disabled={
                      (!draft.trim() && !attachments.files.length) ||
                      !attachments.ready ||
                      sending ||
                      controlBusy ||
                      !connected ||
                       !session.activation || !["starting", "ready"].includes(session.state)
                    }
                  >
                    {busy && !controlBusy ? "Steer" : "↑"}
                  </button>
                </div>
              </div>
              {attachments.progress && <p className="upload-progress" role="status">Uploading {attachments.progress}</p>}
              {!!attachments.files.length && session.snapshot?.model && !session.snapshot.model.images && (
                <p className="upload-progress">This model receives attachments as file paths. Image input is not supported by this model.</p>
              )}
            </form>
            <div className="composer-help">Enter to send or steer · Alt+Enter / Ctrl+Q to queue · Shift+Enter / Ctrl+J for a new line</div>
            <ConversationFooter session={session} computer={currentComputer?.name ?? state.host.name} connected={connected}
              open={view => { setPanel("view"); setFocusedView(view.id); }} />
          </div>
        )}
      </main>
      {panel && (
        <Inspector className={panel === "agents" ? "agents-panel" : ""} title={panel === "agents" ? "Agents" : panel === "work" ? "Work" : panel === "view" ? visibleViews[0]?.title ?? "Details"
          : "Settings & tools"} close={() => setPanel(undefined)}
          back={panel === "view" ? () => setPanel(visibleViews[0]?.surface === "settings" ? "settings" : "work") : undefined}>
          <div className="panel-title">
            {panel === "view" && <button className="icon-button"
              aria-label={visibleViews[0]?.surface === "settings" ? "Back to settings" : "Back to Work"}
              onClick={() => setPanel(visibleViews[0]?.surface === "settings" ? "settings" : "work")}>‹</button>}
            <h2 data-surface-heading tabIndex={-1}>
              {panel === "agents" ? "Agents" : panel === "work"
                ? "Work"
                : panel === "view"
                  ? visibleViews[0]?.title ?? "Details"
                : "Settings & tools"}
            </h2>
            <button
              className="icon-button"
              aria-label="Close panel"
              onClick={() => setPanel(undefined)}
            >
              ×
            </button>
          </div>
          {panel === "agents" && session && <AgentPane key={`${selected}:agents`} session={session} views={agentViews}
            context={`${currentComputer?.name ?? host.name} · ${title(session)}`}
            focused={focusedAgent} choose={chooseAgent} connected={connected && !closing} epoch={epoch} messages={state.messages}
            onLatest={storeHistory} renderMessage={(message, source) => <Message message={message} sessionKey={selected} source={source} />}
            answer={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
            openView={id => { setFocusedView(id); setPanel("view"); }} />}
          {(panel === "work" || panel === "view") &&
            (visibleViews.length ? (
              visibleViews.map((view) => (
                <section className="panel-card" key={view.id} data-view={view.id}>
                  {panel !== "view" && <h3>{view.title}</h3>}
                  {view.working && <p className="muted" role="status">{view.working}…</p>}
                  {view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
                  <div className="panel-actions">
                    {view.actions?.map(action => <button key={action.id} disabled={!!view.working}
                      onClick={() => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })}>
                      {action.label}
                    </button>)}
                  </div>
                  {view.kind === "details" ? <>
                    <DetailsView data={view.data as UiDetails} disabled={!!view.working} invoke={action => run({
                      kind: "action", view: view.id, revision: view.revision, action: action.id,
                    })} />
                    {(view.data as UiDetails).transcript && <TranscriptView key={(view.data as UiDetails).transcript}
                      source={(view.data as UiDetails).transcript!} session={selected} generation={ui!.generation}
                      connected={connected} epoch={epoch}
                      messages={state.messages[transcriptKey(selected, (view.data as UiDetails).transcript!)] ?? emptyMessages}
                      onLatest={storeHistory} renderMessage={message => <Message message={message} sessionKey={selected} source={(view.data as UiDetails).transcript} />} />}
                  </> : view.kind === "ledger" ? <div>
                    <p className="muted">Automatic card {(view.data as { autoEnabled: boolean }).autoEnabled ? "enabled" : "disabled"} for new conversations.</p>
                    {(view.data as { ledger?: Ledger }).ledger
                      ? <LedgerCard ledger={(view.data as { ledger: Ledger }).ledger} expanded />
                      : <p>No saved breakdown. Recompute one, or start a conversation.</p>}
                  </div> : (
                    <pre>
                      {typeof view.data === "string"
                        ? view.data
                        : JSON.stringify(view.data, null, 2)}
                    </pre>
                  )}
                </section>
              ))
            ) : (
              <p className="muted">
                {panel === "view" ? "This view is unavailable. Reopen it from this session's controls."
                  : "Goals, tasks, agents and scheduled work will appear here."}
              </p>
            ))}
          {panel === "settings" && (
            <>
              {account ? <Computers computers={state.host.computers ?? []} account={account} /> : <Devices />}
              <DraftRecovery available={host.sessions.map(item => item.key)} target={session?.key}
                busy={sending || controlBusy} restored={(target, text) => {
                  if (selectedRef.current === target) setDraft(text);
                }} />
              {!!ui?.views.some(view => view.surface === "settings") && <section className="panel-card"><h3>Pi settings</h3><div className="panel-actions">
              {ui.views.filter(view => view.surface === "settings").map(view => <button key={view.id} onClick={() => {
                setPanel("view"); setFocusedView(view.id);
              }}>{view.title}</button>)}
              </div></section>}
              {session && <section className="panel-card">
                <button onClick={() => { void api(`/sessions/${session.key}/metadata`, { generation: session.ui?.generation, pinned: !session.pinned }).catch(error => setError(errorText(error))); }}>
                  {session.pinned ? "Unpin conversation" : "Pin conversation"}
                </button>
              </section>}
              {session?.state === "ready" && session.ui && <SessionControls key={selected} generation={session.ui.generation}
                busy={busy || !connected} invoke={command} />}
              <ControlHistory controls={controls} />
              <section className="panel-card">
                <h3>Pi Desk</h3><p>App {RELEASE.version} · API {RELEASE.api}</p>
                {(currentComputer?.release ?? (!host.computers ? host.release : undefined)) && <p className="muted">
                  Host {(currentComputer?.release ?? host.release).version} · Pi {(currentComputer?.release ?? host.release).engine}
                </p>}
                <button onClick={() => location.reload()}>Reload app</button>
              </section>
              <section className="panel-card">
                <h3>Appearance</h3>
                <button
                  onClick={() => {
                    const dark =
                      document.documentElement.dataset.theme !== "dark";
                    document.documentElement.dataset.theme = dark
                      ? "dark"
                      : "light";
                    localStorage.setItem(
                      "pi-desk:theme",
                      dark ? "dark" : "light",
                    );
                  }}
                >
                  Switch light / dark
                </button>
              </section>
              {session?.snapshot && (
                <>
                  <section className="panel-card">
                    <h3>Conversation</h3>
                    <form
                      key={`${selected}:${session.snapshot.id}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        run({
                          kind: "name",
                          name: String(
                            new FormData(event.currentTarget).get("name"),
                          ),
                        });
                      }}
                    >
                      <input
                        name="name"
                        aria-label="Conversation name"
                        defaultValue={session.snapshot.name ?? ""}
                        placeholder="Give this conversation a name"
                      />
                      <button>Save name</button>
                    </form>
                    <button disabled={busy || !connected} onClick={() => run({ kind: "reload" })}>
                      Reload Pi resources
                    </button>
                  </section>
                  <section className="panel-card">
                    <h3>Commands</h3>
                    <div className="command-list">
                      {session.snapshot.commands.map((command) => (
                        <button
                          key={command.name}
                          title={command.description}
                          onClick={() => {
                            setDraft(`/${command.name} `);
                            setPanel(undefined);
                          }}
                        >
                          /{command.name}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="panel-card">
                    <h3>
                      {session.snapshot.tools.length} tools ·{" "}
                      {session.snapshot.extensions.length} extensions
                    </h3>
                    <details>
                      <summary>Extension inventory</summary>
                      {session.snapshot.extensions.map((extension) => (
                        <p
                          className={
                            extension.error ? "error-text" : "inventory-item"
                          }
                          key={extension.path}
                        >
                          {basename(extension.path)}
                          {extension.error ? `: ${extension.error}` : ""}
                        </p>
                      ))}
                    </details>
                    <details>
                      <summary>Available tools</summary>
                      {session.snapshot.tools.map((tool) => (
                        <p className="inventory-item" key={tool.name}>
                          {tool.name}
                          {tool.active ? "" : " · inactive"}
                        </p>
                      ))}
                    </details>
                  </section>
                  <section className="panel-card">
                    <h3>Status</h3>
                    {Object.entries(ui?.statuses ?? {}).map(([key, text]) => (
                      <p className="status-item" key={key}>
                        {text}
                      </p>
                    ))}
                  </section>
                  <section className="panel-card">
                    <h3>Activity</h3>
                    {ui?.notifications.map((item) => (
                      <details key={item.id}>
                        <summary>
                          {item.level === "info" ? "Update" : item.level}
                        </summary>
                        <div className="detail-copy">{item.text}</div>
                      </details>
                    ))}
                  </section>
                </>
              )}
            </>
          )}
        </Inspector>
      )}
      {resumeOpen && <ResumeConversation computers={host.computers} connected={transportConnected} cwd={host.cwd}
        current={session} close={() => setResumeOpen(false)} selected={key => {
          setSelected(key); setResumeOpen(false); setPanel(undefined); setSidebar(false);
        }} />}
      {create && (
        <Modal title="New conversation" close={closeNewConversation}>
          <form onSubmit={(event) => void newSession(event)}>
            {state.host.computers && <label>Computer
              <select aria-label="Computer for new conversation" disabled={creating} value={newComputer ?? ""} onChange={event => {
                setNewComputer(event.target.value);
                setCwd(state.host!.computers!.find(computer => computer.id === event.target.value)?.cwd ?? "");
              }}>
                {!newComputer && <option value="">Choose a connected computer</option>}
                {state.host.computers.map(computer => <option key={computer.id} value={computer.id} disabled={!computer.connected}>
                  {computer.name}{computer.connected ? "" : ` · ${connectionLabel(computer)}`}
                </option>)}
              </select>
            </label>}
            <FolderField key={newComputer ?? "local"} value={cwd} onChange={setCwd} computer={newComputer}
              disabled={creating || !!state.host.computers && !state.host.computers.some(computer => computer.id === newComputer && computer.connected)} />
            <p className="muted">
              Pi loads this project's instructions, tools, and settings.
            </p>
            {createError && <p className="error-text" role="alert">{createError}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={closeNewConversation}>
                Cancel
              </button>
              <button className="primary" disabled={!cwd || creating || !!state.host.computers && !state.host.computers.some(computer => computer.id === newComputer && computer.connected)}>{creating ? "Creating…" : "Create conversation"}</button>
            </div>
          </form>
        </Modal>
      )}
      {confirmation.dialog}
      {question && `${selected}/${question.id}` !== dismissedQuestion && (
        <Question
          key={`${selected}/${question.id}`}
          draftKey={`${selected}/${question.id}`}
          context={`${currentComputer ? `${currentComputer.name} · ` : ""}${session ? title(session) : ""}`}
          question={question}
          questions={questions}
          choose={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
          drafts={questionDrafts.current}
          close={() => setDismissedQuestion(`${selected}/${question.id}`)}
          answer={async answer => { await command({ kind: "answer", id: question.id, answer }); }}
        />
      )}
    </div>
  );
}

type QuestionDraft = { choices: string[]; text: string; comment: string; freeform: boolean };
function Question({
  draftKey,
  context,
  question,
  questions,
  choose,
  drafts,
  close,
  answer,
}: {
  draftKey: string;
  context: string;
  question: InteractionSnapshot;
  questions: InteractionSnapshot[];
  choose: (id: string) => void;
  drafts: Map<string, QuestionDraft>;
  close: () => void;
  answer: (answer: UiAnswer | null) => Promise<void>;
}) {
  const form = question.form;
  const saved = drafts.get(draftKey);
  const [choices, setChoices] = useState<string[]>(saved?.choices ?? []);
  const [text, setText] = useState(
    saved?.text ?? (form.kind === "editor" || form.kind === "input" ? (form.value ?? "") : ""),
  );
  const [comment, setComment] = useState(saved?.comment ?? "");
  const [freeform, setFreeform] = useState(
    saved?.freeform ?? (form.kind !== "question" || !form.options.length),
  );
  useEffect(() => { drafts.set(draftKey, { choices, text, comment, freeform }); },
    [drafts, draftKey, choices, text, comment, freeform]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (value: UiAnswer | null) => {
    if (submitting) return;
    setSubmitting(true); setError("");
    try {
      await answer(value);
    } catch (error) { setError(errorText(error)); } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal title={form.title} close={close}>
      {context && <p className="muted question-owner">{context}</p>}
      {questions.length > 1 && <label>
        {questions.length} pending questions
        <select aria-label="Pending questions" value={question.id} onChange={event => choose(event.target.value)}>
          {questions.map(item => <option key={item.id} value={item.id}>
            {item.form.title}{item.scope ? ` · ${item.scope.label}` : ""}
          </option>)}
        </select>
      </label>}
      {question.scope && <p className="muted">Agent: {question.scope.label}</p>}
      {(form.kind === "input" || form.kind === "editor") && <>
        {form.context && <p className="detail-copy">{form.context}</p>}
        <ExternalLinks links={form.links} text={form.context} />
      </>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(
            form.kind === "confirm"
              ? { kind: "confirm", confirmed: true }
              : freeform
                ? { kind: "freeform", text }
                : {
                    kind: "selection",
                    selections: choices,
                    ...(comment ? { comment } : {}),
                  },
          );
        }}
      >
        {form.kind === "confirm" ? (
          <p>{form.message}</p>
        ) : form.kind === "question" ? (
          <>
            {form.context && (
              <div className="question-context">
                <Markdown>{form.context}</Markdown>
              </div>
            )}
            <div className="choices">
              {form.options.map((option, index) => (
                <label
                  className={`choice ${choices.includes(option.title) && !freeform ? "chosen" : ""}`}
                  key={index}
                >
                  <input
                    type={form.allowMultiple ? "checkbox" : "radio"}
                    name="choice"
                    checked={!freeform && choices.includes(option.title)}
                    onChange={() => {
                      setFreeform(false);
                      setChoices(
                        form.allowMultiple
                          ? choices.includes(option.title)
                            ? choices.filter((value) => value !== option.title)
                            : [...choices, option.title]
                          : [option.title],
                      );
                    }}
                  />
                  <span>
                    <strong>{option.title}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {form.allowFreeform && !!form.options.length && (
                <label className={`choice ${freeform ? "chosen" : ""}`}>
                  <input
                    type="radio"
                    name="choice"
                    checked={freeform}
                    onChange={() => setFreeform(true)}
                  />
                  <span>Write an answer</span>
                </label>
              )}
            </div>
            {freeform && (
              <textarea
                data-autofocus
                aria-label="Your answer"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Your answer…"
                rows={4}
              />
            )}
            {form.allowComment && !freeform && (
              <label>
                Comment <span className="muted">(optional)</span>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={2}
                />
              </label>
            )}
          </>
        ) : (
          <textarea
            data-autofocus
            aria-label={form.title}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={form.placeholder}
            rows={form.kind === "editor" ? 14 : 3}
          />
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit(null)}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              submitting ||
              (form.kind === "question" &&
                (freeform ? !text.trim() : !choices.length))
            }
          >
            {form.kind === "confirm" ? "Confirm" : "submitLabel" in form && form.submitLabel ? form.submitLabel : "Send answer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
const Message = memo(function Message({
  message,
  sessionKey,
  source,
}: {
  message: ChatMessage;
  sessionKey: string;
  source?: string;
}) {
  return (
    <ReferenceContext value={{ message: message.id, source }}>
    <article className={`message message-${message.role}`}>
      <div className="message-heading">
        <span
          className={
            message.role === "assistant" ? "assistant-avatar" : "message-label"
          }
        >
          {message.role === "assistant"
            ? "π"
            : message.role === "user"
              ? source ? "Input" : "You"
              : (message.toolName ?? "Note")}
        </span>
        {message.role === "assistant" && <strong>Pi</strong>}
        <time>
          {message.timestamp
            ? new Date(message.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}
        </time>
      </div>
      <div className="message-body">
        {message.tool && <div className={`tool-status tool-${message.tool.state}`}>
          <span>{message.tool.state === "running" ? "Running" : message.tool.state === "interrupted" ? "Stopped"
            : message.tool.state === "error" ? "Failed" : "Completed"}</span>
          {message.tool.state === "running" ? <Elapsed started={message.timestamp} />
            : message.tool.seconds !== undefined && <span>{message.tool.seconds.toFixed(1)}s</span>}
          {message.tool.exitCode !== undefined && <span>Exit {message.tool.exitCode}</span>}
          {message.tool.processRunning && <span>Process{message.tool.processId ? ` #${message.tool.processId}` : ""} was running when this result was returned</span>}
        </div>}
        {message.blocks.map((block, index) => {
          if (!block) return null;
          if (block.type === "file") return <FileLink key={index} session={sessionKey} file={block.file} />;
          if (block.type === "artifact") return <ArtifactLink key={index} session={sessionKey} id={block.id} label={block.label} />;
          if (block.type === "diff") return <DiffCard key={index} session={sessionKey} block={block} />;
          if (block.type === "text" && message.tool?.state === "running") return <LiveOutput key={index} text={block.text} />;
          if (block.type === "ledger") return <LedgerCard key={index} ledger={block.ledger} />;
          if (block.type === "image")
            return (
              <AssetImage key={index} session={sessionKey} asset={block.asset} />
            );
          if (block.type === "toolCall")
            return (
              <details className="tool-card" key={index}>
                <summary>
                  <span className="tool-icon">⌘</span>
                  <strong>{block.name}</strong>
                  <span className="muted">Tool call</span>
                </summary>
                <pre>{block.arguments}</pre>
                {block.full && <AssetLink session={sessionKey} asset={block.full} />}
                {block.truncated && !block.full && <p className="muted">Preview only. Complete arguments exceed the viewer's asset limit.</p>}
              </details>
            );
          const rendered = (
            <div className="markdown">
              <Markdown
                urlTransform={url => {
                  const file = message.links?.find(link => link.target === url)?.file;
                  return file ? `#desk-file-${file.id}` : /^(https?:|mailto:|tel:|#)/i.test(url) && !url.startsWith("#desk-file-") ? url : "";
                }}
                components={{
                  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                  a: ({ children, href, node }) => {
                    const file = message.links?.find(link => `#desk-file-${link.file.id}` === href)?.file;
                    const label = node?.children.some(child => child.type === "element" && child.tagName === "img")
                      ? node.children.map(child => child.type === "text" ? child.value
                        : child.type === "element" && child.tagName === "img" ? String(child.properties.alt ?? "Image") : "").join("")
                      : children;
                    return file ? <FileLink session={sessionKey} file={file}>{label}</FileLink>
                      : href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{label}</a> : <span>{label}</span>;
                  },
                  img: ({ alt, src }) => {
                    const file = message.links?.find(link => `#desk-file-${link.file.id}` === src)?.file;
                    return file ? <FileLink session={sessionKey} file={file}>{alt || file.name}</FileLink>
                      : src ? <a href={src} target="_blank" rel="noreferrer">{alt || "Open image"}</a> : <span>{alt}</span>;
                  },
                }}
              >
                {block.text}
              </Markdown>
              {block.full && (
                <AssetLink session={sessionKey} asset={block.full} />
              )}
              {block.truncated && !block.full && <p className="muted">Preview only. Complete output exceeds the viewer's asset limit.</p>}
            </div>
          );
          return block.type === "thinking" || message.role === "tool" ? (
            <details
              className={`tool-card ${message.isError ? "tool-error" : ""}`}
              key={index}
            >
              <summary>
                {block.type === "thinking"
                  ? "Thinking"
                  : message.tool?.state === "running"
                    ? "Live output"
                  : message.isError
                    ? "Tool error"
                    : "Tool result"}
              </summary>
              {rendered}
            </details>
          ) : (
            <div key={index}>{rendered}</div>
          );
        })}
      </div>
    </article>
    </ReferenceContext>
  );
});

document.documentElement.dataset.theme =
  localStorage.getItem("pi-desk:theme") ?? "light";

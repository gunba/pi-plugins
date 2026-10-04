import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Markdown from "react-markdown";
import { markdownPlugins } from "./markdown-links.ts";
import { MessageView as Message } from "./message-view.tsx";
import { api, ApiError, subscribe, onUpgrade } from "./connection.ts";
import type { BrowserAccount } from "./account.ts";
import { ResumeConversation } from "./resume.tsx";
import { OsIcon } from "./os-icon.tsx";
import { FolderField } from "./folder-picker.tsx";
import { connectionLabel, connectionTone } from "./connection-state.ts";
import { Inspector, Modal, Navigation, useMedia } from "./surfaces.tsx";
import { useConfirmation } from "./confirmation.tsx";
import { ControlActivity, EditorSuggestion } from "./control-status.tsx";
import { isControl } from "../shared/controls.ts";
import { openView, panelViews } from "./work-views.ts";
import type { WorkspaceState as HostState } from "./workspace.ts";
import { AttachmentList, useAttachments } from "./attachments.tsx";
import { SettingsLayout, SettingsContent, settingsSections } from "./settings.tsx";
import { SettingsForm } from "./settings-form.tsx";
import { dismissNotice, noticeIdentity, readDismissals } from "./notice-dismissals.ts";
import type { Feedback } from "../shared/feedback.ts";
import { readFeedback, saveFeedback } from "./chat-feedback.ts";
import { sessionTitle } from "../shared/session-title.ts";
import { ConversationFooter } from "./conversation-footer.tsx";
import { NativeQueue } from "./native-queue.tsx";
import { ConversationTitle } from "./conversation-title.tsx";
import { WorkRail } from "./work-rail.tsx";
import { DotConversation, DotNavigation, useDotConversation } from "./dot-conversation.tsx";
import { PlanView } from "./plan-view.tsx";
import { Icon, SectionIcon } from "./icons.tsx";
import { AgentPane } from "./agent-pane.tsx";
import { ViewPreviews } from "./view-previews.tsx";
import { CloseConversationButton } from "./close-conversation.tsx";
import { composerKey, type Delivery } from "./composer-keys.ts";
import { useCommandCompletion } from "./command-completion.tsx";
import { deskCommand, deskCommandCatalog } from "./desk-commands.ts";
import { PendingInputs } from "./pending-inputs.tsx";
import { PartySessions, PartyWakeMarker } from "./party-sessions.tsx";
import type { InputStatus, PromptCommand } from "../shared/inputs.ts";
import { DetailsView } from "./details-view.tsx";
import { ExternalLinks } from "./external-links.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { LedgerCard } from "./ledger-card.tsx";
import type { Ledger } from "../../../pi-context-ledger/model.ts";
import type { UiConversation, UiDetails } from "../../../pi-ui/index.ts";
import { cacheTranscript, trimCaches, reconcileHistory, reduceEvents, transcriptKey, type ClientState } from "./state.ts";
import type {
  HistoryPage,
  InteractionSnapshot,
  SessionView,
  WorkerCommand,
} from "../shared/protocol.ts";
import type { UiAnswer } from "../../../pi-ui/index.ts";

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const title = (session: SessionView) =>
  sessionTitle(session.snapshot?.name ?? session.name, session.snapshot?.title ?? session.title);
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
  const dotSelected = selected === "dot";
  const dot = useDotConversation(state.host?.computers, authorized === true && !!state.host);
  const [transportConnected, setConnected] = useState(false);
  const [localEpoch, setEpoch] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const wideWorkspace = useMedia("(min-width: 1280px)");
  const [panel, setPanel] = useState<
    "work" | "workspace" | "settings" | "view" | "agents" | undefined
  >();
  const [create, setCreate] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createRequest = useRef(0);
  const [focusedView, setFocusedView] = useState("");
  const [settingsSection, setSettingsSection] = useState("general");
  const [focusedAgent, setFocusedAgent] = useState("");
  const autoAgents = useRef("");
  const [cwd, setCwd] = useState("");
  const [newComputer, setNewComputer] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [feedback, setFeedback] = useState(() => readFeedback(localStorage));
  useEffect(() => saveFeedback(localStorage, feedback), [feedback]);
  const setError = useCallback((text: string, key = selected) => {
    if (!text) return;
    setFeedback(previous => ({ ...previous, [key]: [...(previous[key] ?? []),
      { id: crypto.randomUUID(), text: text.slice(0, 12_000), level: "error" as const, timestamp: Date.now(), generation: "browser" }].slice(-80) }));
  }, [selected]);
  const attachments = useAttachments(selected, setError);
  const error = feedback[selected]?.at(-1)?.text ?? "";
  const fileInput = useRef<HTMLInputElement>(null);
  const titleControl = useRef<{ edit: () => void }>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [latestRequest, setLatestRequest] = useState(0);
  const [dismissedQuestion, setDismissedQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const questionDrafts = useRef(new Map<string, QuestionDraft>());
  const [dismissedNotices, setDismissedNotices] = useState(() => readDismissals(localStorage));
  const dismissFeedback = useCallback((item: Feedback) => {
    setDismissedNotices(dismissNotice(localStorage, noticeIdentity(selected, item.generation, item.id)));
  }, [selected]);
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
  const settings = panel === "settings" || panel === "view" && visibleViews[0]?.surface === "settings";
  const showWorkRail = !dotSelected && wideWorkspace && (!panel || settings);
  const settingsViews = (ui?.views ?? []).filter(view => view.surface === "settings" && !view.scope);
  const agentViews = (ui?.views ?? []).filter(view => view.kind === "conversation");
  const activeAgents = agentViews.filter(view => (view.data as UiConversation).active).length;
  const chooseAgent = (id: string) => { setFocusedAgent(id); localStorage.setItem(`pi-desk:agent-selection:${selected}`, id); };
  useEffect(() => { setFocusedAgent(localStorage.getItem(`pi-desk:agent-selection:${selected}`) ?? ""); }, [selected]);
  useEffect(() => {
    if (panel === "view" && agentViews.some(view => view.id === focusedView)) { chooseAgent(focusedView); setPanel("agents"); }
    const activation = `${selected}:${session?.activation}`;
    if (activeAgents && autoAgents.current !== activation) {
      autoAgents.current = activation;
      if (!wideWorkspace && !panel && !document.activeElement?.matches("input,textarea,[contenteditable=true]")
        && matchMedia("(min-width:1181px)").matches) setPanel("agents");
    }
  }, [panel, focusedView, activeAgents, selected, session?.activation, ui, wideWorkspace]);
  const settingsForms = (ui?.interactions ?? []).filter(interaction => interaction.settings);
  const questions = (ui?.interactions ?? []).filter(interaction => !interaction.settings);
  const openSettingsForm = () => {
    const origin = settingsForms[0]?.settings;
    if (origin && ui?.views.some(view => view.id === origin.id && view.surface === "settings")) {
      setFocusedView(origin.id); setPanel("view");
    } else { setSettingsSection("activity"); setPanel("settings"); }
  };
  useEffect(() => { if (settingsForms.length) openSettingsForm(); }, [selected, settingsForms[0]?.id]);
  const question = questions.find(question => question.id === activeQuestion) ?? questions[0];
  const inlineQuestion = !settings && (question?.form.kind === "question" || question?.form.kind === "confirm");
  useEffect(() => {
    if (!questions.some(question => question.id === activeQuestion)) setActiveQuestion(questions[0]?.id ?? "");
  }, [questions, activeQuestion]);
  useEffect(() => {
    const pending = new Set(state.host?.sessions.flatMap(session =>
      session.ui?.interactions.map(question => `${session.key}/${question.id}`) ?? []));
    for (const id of questionDrafts.current.keys()) if (!pending.has(id)) questionDrafts.current.delete(id);
  }, [state.host?.sessions]);
  const completion = useCommandCompletion(draft, deskCommandCatalog(session?.snapshot?.commands ?? []), text => {
    setDraft(text); localStorage.setItem(draftKey(selected), text);
  });
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
  const settingBusy = controlBusy || sending || closing || !!question || !!settingsForms.length || session?.snapshot?.activity === "waiting"
    || !!session?.inputs?.some(input => input.state === "sending") || !!ui?.views.some(view => !view.scope && view.working);
  const busy =
    controlBusy ||
    session?.snapshot?.activity === "running" ||
    session?.snapshot?.activity === "waiting" ||
    !!session?.inputs?.some(input => input.state === "sending") ||
    !!question;
  useEffect(() => {
    const notices = (ui?.notifications ?? []).filter(item => item.level !== "info").map(item => ({
      ...item, level: item.level as "warning" | "error", timestamp: item.timestamp ?? Date.now(), generation: item.generation ?? ui!.generation,
    }));
    if (session?.error) notices.push({ id: `failure:${session.activation ?? ui?.generation ?? ""}:${session.error}`,
      text: session.error, level: "error", timestamp: Date.now(), generation: session.activation ?? ui?.generation ?? "browser" });
    if (!notices.length) return;
    setFeedback(previous => {
      const old = previous[selected] ?? [], known = new Set(old.map(item => item.id));
      const added = notices.filter(item => !known.has(item.id));
      return added.length ? { ...previous, [selected]: [...old, ...added].slice(-80) } : previous;
    });
  }, [selected, ui?.notifications, ui?.generation, session?.error, session?.activation]);

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
      await api(`/sessions/${session.key}/restart`, { takeover: true });
    } catch (error) { setError(errorText(error)); }
  }
  function openNewConversation(computerId?: string) {
    const computer = computerId ? state.host?.computers?.find(computer => computer.id === computerId)
      : currentComputer?.connected ? currentComputer : state.host?.computers?.find(computer => computer.connected);
    createRequest.current++; setCreateError(""); setCreating(false);
    setNewComputer(computer?.id);
    setCwd(session && session.computer === computer?.id ? session.cwd : computer?.cwd ?? state.host?.cwd ?? "");
    setCreate(true);
  }
  function closeNewConversation() { createRequest.current++; setCreate(false); setCreating(false); }
  async function send(delivery: Delivery = "steer") {
    if ((!draft.trim() && !attachments.files.length) || !attachments.ready || sendingRef.current || controlBusy || !connected
      || !session?.activation || !["starting", "ready"].includes(session.state)) return;
    const text = draft;
    const fileIds = attachments.files.map(file => file.id);
    sendingRef.current = true; setSending(true);
    try {
      const local = deskCommand(text, session.snapshot?.commands ?? []);
      if (local) {
        if (fileIds.length) throw Error("Commands cannot include file attachments.");
        switch (local.name) {
          case "settings": {
            const section = local.args || "general";
            if (!settingsSections.some(item => item.id === section)) throw Error(`Choose a settings section: ${settingsSections.map(item => item.id).join(", ")}.`);
            setSettingsSection(section); setPanel("settings"); break;
          }
          case "new": openNewConversation(); if (local.args) setCwd(local.args); break;
          case "resume": if (local.args) throw Error("Use /resume to choose a saved session."); setResumeOpen(true); break;
          case "name":
            if (session.state !== "ready") throw Error("Wait for Pi to finish opening this conversation before renaming it.");
            if (local.args) await command({ kind: "name", name: local.args }); else titleControl.current?.edit(); break;
          case "compact": await command({ kind: "compact", instructions: local.args || undefined }); break;
          case "reload": if (local.args) throw Error("Use /reload without arguments."); await command({ kind: "reload" }); break;
          case "fork": {
            if (!local.args) { setSettingsSection("conversation"); setPanel("settings"); break; }
            const [entry, position = "at", extra] = local.args.split(/\s+/);
            if (extra || !["at", "before"].includes(position)) throw Error("Use /fork <entry-id> [at|before], or /fork to choose an entry.");
            await command({ kind: "fork", entry, position: position as "at" | "before" }); break;
          }
          case "tree": if (local.args) throw Error("Use /tree without arguments."); setSettingsSection("conversation"); setPanel("settings"); break;
          case "help": if (local.args) throw Error("Use /help without arguments."); setDraft("/"); break;
        }
        if (localStorage.getItem(draftKey(selected)) === text) localStorage.removeItem(draftKey(selected));
        if (selectedRef.current === selected) setDraft(current => current === text ? "" : current);
        return;
      }
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
  const computers = host.computers ?? [{ id: undefined, name: host.name, platform: host.platform, connected, updates: host.updates, storageError: host.storageError,
    connection: connected ? "connected" as const : "reconnecting" as const, parties: host.parties }];
  const partyComputers = computers.map(computer => ({ id: computer.id, name: computer.name, connected: computer.connected, directory: computer.parties }));
  const selectedModel = session?.snapshot?.model;
  const isDefaultModel = !!selectedModel && selectedModel.provider === session?.snapshot?.defaultModel?.provider
    && selectedModel.id === session.snapshot.defaultModel.id;
  return (
    <div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <Navigation open={sidebar} close={() => setSidebar(false)}>
        <div className="brand">
          <span className="brand-mark small">π</span>
          <strong>Pi Desk</strong>
        </div>
        <div className="sidebar-actions">
          <button className="new-chat" onClick={() => openNewConversation()}>
            <span>＋</span> New conversation
          </button>
          <button className="resume-chat" title="Resume conversation" aria-label="Resume conversation" onClick={() => { setResumeOpen(true); setSidebar(false); }}>
            <span>◷</span> Resume
          </button>
        </div>
        <div className="nav-label">Dots</div>
        <nav className="dot-list" aria-label="Dots">
          <DotNavigation dot={dot} selected={dotSelected} open={() => { setSelected("dot"); setSidebar(false); setPanel(undefined); }} />
        </nav>
        <div className="nav-label">
          Sessions <span>{state.host.sessions.length}</span>
        </div>
        <nav className="session-list">
          {computers.map(computer => <section key={computer.id ?? "local"} aria-label={computer.name}>
          <div className="computer-heading">
            <span className="computer-name" title={computer.name}><OsIcon platform={computer.platform} /><strong>{computer.name}</strong></span>
            <small title={connectionLabel(computer)}><span className={`status-dot ${connectionTone(computer)}`} />{connectionLabel(computer)}</small>
            <button className="icon-button computer-create" aria-label={`New agent on ${computer.name}`} title={`New agent on ${computer.name}`}
              disabled={!computer.connected} onClick={() => openNewConversation(computer.id)}><Icon name="plus" /></button>
          </div>
          {computer.storageError && <details className="computer-storage-error"><summary><Icon name="warning" />Session save delayed</summary>
            <p>{computer.storageError}</p><button disabled={!computer.connected} onClick={() => void api("/storage/retry", {}, computer.id).catch(error => console.error("Catalog retry failed:", error))}>Retry saving</button>
          </details>}
          {(computer.updates?.available || computer.updates?.pending || computer.updates?.phase === "preparing") &&
            <button className="sidebar-update" onClick={() => { setPanel("settings"); setSidebar(false); }}>
              {computer.updates.phase === "applying" ? "Applying update…" : computer.updates.phase === "preparing" ? "Preparing update…"
                : computer.updates.pending ? "Update ready" : "Update available"} →
            </button>}
          {computer.connection === "upgrade" && <div className="sidebar-hint upgrade-hint"><p>Update this computer and the app. Native conversations are retained.</p>
            <button onClick={() => location.reload()}>Reload app</button></div>}
          <PartySessions directory={computer.parties} computer={computer.id} computers={partyComputers} connected={computer.connected}
            sessions={host.sessions.filter(item => item.computer === computer.id)
              .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.created - a.created)}
            renderSession={(item, agent) => <div className="session-row" key={item.key}>
              <button className={`session-item ${selected === item.key ? "selected" : ""}`} onClick={() => {
                setSelected(item.key); setSidebar(false); setPanel(undefined);
              }}>
                <span className={`status-dot ${item.interrupted ? "interrupted" : item.snapshot?.activity ?? item.state}`} />
                <span><span className="session-label-line"><strong>{item.pinned ? "★ " : ""}{title(item)}</strong><PartyWakeMarker agent={agent} /></span>
                  <small>{item.interrupted || item.state === "failed" ? "Interrupted · " : ""}{basename(item.cwd)}</small></span>
              </button>
              <CloseConversationButton icon session={item} name={title(item)} computer={computer.name} connected={computer.connected}
                 disabled={selected === item.key && sending} report={text => setError(text, item.key)}
                confirmed={() => { if (selectedRef.current === item.key) setPanel(undefined); }} />
            </div>} />
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
      <main className={`main${dotSelected ? " main-dot" : ""}`} data-primary-focus tabIndex={-1}>
        {dotSelected ? <DotConversation dot={dot} openNavigation={() => setSidebar(true)} /> : <>
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
            {session ? <ConversationTitle key={`${session.key}:${session.activation}`} title={title(session)}
              disabled={!connected || session.state !== "ready" || closing}
              control={titleControl} rename={name => command({ kind: "name", name })} /> : <strong>Welcome</strong>}
          </div>
          <div className="top-actions">
            {!!settingsForms.length && <button className="quiet-action" onClick={openSettingsForm}>Finish Settings</button>}
            {!wideWorkspace && <button type="button" className="icon-button" title="Workspace" aria-label="Workspace" aria-pressed={panel === "workspace"}
              onClick={() => setPanel(panel === "workspace" ? undefined : "workspace")}><Icon name="layers" /></button>}
            {session?.activation && <CloseConversationButton session={session} name={title(session)}
              computer={currentComputer?.name ?? host.name} connected={connected} disabled={sending} report={setError}
              confirmed={() => setPanel(undefined)} />}
            {session?.snapshot && (
              <button
                className={`work-button ${question ? "attention" : ""}`}
                onClick={() => setPanel(panel === "work" ? undefined : "work")}
              >
                <span className={`status-dot ${session.snapshot.activity}`} />
                {question ? "Needs your input" : busy ? "Working" : "Work"}
              </button>
            )}
            <button type="button" className="icon-button" title="Opening context" aria-label="Opening context"
              disabled={session?.state !== "ready"} aria-pressed={panel === "settings" && settingsSection === "context"}
              onClick={() => { setSettingsSection("context"); setPanel("settings"); }}><Icon name="context" /></button>
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
        <ViewPreviews views={(ui?.views ?? []).filter(view => !view.scope && (!showWorkRail || view.id !== "plan"))} open={id => { setFocusedView(id); setPanel("view"); }} />
        {!showWorkRail && !!agentViews.length && <button type="button" className={`agent-activity-bar${panel === "agents" ? " selected" : ""}`}
          aria-expanded={panel === "agents"} onClick={() => setPanel(panel === "agents" ? undefined : "agents")}>
          <strong>Agents</strong><span>{activeAgents} active · {agentViews.length} total</span><span>View →</span>
        </button>}
        {session && <ControlActivity key={`${selected}:controls`} session={selected} controls={controls} />}
        {session && !canCompose && <PendingInputs key={`${selected}:inputs`} session={session} connected={connected} report={setError} />}
        {session && !canCompose && (
          <div className="connection-banner">
            <span>Pi is not running. Resume to continue.</span>
            <button disabled={!connected} onClick={() => void restartSession()}>{session.file ? "Resume" : "Retry"}</button>
          </div>
        )}
        {host.directoryError && <div className="connection-banner" role="status">{host.directoryError}</div>}
        <TranscriptView key={`${selected}/${session?.ui?.generation ?? ""}`}
          session={selected} generation={session?.ui?.generation ?? ""}
          connected={connected && (session?.state === "ready" || session?.state === "starting" && !!session.historyReady)} epoch={epoch}
          messages={messages} onLatest={storeHistory} latestRequest={latestRequest}
          feedback={feedback[selected]} dismissed={dismissedNotices}
          renderMessage={(message, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected}
            dismissFeedback={dismissFeedback} />}
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
                    : session?.state === "starting" ? closing ? "Closing this conversation…" : controlBusy ? "Updating this conversation…" : "Opening this conversation…"
                    : session ? "What shall we work on?" : "Make something good."}
                </h1>
                <p>
                  {session && !canCompose ? session.error || "Resume Pi to load this conversation. Nothing has been resent." : session
                    ? "Your tools, context, and conversations. All in one place."
                    : "Start a conversation in any project. Pick it up on any device."}
                </p>
                {!session && (
                  <button className="primary" onClick={() => openNewConversation()}>
                    Start a conversation <span>↗</span>
                  </button>
                )}
                {session && !canCompose && !!draft.trim() && <p className="muted">Your unsent draft is kept on this device.</p>}
                {session?.state === "starting" && !controlBusy && (
                  <p className="muted">Loading your Pi setup. You can send now; messages will wait on this computer.</p>
                )}
              </div>
          }
          footer={<>
            {question && inlineQuestion && <Question inline key={`${selected}/${question.id}`} draftKey={`${selected}/${question.id}`} context=""
              question={question} questions={questions} choose={id => { setActiveQuestion(id); setDismissedQuestion(""); }} drafts={questionDrafts.current}
              close={() => setDismissedQuestion(`${selected}/${question.id}`)} answer={async answer => { await command({ kind: "answer", id: question.id, answer }); }} />}
            {busy && (
              <div className="activity-line">
                <span className="pulse-dot" />
                {question ? "Waiting for your answer" : session?.state === "starting" ? "Loading Pi…" : "Pi is working…"}
              </div>
            )}</>}
        />
        {session && canCompose && (
          <div className="composer-dock">
            <PendingInputs key={`${selected}:inputs`} session={session} connected={connected} report={setError} />
            {ui && <EditorSuggestion key={selected} session={selected} id={ui.editorId} text={ui.editorText}
              draft={draft} context={confirmationContext} edit={text => { setDraft(text); localStorage.setItem(draftKey(selected), text); }} />}
            {question && (
              <button
                className="question-banner"
                onClick={() => { setDismissedQuestion(""); if (inlineQuestion) setLatestRequest(value => value + 1); }}
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
              {completion.menu}
              <textarea
                aria-label="Message Pi"
                aria-autocomplete="list"
                aria-controls={completion.active ? "command-completion" : undefined}
                aria-activedescendant={completion.selected}
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
                  if (completion.keyDown(event)) return;
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
                    title="Change model; active work stops and continues with the new setting"
                    disabled={settingBusy || !connected || session.state !== "ready"}
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
                  <button type="button" className={`icon-button model-default${isDefaultModel ? " is-default" : ""}`}
                    aria-label={isDefaultModel ? "Default model on this computer" : "Set selected model as default"}
                    title={isDefaultModel ? "Default for new conversations on this computer" : "Set as default for new conversations on this computer"}
                    disabled={isDefaultModel || settingBusy || !connected || session.state !== "ready" || !selectedModel}
                    onClick={() => selectedModel && run({ kind: "model", provider: selectedModel.provider, id: selectedModel.id, makeDefault: true })}>
                    <Icon name="star" />
                  </button>
                  <select
                    aria-label="Reasoning level"
                    title="Change reasoning; active work stops and continues with the new setting"
                    value={session.snapshot?.thinking ?? ""}
                    disabled={settingBusy || !connected || session.state !== "ready"}
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
                    {busy && !controlBusy ? <><Icon name="steer" /><span>Steer</span></> : <Icon name="send" />}
                  </button>
                </div>
              </div>
              {attachments.progress && <p className="upload-progress" role="status">Uploading {attachments.progress}</p>}
              {!!attachments.files.length && session.snapshot?.model && !session.snapshot.model.images && (
                <p className="upload-progress">This model receives attachments as file paths. Image input is not supported by this model.</p>
              )}
            </form>
            <div className="composer-help">Enter to send or steer · Alt+Enter / Ctrl+Q to queue · Shift+Enter / Ctrl+J for a new line</div>
            <ConversationFooter key={session.key} session={session} computer={currentComputer?.name ?? state.host.name} connected={connected} disabled={closing}
              open={view => { setPanel("view"); setFocusedView(view.id); }}
              invoke={(view, action, value) => commandPromise({ kind: "action", view: view.id, revision: view.revision, action: action.id, value })} />
          </div>
        )}
        </>}
      </main>
      {showWorkRail && <WorkRail views={ui?.views ?? []} connected={connected && !closing}
        invoke={run} openAgents={id => { if (id) chooseAgent(id); setPanel("agents"); }} openWork={() => setPanel("work")}
        openPlan={() => { setFocusedView("plan"); setPanel("view"); }} />}
      {panel && (
        <Inspector settings={settings} className={panel === "agents" ? "agents-panel" : panel === "view" && focusedView === "plan" ? "plan-panel" : ""} title={settings ? "Settings" : panel === "agents" ? "Agents" : panel === "workspace" ? "Workspace" : panel === "work" ? "Work" : visibleViews[0]?.title ?? "Details"}
          close={() => setPanel(undefined)} back={panel === "view" && !settings ? () => setPanel("work") : undefined}>
          <div className="panel-title">
            {panel === "view" && !settings && <button className="icon-button"
              aria-label={visibleViews[0]?.surface === "settings" ? "Back to settings" : "Back to Work"}
              onClick={() => setPanel(visibleViews[0]?.surface === "settings" ? "settings" : "work")}>‹</button>}
            <h2 data-surface-heading tabIndex={-1}>
              {settings ? "Settings" : panel === "agents" ? "Agents" : panel === "workspace" ? "Workspace" : panel === "work"
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
          <SettingsLayout enabled={settings} active={panel === "view" ? focusedView : settingsSection}
            sections={[...settingsSections.slice(0, 2), ...settingsViews.map(view => ({ id: view.id, title: view.title })), ...settingsSections.slice(2)]}
            choose={id => {
              if (settingsViews.some(view => view.id === id)) { setFocusedView(id); setPanel("view"); }
              else { setSettingsSection(id); setPanel("settings"); }
            }}>
          {settings && settingsForms.map(interaction => <SettingsForm key={`${selected}/${interaction.id}`} interaction={interaction}
            draftKey={`${selected}/${interaction.id}`} drafts={questionDrafts.current} disabled={!connected || closing}
            answer={answer => command({ kind: "answer", id: interaction.id, answer })} />)}
          {panel === "workspace" && <WorkRail embedded views={ui?.views ?? []} connected={connected && !closing}
            invoke={run} openAgents={id => { if (id) chooseAgent(id); setPanel("agents"); }} openWork={() => setPanel("work")}
            openPlan={() => { setFocusedView("plan"); setPanel("view"); }} />}
          {panel === "agents" && session && <AgentPane key={`${selected}:agents`} session={session} views={agentViews}
            context={`${currentComputer?.name ?? host.name} · ${title(session)}`}
            focused={focusedAgent} choose={chooseAgent} connected={connected && !closing} epoch={epoch} messages={state.messages}
            onLatest={storeHistory} renderMessage={(message, source, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected} source={source} />}
            answer={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
            openView={id => { setFocusedView(id); setPanel("view"); }} />}
          {(panel === "work" || panel === "view") &&
            (visibleViews.length ? (
              visibleViews.map((view) => (
                <section className="panel-card" key={view.id} data-view={view.id}>
                  {view.id === "plan" && view.kind === "details" ? <PlanView view={view} showHeading={panel !== "view"} disabled={!connected || closing}
                    invoke={action => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })} /> : <>
                  <div className="panel-section-heading">
                  {(panel !== "view" || settings) && <h3><SectionIcon id={view.id} />{view.title}</h3>}
                  {!!view.actions?.length && <div className="panel-actions">
                    {view.actions.map(action => <button key={action.id} disabled={!!view.working || !connected}
                      title={action.label} aria-label={action.label}
                      onClick={() => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })}>
                      {action.label}
                    </button>)}
                  </div>}
                  </div>
                  {view.working && <p className="muted" role="status">{view.working}…</p>}
                  {view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
                  {view.kind === "details" ? <>
                    <DetailsView data={view.data as UiDetails} disabled={!!view.working || !connected} invoke={(action, value) => run({
                      kind: "action", view: view.id, revision: view.revision, action: action.id, value,
                    })} />
                    {(view.data as UiDetails).transcript && <TranscriptView key={(view.data as UiDetails).transcript}
                      source={(view.data as UiDetails).transcript!} session={selected} generation={ui!.generation}
                      connected={connected} epoch={epoch}
                      messages={state.messages[transcriptKey(selected, (view.data as UiDetails).transcript!)] ?? emptyMessages}
                      onLatest={storeHistory} renderMessage={(message, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected} source={(view.data as UiDetails).transcript} />} />}
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
                  </>}
                </section>
              ))
            ) : (
              <p className="muted">
                {panel === "view" ? "This view is unavailable. Reopen it from this session's controls."
                  : "Goals, tasks, agents and scheduled work will appear here."}
              </p>
            ))}
          {panel === "settings" && <SettingsContent section={settingsSection} host={host} account={account}
            session={session} computer={currentComputer} connected={connected} busy={busy || sending || controlBusy} settingBusy={settingBusy}
            invoke={command} compose={text => { setDraft(text); setPanel(undefined); }}
            restore={(target, text) => { if (selectedRef.current === target) setDraft(text); }} />}
          </SettingsLayout>
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
      {question && !inlineQuestion && `${selected}/${question.id}` !== dismissedQuestion && (
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

type QuestionDraft = { choices: string[]; text: string; freeform: boolean };
function Question({
  inline = false,
  draftKey,
  context,
  question,
  questions,
  choose,
  drafts,
  close,
  answer,
}: {
  inline?: boolean;
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
  const [freeform, setFreeform] = useState(
    saved?.freeform ?? (form.kind !== "question" || !form.options.length),
  );
  useEffect(() => { drafts.set(draftKey, { choices, text, freeform }); },
    [drafts, draftKey, choices, text, freeform]);
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
  const content = <form className="question-form"
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
                    ...(form.kind === "question" && form.allowComment && text ? { comment: text } : {}),
                  },
          );
        }}
      >
        <div className="question-scroll">
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
        {form.kind === "confirm" ? (
          <div className="request-description" tabIndex={0} aria-label="Request details">{form.message}</div>
        ) : form.kind === "question" ? (
          <>
            {form.context && (
              <div className="question-context">
                <Markdown remarkPlugins={markdownPlugins()}>{form.context}</Markdown>
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
                  value={text}
                  onChange={(event) => setText(event.target.value)}
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
        </div>
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
            {form.kind === "confirm" ? "Confirm" : "submitLabel" in form && form.submitLabel ? form.submitLabel
              : form.kind === "question" ? "Send answer" : form.kind === "input" || form.kind === "editor" ? "Save" : "Apply"}
          </button>
        </div>
      </form>;
  return inline ? <section className="inline-question" aria-labelledby={`question-${question.id}`}>
    <header><Icon name={form.kind === "confirm" ? "check" : "chat"} /><h3 id={`question-${question.id}`}>{form.title}</h3></header>
    {content}
  </section> : <Modal className="question-modal" title={form.title} close={close}>{content}</Modal>;
}
document.documentElement.dataset.theme =
  localStorage.getItem("pi-desk:theme") ?? "light";

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
import { activityLabel, sessionActivity } from "./activity.ts";
import { Inspector, Modal, Navigation, useMedia } from "./surfaces.tsx";
import { useConfirmation } from "./confirmation.tsx";
import { ControlActivity, EditorSuggestion } from "./control-status.tsx";
import { isControl } from "../shared/controls.ts";
import { openView, panelViews } from "./work-views.ts";
import type { WorkspaceState as HostState } from "./workspace.ts";
import { AttachmentList, useAttachments, type DraftFile } from "./attachments.tsx";
import { SettingsLayout, SettingsContent, settingsSections } from "./settings.tsx";
import { SettingsForm } from "./settings-form.tsx";
import { sessionTitle } from "../shared/session-title.ts";
import { ComposerStatus } from "./composer-status.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { DeliveryControl, deliveryModes } from "./delivery-control.tsx";
import { NativeQueue } from "./native-queue.tsx";
import { ConversationTitle } from "./conversation-title.tsx";
import { WorkRail } from "./work-rail.tsx";
import { WorkspaceActions } from "./workspace-actions.tsx";
import { DotConversation, DotNavigation, useDotConversation } from "./dot-conversation.tsx";
import { PlanView } from "./plan-view.tsx";
import { Icon, SectionIcon } from "./icons.tsx";
import { AgentPane } from "./agent-pane.tsx";
import { DeskStatusBar } from "./desk-status-bar.tsx";
import { LiveNotices, reportDeskError } from "./desk-status.ts";
import { agentInventory } from "./agent-inventory.ts";
import { ViewPreviews } from "./view-previews.tsx";
import { CloseConversationButton } from "./close-conversation.tsx";
import { composerKey, deliveryPreferenceKey, readDelivery, type Delivery } from "./composer-keys.ts";
import { useCommandCompletion } from "./command-completion.tsx";
import { deskCommand, deskCommandCatalog, type DeskCommandHandlers } from "./desk-commands.ts";
import { PendingInputs } from "./pending-inputs.tsx";
import { AgentWakeMarker } from "./agent-wake.tsx";
import type { InputStatus, PromptCommand } from "../shared/inputs.ts";
import { admittedInput, clearSubmission, createSubmission, readSubmission, submissionDecision, submissionFingerprint, submissionKey, submitWithReceipt, type SubmissionReceipt } from "./input-submission.ts";
import { DetailsView } from "./details-view.tsx";
import { Configuration } from "./configuration.tsx";
import { ExternalLinks } from "./external-links.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { Elapsed } from "./transcript-parts.tsx";
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
function uploadedPrompt(text: string, files: DraftFile[], session: string): PromptCommand | undefined {
  if (files.some(file => file.uploaded?.session !== session)) return;
  return { kind: "prompt", text, ...(files.length ? { attachments: files.map(file => file.uploaded!.id) } : {}) };
}
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
    "workspace" | "settings" | "view" | "agents" | undefined
  >();
  const [workspaceVisible, setWorkspaceVisible] = useState(() => localStorage.getItem("pi-desk:workspace-visible") !== "false");
  const [create, setCreate] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createRequest = useRef(0);
  const [focusedView, setFocusedView] = useState("");
  const [settingsSection, setSettingsSection] = useState("general");
  const [focusedAgent, setFocusedAgent] = useState("");
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const autoAgents = useRef("");
  const [cwd, setCwd] = useState("");
  const [newComputer, setNewComputer] = useState<string>();
  const [draft, setDraft] = useState("");
  const [deliveryMode, setDeliveryMode] = useState(() => readDelivery(localStorage));
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const liveNotices = useRef(new LiveNotices());
  const setError = useCallback((text: string, _key?: string) => { if (text) reportDeskError(text); }, []);
  useEffect(() => {
    const failed = (event: ErrorEvent) => reportDeskError(event.error ?? event.message);
    const rejected = (event: PromiseRejectionEvent) => reportDeskError(event.reason);
    window.addEventListener("error", failed); window.addEventListener("unhandledrejection", rejected);
    return () => { window.removeEventListener("error", failed); window.removeEventListener("unhandledrejection", rejected); };
  }, []);
  const attachments = useAttachments(selected, setError);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleControl = useRef<{ edit: () => void }>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [commandOutput, setCommandOutput] = useState<{ title: string; text: string }>();
  const [providerHint, setProviderHint] = useState<string>();
  const [latestRequest, setLatestRequest] = useState(0);
  const [dismissedQuestion, setDismissedQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const questionDrafts = useRef(new Map<string, QuestionDraft>());
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
  const extensionErrors = session?.snapshot?.extensions.filter(extension => extension.error) ?? [];
  const controls = session?.controls ?? [];
  const controlBusy = controls.some(control => control.state === "running");
  const closing = controls.some(control => control.kind === "close" && control.state === "running");
  const confirmation = useConfirmation(`${authorized}:${selected}:${session?.activation}:${ui?.generation}:${connected}`);
  const confirmationContext = session ? `${currentComputer?.name ?? "This computer"} · ${title(session)}` : "";
  const visibleViews = panelViews(ui?.views ?? [], panel, focusedView);
  const settings = panel === "settings" || panel === "view" && visibleViews[0]?.surface === "settings";
  const showWorkRail = !dotSelected && wideWorkspace && (workspaceVisible || panel === "workspace") && (!panel || settings || panel === "workspace");
  const settingsViews = (ui?.views ?? []).filter(view => view.surface === "settings" && !view.scope);
  const agentViews = (ui?.views ?? []).filter(view => view.kind === "conversation");
  const activeAgents = agentViews.filter(view => (view.data as UiConversation).active).length;
  const { historyView: agentHistory, total: totalAgents } = agentInventory(ui?.views ?? []);
  const chooseAgent = (id: string) => { setFocusedAgent(id); localStorage.setItem(`pi-desk:agent-selection:${selected}`, id); };
  const openAgentPane = (id?: string, history = false) => { if (id) chooseAgent(id); setAgentHistoryOpen(history); setPanel("agents"); };
  useEffect(() => { setFocusedAgent(localStorage.getItem(`pi-desk:agent-selection:${selected}`) ?? ""); }, [selected]);
  useEffect(() => {
    if (panel === "view" && focusedView === "subagents") setPanel("agents");
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
  const compactQuestion = useMedia("(max-width:760px), (max-height:600px)");
  const inlineQuestion = !settings && !compactQuestion && (question?.form.kind === "question" || question?.form.kind === "confirm");
  useEffect(() => {
    if (!questions.some(question => question.id === activeQuestion)) setActiveQuestion(questions[0]?.id ?? "");
  }, [questions, activeQuestion]);
  useEffect(() => {
    const pending = new Set(state.host?.sessions.flatMap(session =>
      session.ui?.interactions.map(question => `${session.key}/${question.id}`) ?? []));
    for (const id of questionDrafts.current.keys()) if (!pending.has(id)) questionDrafts.current.delete(id);
  }, [state.host?.sessions]);
  const noArguments = (name: string, args: string) => { if (args) throw Error(`Use /${name} without arguments.`); };
  const openPicker = (label: string) => {
    const picker = label === "Model" ? document.querySelector<HTMLButtonElement>("button.model-picker")
      : document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!picker || picker.disabled) throw Error("This choice is unavailable while the current operation is pending.");
    picker.focus();
    if (picker instanceof HTMLSelectElement) picker.showPicker?.(); else picker.click();
  };
  const rename = async (args: string) => {
    if (session?.state !== "ready") throw Error("Wait for Pi to finish opening this conversation before renaming it.");
    if (args) await command({ kind: "name", name: args }); else titleControl.current?.edit();
  };
  const accountPanel = (args: string) => { setProviderHint(args || undefined); setSettingsSection("accounts"); setPanel("settings"); };
  const commandHandlers: DeskCommandHandlers = {
    settings: { description: "Open Settings; optionally choose a section.", execute: args => {
      const section = args || "general";
      if (!settingsSections.some(item => item.id === section)) throw Error(`Choose a settings section: ${settingsSections.map(item => item.id).join(", ")}.`);
      setSettingsSection(section); setPanel("settings");
    } },
    new: { description: "Open a new conversation.", execute: args => { openNewConversation(); if (args) setCwd(args); } },
    resume: { description: "Choose a saved native session.", execute: args => { noArguments("resume", args); setResumeOpen(true); } },
    name: { description: "Rename this conversation.", execute: rename },
    rename: { description: "Alias for /name.", execute: rename },
    compact: { description: "Compact native context.", execute: args => command({ kind: "compact", instructions: args || undefined }) },
    reload: { description: "Reload native resources.", execute: args => { noArguments("reload", args); return command({ kind: "reload" }); } },
    fork: { description: "Choose a branch entry, or /fork <entry-id> [at|before].", execute: args => {
      if (!args) { setSettingsSection("conversation"); setPanel("settings"); return; }
      const [entry, position = "at", extra] = args.split(/\s+/);
      if (extra || !["at", "before"].includes(position)) throw Error("Use /fork <entry-id> [at|before].");
      return command({ kind: "fork", entry, position: position as "at" | "before" });
    } },
    tree: { description: "Open native branch history.", execute: args => { noArguments("tree", args); setSettingsSection("conversation"); setPanel("settings"); } },
    model: { description: "Choose a model.", argumentHint: "<provider/model>", execute: args => {
      if (!args) { openPicker("Model"); return; }
      if (session?.snapshot?.commands.some(item => item.name === "model" && item.execution === "control"))
        return command({ kind: "native", name: "model", args });
      const matches = session?.snapshot?.models.filter(model => `${model.provider}/${model.id}` === args || model.id === args) ?? [];
      if (matches.length !== 1) throw Error("Choose an exact provider/model from this worker's model picker.");
      return command({ kind: "model", provider: matches[0].provider, id: matches[0].id });
    } },
    thinking: { description: "Choose a reasoning level.", argumentHint: "<level>", execute: args => {
      if (!args) { openPicker("Reasoning level"); return; }
      return command({ kind: "thinking", level: args.toLowerCase() });
    } },
    login: { description: "Manage provider sign-in in Settings.", argumentHint: "<provider>", execute: accountPanel },
    logout: { description: "Manage saved accounts and sign-out in Settings.", execute: args => { noArguments("logout", args); accountPanel(""); } },
    copy: { description: "Copy the latest assistant text.", execute: async args => {
      noArguments("copy", args);
      if (!session?.snapshot?.commands.some(item => item.name === "copy" && item.execution === "read")) throw Error("This worker has no native clipboard-text adapter.");
      const value = await command<{ result: string }>({ kind: "native_read", name: "copy", args: "" });
      if (!value.result) throw Error("There is no assistant text to copy.");
      await navigator.clipboard.writeText(value.result);
    } },
    quit: { description: "Close this conversation, preserving its history.", execute: async args => {
      noArguments("quit", args);
      if (!session?.activation) throw Error("This conversation is not open.");
      await api(`/sessions/${selected}/close`, { id: crypto.randomUUID(), activation: session.activation });
    } },
    hotkeys: { description: "Show Desk keyboard shortcuts.", execute: args => {
      noArguments("hotkeys", args);
      setCommandOutput({ title: "Keyboard shortcuts", text: `Enter — ${deliveryModes.find(mode => mode.value === deliveryMode)!.label} (choose with the arrow beside Send)\nCtrl+Enter — interrupt and send\nAlt+Enter / Ctrl+Q — queue a follow-up\nShift+Enter / Ctrl+J — new line\nTab — complete a slash command\nUp / Down — choose a completion\nEsc — dismiss completion or dialog` });
    } },
    help: { description: "Show commands for this conversation.", execute: args => {
      noArguments("help", args);
      const catalog = deskCommandCatalog(session?.snapshot?.commands ?? [], commandHandlers);
      setCommandOutput({ title: "Commands", text: catalog.map(item => `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} — ${item.unavailable ?? item.description}`).join("\n") });
    } },
  };
  const completion = useCommandCompletion(draft, deskCommandCatalog(session?.snapshot?.commands ?? [], commandHandlers), text => {
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
    if ((panel !== "workspace" && panel !== "view") || !focusedView) return;
    const card = [...document.querySelectorAll<HTMLElement>("[data-view]")].find(element => element.dataset.view === focusedView);
    card?.scrollIntoView({ block: "start" });
  }, [panel, focusedView, selected]);
  const settingBusy = controlBusy || sending || closing || !!question || !!settingsForms.length || session?.snapshot?.activity === "waiting"
    || !!session?.inputs?.some(input => input.state === "sending") || !!ui?.views.some(view => !view.scope && view.working);
  const contextFrom = session?.snapshot?.contextFrom, compacting = session?.snapshot?.compacting;
  const busy =
    controlBusy ||
    session?.snapshot?.activity === "running" ||
    session?.snapshot?.activity === "waiting" ||
    !!session?.inputs?.some(input => input.state === "sending") ||
    !!question;
  useEffect(() => {
    const notice = liveNotices.current.latest(selected, ui);
    if (notice) reportDeskError(notice.text);
  }, [selected, ui]);
  useEffect(() => {
    if (session?.error) reportDeskError(session.error);
  }, [session?.error, session?.activation]);

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
    setCommandOutput(undefined);
    setDraft(localStorage.getItem(draftKey(selected)) ?? "");
    setState(previous => ({ ...previous, focused: [selected] }));
    localStorage.setItem("pi-desk:selected", selected);
  }, [selected]);
  useEffect(() => {
    if (!connected || !session?.activation || !attachments.ready || sendingRef.current) return;
    const receipt = JSON.parse(localStorage.getItem(submissionKey(selected)) ?? "null") as SubmissionReceipt | null;
    if (!receipt) return;
    let cancelled = false;
    const text = localStorage.getItem(draftKey(selected)) ?? "";
    const files = attachments.files;
    void (async () => {
      const status = await readSubmission(receipt, readInput);
      if (!admittedInput(status)) return;
      const prompt = uploadedPrompt(text, files, selected);
      const fingerprint = prompt ? await submissionFingerprint(prompt) : undefined;
      if (cancelled || sendingRef.current) return;
      if (fingerprint === receipt.fingerprint) await finishSubmission(receipt, text, files.map(file => file.id));
      else clearSubmission(localStorage, selected, receipt.id);
    })().catch(error => { if (!cancelled) setError(errorText(error)); });
    return () => { cancelled = true; };
  }, [selected, connected, epoch, session?.activation, attachments.ready]);

  async function readInput(id: string): Promise<InputStatus> {
    return (await api<{ status: InputStatus }>(`/sessions/${selected}/inputs/${id}`)).status;
  }
  async function finishSubmission(receipt: SubmissionReceipt, text: string, fileIds: string[]) {
    if (JSON.parse(localStorage.getItem(submissionKey(selected)) ?? "null")?.id !== receipt.id) return;
    try { if (fileIds.length) await attachments.clear(fileIds); }
    catch { throw new Error("Message queued on the computer, but its attachment draft could not be cleared. The receipt is retained to prevent a duplicate."); }
    if (!clearSubmission(localStorage, selected, receipt.id)) return;
    if (localStorage.getItem(draftKey(selected)) === text) localStorage.removeItem(draftKey(selected));
    if (selectedRef.current === selected) {
      setDraft(current => current === text ? "" : current); setLatestRequest(value => value + 1);
    }
  }
  async function command<T = unknown>(command: WorkerCommand, id: string = crypto.randomUUID()) {
    if (!session?.ui) throw new Error("Session is still starting.");
    return api<T>(`/sessions/${selected}/command`, {
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
  async function send(delivery: Delivery = deliveryMode) {
    if ((!draft.trim() && !attachments.files.length) || !attachments.ready || sendingRef.current || controlBusy || !connected
      || extensionErrors.length || !session?.activation || !["starting", "ready"].includes(session.state)) return;
    if (delivery === "now" && !session.workerRuntime?.sendNow) {
      setError("This worker does not support Send now. Restart this conversation when idle to enable it."); return;
    }
    const text = draft;
    const fileIds = attachments.files.map(file => file.id);
    sendingRef.current = true; setSending(true);
    try {
      const local = deskCommand(text, session.snapshot?.commands ?? [], commandHandlers);
      if (local) {
        if (fileIds.length) throw Error("Commands cannot include file attachments.");
        if (Object.hasOwn(commandHandlers, local.name)) await commandHandlers[local.name].execute(local.args);
        else {
          const info = session.snapshot?.commands.find(item => item.name === local.name);
          if (info?.execution === "read") {
            const value = await command<{ result: unknown }>({ kind: "native_read", name: local.name, args: local.args });
            if (selectedRef.current === selected) setCommandOutput({ title: `/${local.name}`, text: typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2) ?? "" });
          } else if (info?.execution === "control") await command({ kind: "native", name: local.name, args: local.args });
          else throw Error(`/${local.name} has no Desk adapter.`);
        }
        if (localStorage.getItem(draftKey(selected)) === text) localStorage.removeItem(draftKey(selected));
        if (selectedRef.current === selected) setDraft(current => current === text ? "" : current);
        return;
      }
      const receiptKey = submissionKey(selected);
      let previous = JSON.parse(localStorage.getItem(receiptKey) ?? "null") as SubmissionReceipt | null;
      const status = previous ? await readSubmission(previous, readInput) : undefined;
      if (previous && admittedInput(status)) {
        // Check cached upload IDs before touching files that may already have been consumed.
        const cached = uploadedPrompt(text, attachments.files, session.key);
        if (cached && submissionDecision(previous, session.activation, await submissionFingerprint(cached), status) === "confirmed") {
          await finishSubmission(previous, text, fileIds); return;
        }
        clearSubmission(localStorage, selected, previous.id);
        previous = null;
      }
      const uploaded = await attachments.upload(session.key, value => api(`/sessions/${selected}/uploads`, {
        activation: session.activation, command: value,
      }));
      const prompt: PromptCommand = {
        kind: "prompt", text, ...(uploaded.length ? { attachments: uploaded } : {}),
      };
      const fingerprint = await submissionFingerprint(prompt);
      const decision = submissionDecision(previous, session.activation, fingerprint, status);
      const reusable = decision === "reuse";
      if (decision === "confirm"
        && !await confirmation.request({
          title: "Send this message again?", context: confirmationContext, accept: "Send again", cancel: "Keep draft",
          body: <>
            <p>The earlier delivery was not confirmed. Check its history first.
              Sending now could duplicate a message that already arrived.</p>
            {text && <pre className="confirmation-preview">{text.slice(0, 2000)}{text.length > 2000 ? "…" : ""}</pre>}
            {!!fileIds.length && <p>{fileIds.length} attachment{fileIds.length === 1 ? "" : "s"}</p>}
          </>,
        })) return;
      const receipt = reusable ? previous! : createSubmission({
        activation: session.activation, state: session.state, generation: session.ui?.generation,
      }, fingerprint, delivery);
      localStorage.setItem(receiptKey, JSON.stringify(receipt));
      try {
        const input = await submitWithReceipt(receipt, async () => (await api<{ input: InputStatus }>(`/sessions/${selected}/inputs`, {
          id: receipt.id, activation: receipt.activation, generation: receipt.generation,
          command: { ...prompt, behavior: receipt.behavior },
        })).input, readInput);
        if (!admittedInput(input)) {
          localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
          throw new Error(input.error ?? "This message was cancelled. It was not sent again.");
        }
      }
      catch (error) {
        if (JSON.parse(localStorage.getItem(receiptKey) ?? "null")?.id === receipt.id) {
          if (error instanceof ApiError && error.status === 409) localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, requiresConfirmation: true }));
        }
        throw error;
      }
      await finishSubmission(receipt, text, fileIds);
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
        <DeskStatusBar />
      </main>
    );
  if (!state.host)
    return (
      <main className="pair-page">
        <div className="brand-mark">π</div>
        <p>Connecting to your workspace…</p>
        <DeskStatusBar />
      </main>
    );

  const host = state.host;
  const computers = host.computers ?? [{ id: undefined, name: host.name, platform: host.platform, connected, updates: host.updates, storageError: host.storageError,
    connection: connected ? "connected" as const : "reconnecting" as const, parties: host.parties }];
  const selectedModel = session?.snapshot?.model;
  const isDefaultModel = !!selectedModel && selectedModel.provider === session?.snapshot?.defaultModel?.provider
    && selectedModel.id === session.snapshot.defaultModel.id;
  const modelPreferences = session?.snapshot && <>
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
          {level.charAt(0).toUpperCase() + level.slice(1)}
        </option>
      ))}
    </select>
  </>;
  return (
    <div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <DeskStatusBar />
      <Navigation open={sidebar} close={() => setSidebar(false)}>
        <div className="brand">
          <span className="brand-mark small">π</span>
          <strong>Pi Desk</strong>
        </div>
        <div className="sidebar-actions">
          <button className="new-chat" aria-label="New conversation" title="New conversation" onClick={() => openNewConversation()}>
            <Icon name="plus" /> New chat
          </button>
          <button className="resume-chat" title="Resume conversation" aria-label="Resume conversation" onClick={() => { setResumeOpen(true); setSidebar(false); }}>
            <Icon name="clock" /> Resume
          </button>
        </div>
        <div className="sidebar-scroll">
        <div className="nav-label">Dots</div>
        <nav className="dot-list" aria-label="Dots">
          <DotNavigation dot={dot} selected={dotSelected} open={() => { setSelected("dot"); setSidebar(false); setPanel(undefined); }} />
        </nav>
        <div className="nav-label">
          Computers <span>{computers.length}</span>
        </div>
        <nav className="session-list" aria-label="Computers">
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
          {host.sessions.filter(item => item.computer === computer.id)
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.created - a.created).map(item => {
            const agent = computer.parties?.agents.find(peer => peer.id === (item.snapshot?.id ?? item.agentId));
            return <div className="session-row" key={item.key}>
              <button className={`session-item ${selected === item.key ? "selected" : ""}`} onClick={() => {
                setSelected(item.key); setSidebar(false); setPanel(undefined);
              }}>
                <span className={`status-dot ${sessionActivity(item)}`} role="img"
                  aria-label={activityLabel(sessionActivity(item))} title={activityLabel(sessionActivity(item))} />
                <span><span className="session-label-line"><strong>{item.pinned ? "★ " : ""}{title(item)}</strong><AgentWakeMarker agent={agent} /></span>
                  <small className="session-metadata"><span className="session-activity">{activityLabel(sessionActivity(item))}</span><span aria-hidden="true">·</span><span className="session-folder" title={item.cwd}>{basename(item.cwd)}</span></small></span>
              </button>
              <CloseConversationButton icon session={item} name={title(item)} computer={computer.name} connected={computer.connected}
                 disabled={selected === item.key && sending} report={text => setError(text, item.key)}
                confirmed={() => { if (selectedRef.current === item.key) setPanel(undefined); }} />
            </div>;
          })}
          {computer.connection !== "upgrade" && !host.sessions.some(item => item.computer === computer.id) &&
            <p className="sidebar-hint">{computer.connected ? "No open sessions." : "Connect to see open sessions."}</p>}
          </section>)}
        </nav>
        </div>
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
            {session && <span className="conversation-activity" title={activityLabel(sessionActivity(session))}>
              <span className={`status-dot ${sessionActivity(session)}`} /><span>{activityLabel(sessionActivity(session))}</span>
            </span>}
            <button type="button" className="icon-button" title="Workspace" aria-label="Workspace" aria-pressed={showWorkRail || panel === "workspace"}
              onClick={() => {
                if (wideWorkspace) { const visible = !showWorkRail; setWorkspaceVisible(visible); localStorage.setItem("pi-desk:workspace-visible", String(visible)); setPanel(undefined); }
                else setPanel(panel === "workspace" ? undefined : "workspace");
              }}><Icon name="layers" /></button>
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
              <Icon name="more" />
            </button>
            {session?.activation && <CloseConversationButton icon session={session} name={title(session)}
              computer={currentComputer?.name ?? host.name} connected={connected} disabled={sending} report={setError}
              confirmed={() => setPanel(undefined)} />}
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
        {!showWorkRail && totalAgents > 0 && <button type="button" className={`agent-activity-bar${panel === "agents" ? " selected" : ""}`}
          aria-expanded={panel === "agents"} onClick={() => setPanel(panel === "agents" ? undefined : "agents")}>
          <strong>Agents</strong><span>{activeAgents} active · {totalAgents} total</span><span>View →</span>
        </button>}
        {session && <ControlActivity key={`${selected}:controls`} session={selected} controls={controls} />}
        {session?.state === "ready" && extensionErrors.length > 0 && <div className="connection-banner" role="alert">
          <span>Pi could not load {extensionErrors.length === 1 ? "an extension" : "some extensions"}. Retry loading before sending messages. Your conversation is retained; this does not resend your last message.</span>
          <button disabled={!connected || controlBusy || !["idle", "error"].includes(session.snapshot?.activity ?? "")}
            onClick={() => run({ kind: "reload" })}>{controlBusy ? "Loading…" : "Retry loading"}</button>
        </div>}
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
          renderMessage={(message, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected}
            summarised={contextFrom !== undefined && message.order < contextFrom} />}
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
                    : session?.reconnecting ? "Reconnecting to Pi…"
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
                  <p className="muted">{session.reconnecting ? "Reconnecting to the existing worker. Queued messages stay on this computer."
                    : "Loading your Pi setup. You can send now; messages will wait on this computer."}</p>
                )}
              </div>
          }
          footer={<>
            {busy && (
              <div className="activity-line">
                <span className="pulse-dot" />
                {question ? "Waiting for your answer" : session?.reconnecting ? "Reconnecting to Pi…" : session?.state === "starting" ? "Loading Pi…"
                  : compacting ? <>{compacting.reason === "manual" ? "Compacting context…" : compacting.reason === "overflow" ? "Context overflowed. Compacting, then retrying…"
                    : "Context is nearly full. Compacting…"} <Elapsed started={compacting.started} /></> : "Pi is working…"}
              </div>
            )}</>}
        />
        {question && inlineQuestion && <Question inline key={`${selected}/${question.id}`} draftKey={`${selected}/${question.id}`} context=""
          question={question} questions={questions} choose={id => { setActiveQuestion(id); setDismissedQuestion(""); }} drafts={questionDrafts.current}
          close={() => setDismissedQuestion(`${selected}/${question.id}`)} answer={async answer => { await command({ kind: "answer", id: question.id, answer }); }} />}
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
            {session.snapshot && <NativeQueue queue={session.snapshot.queue}
              sendNow={connected && session.state === "ready" && session.workerRuntime?.queueNow
                ? (queue, index, text) => run({ kind: "queue_now", queue, index, text }) : undefined} />}
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
                ref={composerInput} aria-label="Message Pi"
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
                    matchMedia("(pointer:fine)").matches, deliveryMode);
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
                  <ModelPicker snapshot={session.snapshot} disabled={settingBusy || !connected || session.state !== "ready"}
                    select={(model, context) => run({ kind: "model", provider: model.provider, id: model.id, ...(context ? { context } : {}) })}
                    accounts={accountPanel} history={() => { setSettingsSection("conversation"); setPanel("settings"); }} />
                  <div className="composer-preferences">{modelPreferences}</div>
                  </>}
                </div>
                <ComposerStatus key={session.key} session={session} computer={currentComputer?.name ?? state.host.name} connected={connected} disabled={closing}
                  preferences={modelPreferences} shortcutHint={`Enter: ${deliveryModes.find(mode => mode.value === deliveryMode)!.label} · Shift+Enter: new line · Ctrl+Enter: send now · Alt+Enter: queue`}
                  open={view => { setPanel("view"); setFocusedView(view.id); }}
                  invoke={(view, action, value) => commandPromise({ kind: "action", view: view.id, revision: view.revision, action: action.id, value })} />
                <div className="send-controls">
                  <button type="button" className="icon-button" aria-label="Attach files" title="Attach files (up to 8 MiB each)"
                    disabled={sending || !attachments.ready} onClick={() => fileInput.current?.click()}>＋</button>
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
                  <DeliveryControl value={deliveryMode} scope={selected} busy={busy && !controlBusy}
                    canSendNow={!!session.workerRuntime?.sendNow} send={value => void send(value)}
                    choose={value => { setDeliveryMode(value); localStorage.setItem(deliveryPreferenceKey, value); composerInput.current?.focus({ preventScroll: true }); }}
                    disabled={(!draft.trim() && !attachments.files.length) || !attachments.ready || !!extensionErrors.length
                      || sending || controlBusy || !connected || !session.activation || !["starting", "ready"].includes(session.state)} />
                </div>
              </div>
              {attachments.progress && <p className="upload-progress" role="status">Uploading {attachments.progress}</p>}
              {!!attachments.files.length && session.snapshot?.model && !session.snapshot.model.images && (
                <p className="upload-progress">This model receives attachments as file paths. Image input is not supported by this model.</p>
              )}
            </form>

          </div>
        )}
        </>}
      </main>
      {showWorkRail && <WorkRail views={ui?.views ?? []} connected={connected && !closing}
        invoke={run} openAgents={openAgentPane} focused={panel === "workspace" ? focusedView : undefined}
        openView={id => { setFocusedView(id); setPanel("view"); }} />}
      {panel && !(panel === "workspace" && wideWorkspace) && (
        <Inspector settings={settings} className={panel === "agents" ? "agents-panel" : panel === "view" && focusedView === "plan" ? "plan-panel" : ""} title={settings ? "Settings" : panel === "agents" ? "Agents" : panel === "workspace" ? "Workspace" : visibleViews[0]?.title ?? "Details"}
          close={() => setPanel(undefined)} back={panel !== "workspace" && !settings ? () => setPanel("workspace") : undefined}>
          <div className="panel-title">
            {panel !== "workspace" && !settings && <button className="icon-button"
              aria-label="Back to workspace" onClick={() => setPanel("workspace")}>‹</button>}
            <h2 data-surface-heading tabIndex={-1}>
              {settings ? "Settings" : panel === "agents" ? "Agents" : panel === "workspace" ? "Workspace" : panel === "view"
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
            invoke={run} openAgents={openAgentPane} focused={focusedView}
            openView={id => { setFocusedView(id); setPanel("view"); }} />}
          {panel === "agents" && session && <AgentPane key={`${selected}:agents`} session={session} views={agentViews}
            history={agentHistory} historyInitiallyOpen={agentHistoryOpen}
            context={`${currentComputer?.name ?? host.name} · ${title(session)}`}
            focused={focusedAgent} choose={chooseAgent} connected={connected && !closing} epoch={epoch} messages={state.messages}
            onLatest={storeHistory} renderMessage={(message, source, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected} source={source} />}
            answer={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
            openView={id => { setFocusedView(id); setPanel("view"); }} />}
          {panel === "view" &&
            (visibleViews.length ? (
              visibleViews.map((view) => (
                <section className="panel-card" key={view.id} data-view={view.id}>
                  {view.kind === "configuration" ? <Configuration key={`${selected}:${ui?.generation}:${view.id}`} view={view} disabled={!!view.working || !connected || closing}
                    invoke={(action, value) => run({ kind: "action", view: view.id, revision: view.revision, action: action.id, value })} />
                  : view.id === "plan" && view.kind === "details" ? <PlanView view={view} showHeading={panel !== "view"} disabled={!connected || closing}
                    invoke={action => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })} /> : <>
                  <div className="panel-section-heading">
                  {(panel !== "view" || settings) && <h3><SectionIcon id={view.id} />{view.title}</h3>}
                  <WorkspaceActions view={view} disabled={!!view.working || !connected}
                    invoke={action => run({ kind: "action", view: view.id, revision: view.revision, action: action.id })} />
                  </div>
                  {view.working && <p className="muted" role="status">{view.working}…</p>}
                  {view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
                  {view.kind === "details" ? <>
                    <DetailsView data={view.id === "subagents" ? { ...view.data as UiDetails, items: [] } : view.data as UiDetails}
                      disabled={!!view.working || !connected} invoke={(action, value) => run({
                        kind: "action", view: view.id, revision: view.revision, action: action.id, value,
                      })} />
                    {view.id === "subagents" && <button onClick={() => openAgentPane(undefined, true)}>Browse agents and history →</button>}
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
                  : "Plans, agents and messages will appear here."}
              </p>
            ))}
          {panel === "settings" && <SettingsContent section={settingsSection} host={host} account={account}
            session={session} computer={currentComputer} connected={connected} busy={busy || sending || controlBusy} settingBusy={settingBusy} providerHint={providerHint}
            invoke={command} compose={text => { setDraft(text); setPanel(undefined); }}
            restore={(target, text) => { if (selectedRef.current === target) setDraft(text); }} />}
          </SettingsLayout>
        </Inspector>
      )}
      {resumeOpen && <ResumeConversation computers={host.computers} connected={transportConnected} cwd={host.cwd}
        current={session} close={() => setResumeOpen(false)} selected={key => {
          setSelected(key); setResumeOpen(false); setPanel(undefined); setSidebar(false);
        }} />}
      {commandOutput && <Modal title={commandOutput.title} close={() => setCommandOutput(undefined)}>
        <pre className="command-output">{commandOutput.text}</pre>
      </Modal>}
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

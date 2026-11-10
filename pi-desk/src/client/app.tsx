import { restorePaneWidths } from "./pane-width.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiAnswer, UiConversation, UiDetails } from "../../../pi-ui/index.ts";
import { isControl } from "../shared/controls.ts";
import { asksInBackground, openQuestions, questionKey } from "../shared/attention.ts";
import { splitDictationNote } from "../shared/dictation-note.ts";
import type { ChatMessage, HistoryPage, WorkerCommand } from "../shared/protocol.ts";
import type { BrowserAccount } from "./account.ts";
import { activityLabel, sessionActivity, wakeLabel } from "./activity.ts";
import { agentInventory } from "./agent-inventory.ts";
import { AgentPane } from "./agent-pane.tsx";
import { applyTextFont, textFont } from "./fonts.ts";
import { useAttachments } from "./attachments.tsx";
import type { Brief, BriefState } from "./brief.tsx";
import { WorkFocus, WorkModal, WorkPane, messageLinks, workItems, type WorkItem } from "./change-view.tsx";
import { CloseConversationButton } from "./close-conversation.tsx";
import { useCommandCompletion } from "./command-completion.tsx";
import { deskCommandHandlers } from "./command-handlers.ts";
import { CompactionOverlay } from "./compaction-overlay.tsx";
import { Composer } from "./composer.tsx";
import { draftKey, readDelivery } from "./composer-keys.ts";
import { useConfirmation } from "./confirmation.tsx";
import { api, ApiError, subscribe, onUpgrade } from "./connection.ts";
import { ResumeModel } from "./new-model.tsx";
import { connectionLabel, isOffline } from "./connection-state.ts";
import { ControlActivity, EditorSuggestion } from "./control-status.tsx";
import { ConversationTitle } from "./conversation-title.tsx";
import { readsStopped, VersionBanner } from "./conversation-version.tsx";
import { deskCommandCatalog } from "./desk-commands.ts";
import { DeskStatusBar } from "./desk-status-bar.tsx";
import { LiveNotices, reportDeskError } from "./desk-status.ts";
import { dictationComputer } from "./dictation.tsx";
import { Home } from "./home.tsx";
import { Icon } from "./icons.tsx";
import { InteractionForm, type InteractionDraft } from "./interaction-form.tsx";
import { Loading } from "./loading.tsx";
import type { Recall } from "./message-history.ts";
import { useMessageSending } from "./message-sending.tsx";
import { BriefContext, MessageView as Message, RewindContext } from "./message-view.tsx";
import { MoveConversation, type MoveRequest } from "./move-conversation.tsx";
import { NativeQueue } from "./native-queue.tsx";
import { useNewConversation } from "./new-conversation.tsx";
import { PendingInputs } from "./pending-inputs.tsx";
import { PlanHeader } from "./plan-header.tsx";
import { askForNotificationsOnFirstClick, useQuestionAlerts } from "./question-alerts.ts";
import { trackUse } from "./presence.ts";
import { useFinishedBadge, useSeen } from "./finished.ts";
import { useNoticeLinks, useSharedTask } from "./notice-links.ts";
import { ResumeConversation } from "./resume.tsx";
import { SettingsLayout, SettingsContent, settingsGroups, settingsPage, MERGED_VIEWS } from "./settings.tsx";
import { Sidebar } from "./sidebar.tsx";
import { cacheTranscript, trimCaches, reconcileHistory, reduceEvents, transcriptKey, type ClientState } from "./state.ts";
import { Inspector, Modal, useMedia } from "./surfaces.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { ViewCard } from "./view-card.tsx";
import { ViewPreviews } from "./view-previews.tsx";
import { openView, panelViews } from "./work-views.ts";
import { Banner } from "./picture.tsx";
import { conversationTitle, folderName, sessionKey, type WorkspaceState as HostState } from "./workspace.ts";

/** What "Review the changes" sends: a review of the turn's work with the code-review skill, reported before anything changes. */
const REVIEW_REQUEST = "Use the code-review skill to review the changes you made in your last turn. Check each finding against the code before you report it, and don't change anything yet.";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const emptyMessages: NonNullable<ClientState["messages"][string]> = [];

const WORK_HIDDEN = "pi-desk:work-pane-hidden", WORK_BY_CONVERSATION = "pi-desk:work-pane";
/** Whether Work was hidden in this conversation; one not opened here before takes the last choice made in any. */
function workHiddenFor(conversation: string): boolean {
  try {
    const choice = (JSON.parse(localStorage.getItem(WORK_BY_CONVERSATION) ?? "{}") as Record<string, unknown>)[conversation];
    if (typeof choice === "boolean") return choice;
  } catch { /* unreadable: the last choice */ }
  return localStorage.getItem(WORK_HIDDEN) === "true";
}
/** Keeps the choice for this conversation, for the 300 most recently changed. */
function rememberWorkHidden(conversation: string, hidden: boolean): void {
  localStorage.setItem(WORK_HIDDEN, String(hidden));
  let choices: Record<string, boolean> = {};
  try { choices = JSON.parse(localStorage.getItem(WORK_BY_CONVERSATION) ?? "{}") as Record<string, boolean>; } catch { /* start again */ }
  delete choices[conversation]; choices[conversation] = hidden;
  const kept = Object.keys(choices);
  for (const old of kept.slice(0, Math.max(0, kept.length - 300))) delete choices[old];
  localStorage.setItem(WORK_BY_CONVERSATION, JSON.stringify(choices));
}

export function App({ account }: { account?: BrowserAccount }) {
  const [state, setState] = useState<ClientState>({ messages: {} });
  const [authorized, setAuthorized] = useState<boolean | undefined>();
  const [upgrade, setUpgrade] = useState<string>();
  useEffect(() => onUpgrade(setUpgrade), []);
  const [selected, setSelected] = useState(
    ["dot", "quests", ""].includes(localStorage.getItem("pi-desk:selected") ?? "") ? "home" : localStorage.getItem("pi-desk:selected")!,
  );
  const homeSelected = selected === "home";
  const workspaceServer = state.host?.computers?.find(computer => computer.teleport?.hold)?.id;
  const [transportConnected, setConnected] = useState(false);
  const [localEpoch, setEpoch] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const wideWorkspace = useMedia("(min-width: 1280px)");
  // Below this width the sidebar is a drawer, so the header names the conversation and closes it.
  const phone = useMedia("(max-width: 760px)");
  const [panel, setPanel] = useState<
    "settings" | "view" | "agents" | undefined
  >();
  // Changes and shown work open beside the conversation; hidden stays hidden until the agent shows something new.
  const [workHidden, setWorkHidden] = useState(() => workHiddenFor(localStorage.getItem("pi-desk:selected") ?? ""));
  const [workSelected, setWorkSelected] = useState<string>();
  const [workExtra, setWorkExtra] = useState<WorkItem>();
  const [workModal, setWorkModal] = useState<WorkItem>();
  const [mobileWorkOpen, setMobileWorkOpen] = useState(false);
  useEffect(restorePaneWidths, []);
  const [resumeOpen, setResumeOpen] = useState<boolean | "switch">(false);
  const [focusedView, setFocusedView] = useState("");
  const [settingsSection, setSettingsSection] = useState("general");
  const [focusedAgent, setFocusedAgent] = useState("");
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const autoAgents = useRef("");
  const [draft, setDraft] = useState("");
  const [deliveryMode, setDeliveryMode] = useState(() => readDelivery(localStorage));
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const liveNotices = useRef(new LiveNotices());
  const setError = useCallback((text: string) => { if (text) reportDeskError(text); }, []);
  useEffect(() => {
    // Browsers report a resize made during a ResizeObserver callback, as measured transcript rows do,
    // then deliver the rest next frame. Nothing is lost, so it is not an error worth showing.
    const failed = (event: ErrorEvent) => { if (!event.error && /^ResizeObserver loop/.test(event.message)) return; reportDeskError(event.error ?? event.message); };
    const rejected = (event: PromiseRejectionEvent) => reportDeskError(event.reason);
    window.addEventListener("error", failed); window.addEventListener("unhandledrejection", rejected);
    return () => { window.removeEventListener("error", failed); window.removeEventListener("unhandledrejection", rejected); };
  }, []);
  const attachments = useAttachments(selected, setError);
  const titleControl = useRef<{ edit: () => void }>(null);
  const [commandOutput, setCommandOutput] = useState<{ title: string; text: string }>();
  const [providerHint, setProviderHint] = useState<string>();
  const [latestRequest, setLatestRequest] = useState(0);
  const [dismissedQuestion, setDismissedQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const questionDrafts = useRef(new Map<string, InteractionDraft>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const session = state.host?.sessions.find(
    (session) => session.key === selected,
  );
  const previousSession = useRef<string | undefined>(undefined);
  // The agent shown, so that one which moves itself to another computer is followed there: its conversation leaves
  // this computer before it starts on the other.
  const following = useRef<{ agent: string; until: number } | undefined>(undefined);
  const shownAgent = session && !session.moved ? session.agentId ?? session.snapshot?.id : undefined;
  if (shownAgent) following.current = { agent: shownAgent, until: 0 };
  useEffect(() => {
    if ((!session || session.moved) && previousSession.current === selected && following.current) following.current.until = Date.now() + 120_000;
    if (!session && previousSession.current === selected) {
      setSelected(""); setPanel(undefined);
    }
    previousSession.current = session?.key;
  }, [session?.key, session?.moved, selected]);
  useEffect(() => {
    const follow = following.current;
    if (!follow || follow.until < Date.now() || (session && !session.moved)) return;
    const there = state.host?.sessions.find(item => (item.agentId ?? item.snapshot?.id) === follow.agent && item.key !== session?.key
      && !item.moved && item.state !== "closed");
    if (there) { follow.until = 0; setSelected(there.key); }
  }, [state.host?.sessions, session]);
  const canCompose = session?.state === "starting" || session?.state === "ready";
  const currentComputer = state.host?.computers?.find(computer => computer.id === session?.computer);
  const newConversation = useNewConversation({ host: state.host, session, current: currentComputer,
    created: key => { setSelected(key); setSidebar(false); setPanel(undefined); } });
  // The selected conversation's computer, while its conversations have not arrived: a loading view, not the empty
  // Welcome page, which looked as if there were no conversations. An offline computer says so instead.
  const selectedComputer = !session && selected.includes(":") ? state.host?.computers?.find(computer => computer.id === selected.slice(0, selected.indexOf(":"))) : undefined;
  const waiting = selectedComputer && !selectedComputer.loaded
    ? isOffline(selectedComputer) ? <div className="welcome"><div className="welcome-mark">π</div><h1>{selectedComputer.name} is offline</h1>
        <p>This conversation opens when {selectedComputer.name} is back online.</p></div>
      : <div className="welcome"><Loading label={`Loading this conversation from ${selectedComputer.name}…`} /></div>
    : !session && state.host?.computers?.length && state.host.computers.every(computer => !computer.loaded) && !state.host.computers.every(isOffline)
      ? <div className="welcome"><Loading label="Connecting to your computers…" /></div> : undefined;
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
  /** The conversation whose earlier process is being stopped so it can open. */
  const [stoppingOld, setStoppingOld] = useState<string>();
  const confirmationContext = session ? `${currentComputer?.name ?? "This computer"} · ${conversationTitle(session)}` : "";
  const visibleViews = panelViews(ui?.views ?? [], focusedView);
  const settings = panel === "settings" || panel === "view" && visibleViews[0]?.surface === "settings";
  const planView = (ui?.views ?? []).find(view => view.id === "plan" && view.kind === "details" && !view.scope);
  const headerPlan = !phone && !!planView && !!(planView.data as UiDetails).items?.length ? planView : undefined;
  const messagesView = (ui?.views ?? []).find(view => view.id === "messages" && !view.scope && (view.data as UiDetails | null)?.items?.length);
  const settingsViews = (ui?.views ?? []).filter(view => view.surface === "settings" && !view.scope);
  const agentViews = (ui?.views ?? []).filter(view => view.kind === "conversation");
  const activeAgents = agentViews.filter(view => (view.data as UiConversation).active).length;
  const { historyView: agentHistory, total: totalAgents } = agentInventory(ui?.views ?? []);
  const chooseAgent = (id: string) => { setFocusedAgent(id); localStorage.setItem(`pi-desk:agent-selection:${selected}`, id); };
  const openAgentPane = (id?: string, history = false) => { if (id) chooseAgent(id); setAgentHistoryOpen(history); setPanel("agents"); };
  useEffect(() => { setFocusedAgent(localStorage.getItem(`pi-desk:agent-selection:${selected}`) ?? ""); }, [selected]);
  const settingsForms = (ui?.interactions ?? []).filter(interaction => interaction.settings);
  // Those Desk keeps while the conversation sleeps included: answering one reopens it.
  const questions = session ? openQuestions(session) : [];
  const settingsForm = settingsForms[0];
  const question = questions.find(question => question.id === activeQuestion) ?? questions[0];
  // A question asked without waiting leaves the agent working and the composer free (ask_user wait: false).
  const blockingQuestion = questions.find(item => !asksInBackground(item.form));
  const compactQuestion = useMedia("(max-width:760px), (max-height:600px)");
  const inlineQuestion = !settings && !compactQuestion && (question?.form.kind === "question" || question?.form.kind === "confirm");
  useEffect(() => {
    if (!questions.some(question => question.id === activeQuestion)) setActiveQuestion(questions[0]?.id ?? "");
  }, [questions, activeQuestion]);
  useEffect(() => {
    const pending = new Set(state.host?.sessions.flatMap(session =>
      [...session.ui?.interactions ?? [], ...openQuestions(session)].map(question => `${session.key}/${questionKey(question)}`)));
    for (const id of questionDrafts.current.keys()) if (!pending.has(id)) questionDrafts.current.delete(id);
  }, [state.host?.sessions]);
  useEffect(askForNotificationsOnFirstClick, []);
  useEffect(trackUse, []);
  useSeen(session);
  useFinishedBadge(state.host?.sessions);
  useQuestionAlerts(state.host?.sessions, selected, conversationTitle);
  useNoticeLinks(state.host?.sessions, key => { setSelected(key); setSidebar(false); setPanel(undefined); });
  useSharedTask(state.host, workspaceServer, key => { setSelected(key); setSidebar(false); setPanel(undefined); });
  const accountPanel = (args: string) => { setProviderHint(args || undefined); setSettingsSection("accounts"); setPanel("settings"); };
  const commandHandlers = deskCommandHandlers({ session, key: selected, command, delivery: deliveryMode,
    openSettings: section => { setSettingsSection(section); setPanel("settings"); },
    // /new from a conversation starts the next one with its model and reasoning.
    newConversation: folder => newConversation.open(undefined, folder, session?.snapshot?.model
      ? { model: `${session.snapshot.model.provider}/${session.snapshot.model.id}`, reasoning: session.snapshot.thinking ?? "" } : undefined), resume: setResumeOpen,
    editTitle: () => titleControl.current?.edit(), accounts: accountPanel,
    show: (title, text) => setCommandOutput({ title, text }) });
  const completion = useCommandCompletion(draft, deskCommandCatalog(session?.snapshot?.commands ?? [], commandHandlers), text => {
    setDraft(text); localStorage.setItem(draftKey(selected), text);
  });
  const messages = state.messages[selected] ?? emptyMessages;
  const { send, sending, outgoing, outgoingReceipts, inFlight } = useMessageSending({ selected, selectedRef, session, messages, connected, epoch, attachments, draft, setDraft, deliveryMode,
    controlBusy, extensionErrors, commandHandlers, command, confirmation, confirmationContext,
    show: (title, text) => setCommandOutput({ title, text }), delivered: () => setLatestRequest(value => value + 1), report: setError });
  // Reply buttons on shown work and changes quote them into the composer.
  useEffect(() => {
    const quoted = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text !== "string" || !selected) return;
      setDraft(current => {
        const next = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
        localStorage.setItem(draftKey(selected), next); return next;
      });
      requestAnimationFrame(() => { const input = composerInput.current; if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } });
    };
    window.addEventListener("pi-desk:quote", quoted);
    return () => window.removeEventListener("pi-desk:quote", quoted);
  }, [selected]);
  // The message box's recall of earlier messages (composer.tsx), kept across conversations.
  const recall = useRef<Recall | undefined>(undefined);
  const loadedWork = useMemo(() => workItems(messages), [messages]);
  const loadedLinks = useMemo(() => messageLinks(messages), [messages]);
  // The reply "What do I need to know?" covers: the latest one with something written in it.
  // The reply that ends the turn: the last message, when it is Pi's and has text (not a stopped turn's tool call).
  const latestReply = useMemo(() => {
    const last = [...messages].reverse().find(message => !message.feedback && ["assistant", "tool", "user"].includes(message.role));
    return last?.role === "assistant" && last.blocks.some(block => block?.type === "text" && !!block.text.trim()) ? last.id : undefined;
  }, [messages]);
  // "What do I need to know?": written in the background, so the conversation stays usable; it opens beside the
  // conversation when it is ready, and stays there for its reply. Kept by conversation and reply.
  const [briefs, setBriefs] = useState<Record<string, BriefState>>({});
  // "Move to another computer" (teleport): the conversation being moved, while its window is open, and the moves
  // under way, each shown under the computer it is going to until it arrives.
  const [moving, setMoving] = useState<MoveRequest>();
  const [moves, setMoves] = useState<{ id: string; title: string; computer: string }[]>([]);
  const startMove = (request: MoveRequest, target: string, folder: string) => {
    const id = crypto.randomUUID(), from = selectedRef.current;
    setMoving(undefined); setMoves(list => [...list, { id, title: request.title, computer: target }]);
    void api<{ key: string }>("/teleport/move", { computer: request.source.id, session: request.session, cwd: folder }, target).then(result => {
      // The moved conversation is shown if the one it moved from still is, or was until it stopped there (which leaves
      // nothing selected); not if Jordan went elsewhere meanwhile.
      if (selectedRef.current === from || !selectedRef.current) { setSelected(sessionKey(target, result.key)); setPanel(undefined); setSidebar(false); }
    }, failure => setMoving({ ...request, target, folder, error: `It did not move: ${errorText(failure)}` }))
      .finally(() => setMoves(list => list.filter(item => item.id !== id)));
  };
  const briefSlot = (reply: string) => `${selected}\n${reply}`;
  const briefWork = (state: BriefState): WorkItem | undefined => state.brief ? { id: `brief:${state.reply}`, at: state.brief.created, message: state.reply,
    block: { type: "brief", brief: state.brief, working: state.working, rewrite: () => writeBrief(state.reply, true) } } : undefined;
  // Every brief written here for this conversation's replies is listed beside it, not only the latest reply's.
  const briefItems = Object.entries(briefs).flatMap(([slot, state]) => slot.startsWith(`${selected}\n`) ? briefWork(state) ?? [] : []);
  // Each reply that ends a turn (before the next message from the user or an event, or last), with whether the turn,
  // from the user's message before it, changed files. These offer "What do I need to know?" and "Review the changes".
  const turns = useMemo(() => {
    const changing = new Set(loadedWork.filter(item => item.block.type === "diff" || item.block.type === "document").map(item => item.message));
    const ends = new Map<string, { changed: boolean; opening?: ChatMessage }>();
    const list = messages.filter(message => !message.feedback);
    let opening: ChatMessage | undefined, changed = false;
    list.forEach((message, index) => {
      if (message.role === "user") { opening = message; changed = false; return; }
      if (changing.has(message.id)) changed = true;
      const next = list[index + 1];
      // An earlier reply is named to the worker by its session entry; without one the worker would brief the latest.
      if (message.role === "assistant" && (!next || (next.role === "user" || next.role === "note") && !!message.entryId) && message.blocks.some(block => block?.type === "text" && !!block.text.trim()))
        ends.set(message.id, { changed, opening });
    });
    return ends;
  }, [messages, loadedWork]);
  function writeBrief(reply: string, refresh = false) {
    const key = selected, slot = briefSlot(reply), entry = messages.find(message => message.id === reply)?.entryId;
    if (briefs[slot]?.working) return;
    setBriefs(all => ({ ...all, [slot]: { ...all[slot], reply, working: true, error: undefined } }));
    command<{ result?: Brief }>({ kind: "brief", ...(entry && session?.workerRuntime?.briefReply ? { reply: entry } : {}), ...(refresh ? { refresh: true } : {}) }).then(({ result }) => {
      if (!result?.markdown) throw new Error("No brief came back.");
      setBriefs(all => ({ ...all, [slot]: { reply, working: false, brief: result } }));
      if (selectedRef.current === key) openWork({ id: `brief:${reply}`, at: result.created, message: reply, block: { type: "brief", brief: result } });
    }).catch(failure => {
      setBriefs(all => ({ ...all, [slot]: { ...all[slot], reply, working: false, error: errorText(failure) } }));
      if (selectedRef.current === key) setError(`The brief could not be written: ${errorText(failure)}`);
    });
  }
  /** Opens a reply's brief, written here before, or writes it; a brief kept in the conversation comes back without a new one being written. */
  function openBrief(reply: string) {
    const state = briefs[briefSlot(reply)], item = state && !state.working ? briefWork(state) : undefined;
    if (item) openWork(item); else writeBrief(reply);
  }
  // "Review the changes": offered when the turn changed files; the request goes in as a message of its own. An
  // earlier turn is named by its first and last messages, since "your last turn" would be another one.
  async function requestReview(reply: string) {
    if (!session?.activation) return;
    const excerpt = (message?: ChatMessage) => {
      const text = (message?.blocks ?? []).flatMap(block => block?.type === "text" ? [block.text] : []).join(" ").replace(/\s+/g, " ").trim();
      return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    };
    const turn = turns.get(reply), last = messages.find(message => message.id === reply);
    const text = reply === latestReply ? REVIEW_REQUEST : `Use the code-review skill to review the changes you made in the turn that ${turn?.opening ? `began with my message "${excerpt(turn.opening)}" and ` : ""}ended with your reply "${excerpt(last)}". Review the code as it is now. Check each finding against the code before you report it, and don't change anything yet.`;
    try {
      await api(`/sessions/${selected}/inputs`, { id: crypto.randomUUID(), activation: session.activation, generation: session.ui?.generation,
        command: { kind: "prompt", text } });
    } catch (error) { setError(errorText(error)); }
  }
  const paneItems = [...workExtra && !loadedWork.some(item => item.id === workExtra.id) ? [workExtra, ...loadedWork] : loadedWork, ...briefItems];
  const workSeen = useRef<{ session: string; opened: number; ids: Set<string> }>({ session: "", opened: 0, ids: new Set() });
  const hideWork = (hidden: boolean) => { setWorkHidden(hidden); rememberWorkHidden(selected, hidden); };
  useEffect(() => {
    // Updating or rearranging an existing part does not reopen Work or steal selection.
    const seen = workSeen.current;
    if (seen.session !== selected) {
      workSeen.current = { session: selected, opened: Date.now(), ids: new Set(loadedWork.map(item => item.id)) };
      setWorkSelected(undefined); setWorkExtra(undefined); setMobileWorkOpen(false); setWorkHidden(workHiddenFor(selected)); return;
    }
    const added = loadedWork.filter(item => !seen.ids.has(item.id));
    for (const item of loadedWork) seen.ids.add(item.id);
    const newest = added.at(-1);
    if (newest) {
      setWorkSelected(newest.id);
      // Only a result shown since the conversation was opened here reopens Work; its earlier ones load in after opening
      // it. Times come from the conversation's computer, so a few seconds of clock difference are allowed.
      if (newest.block.type === "shown" && newest.at > seen.opened - 5000) hideWork(false);
    }
  }, [selected, loadedWork]);
  const showWorkPane = !homeSelected && (wideWorkspace || mobileWorkOpen) && !!session && !workHidden && paneItems.length + loadedLinks.length > 0 && (!panel || settings);
  useEffect(() => {
    if (panel === "view" && focusedView === "subagents") setPanel("agents");
    if (panel === "view" && agentViews.some(view => view.id === focusedView)) { chooseAgent(focusedView); setPanel("agents"); }
    const activation = `${selected}:${session?.activation}`;
    if (activeAgents && autoAgents.current !== activation) {
      autoAgents.current = activation;
      // Working agents open beside the conversation wherever the panel fits beside it (not as a dialog) and that
      // side is free: no other panel, and no changes shown there.
      if (!panel && !showWorkPane && !document.activeElement?.matches("input,textarea,[contenteditable=true]")
        && matchMedia("(min-width:1181px)").matches) setPanel("agents");
    }
  }, [panel, focusedView, activeAgents, selected, session?.activation, ui, showWorkPane]);
  useEffect(() => {
    if (workModal?.id.startsWith("part:") && !loadedWork.some(item => item.id === workModal.id)) setWorkModal(undefined);
  }, [loadedWork, workModal]);
  const openWork = (item: WorkItem) => {
    if (item.id.startsWith("part:") && !loadedWork.some(known => known.id === item.id)) { setWorkModal({ ...item, id: `history:${item.message}` }); return; }
    if (wideWorkspace && !homeSelected) {
      // A brief is listed from its own state, which a copy here would leave behind.
      if (item.block.type !== "brief" && !loadedWork.some(known => known.id === item.id)) setWorkExtra(item);
      setWorkSelected(item.id); hideWork(false);
      if (panel && !settings) setPanel(undefined);
    } else setWorkModal(item);
  };
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
    if (panel !== "view" || !focusedView) return;
    const card = [...document.querySelectorAll<HTMLElement>("[data-view]")].find(element => element.dataset.view === focusedView);
    card?.scrollIntoView({ block: "start" });
  }, [panel, focusedView, selected]);
  const settingBusy = controlBusy || sending || closing || !!blockingQuestion || !!settingsForms.length || session?.snapshot?.activity === "waiting"
    || !!session?.inputs?.some(input => input.state === "sending") || !!ui?.views.some(view => !view.scope && view.working);
  const contextFrom = session?.snapshot?.contextFrom, compactControl = controls.find(control => control.kind === "compact" && control.state === "running");
  // Workers before 0.5.42 report only manual compaction, as a running control.
  const compacting = session?.snapshot?.compacting ?? (compactControl ? { reason: "manual" as const, started: compactControl.started } : undefined);
  const [stoppingCompaction, setStoppingCompaction] = useState(false);
  const busy =
    controlBusy ||
    session?.snapshot?.activity === "running" ||
    session?.snapshot?.activity === "waiting" ||
    !!session?.inputs?.some(input => input.state === "sending") ||
    !!blockingQuestion;
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
    const stored = localStorage.getItem(draftKey(selected)) ?? "";
    setDraft(inFlight(selected, stored) ? "" : stored);
    setState(previous => ({ ...previous, focused: [selected] }));
    localStorage.setItem("pi-desk:selected", selected);
  }, [selected]);

  async function command<T = unknown>(command: WorkerCommand, id: string = crypto.randomUUID()) {
    if (!session?.ui) throw new Error("Session is still starting.");
    return api<T>(`/sessions/${selected}/command`, {
      id,
      generation: session.ui.generation,
      command,
    });
  }
  /** Answers a question the conversation's process asks, or one Desk keeps while it has none, which needs no generation. */
  function answerQuestion(id: string, answer: UiAnswer | null) {
    return api(`/sessions/${selected}/command`, { id: crypto.randomUUID(), generation: session?.ui?.generation, command: { kind: "answer", id, answer } });
  }
  const run = (command: WorkerCommand) => {
    void commandPromise(command);
  };
  /** A waiting message taken out of Pi's queue comes back to the message box, whole, unless something is being written there. */
  async function cancelWaiting(queue: "steering" | "followUp", index: number, preview: string) {
    try {
      const reply = await command<{ result?: { text?: string } | null }>({ kind: "queue_cancel", queue, index, text: preview });
      const text = reply?.result?.text ?? preview;
      if (!draft.trim()) { setDraft(text); localStorage.setItem(draftKey(selected), text); }
    } catch (error) { setError(errorText(error)); }
  }
  async function commandPromise(value: WorkerCommand) {
    try {
      await command(value);
    } catch (error) {
      setError(`${errorText(error)}${isControl(value) ? " Check Recent operations in Settings before trying again." : ""}`);
    }
  }
  /** Rewind to a message in place: before your message (back in the composer to edit), or to a reply. History is kept as a branch. */
  async function rewind(message: ChatMessage) {
    if (!message.entryId) return;
    const user = message.role === "user";
    const text = user && !message.blocks.some(block => block?.type === "text" && block.truncated)
      ? splitDictationNote(message.blocks.flatMap(block => block?.type === "text" ? [block.text] : []).join("\n\n")).text.trim() : undefined;
    if (!await confirmation.request({
      title: user ? "Rewind to before this message?" : "Rewind to this reply?", context: confirmationContext, accept: "Rewind", cancel: "Cancel",
      body: <><p>{user ? "The conversation goes back to just before this message, and the message returns to the composer to edit or send again."
        : "The conversation continues from this reply."} Everything after it stays in the conversation's history as another branch.</p>
        {user && draft.trim() && <p>Your unsent draft is replaced.</p>}</>,
    })) return;
    try {
      await command({ kind: "navigate", entry: message.entryId, summarize: false });
      if (text !== undefined && selectedRef.current === selected) { setDraft(text); localStorage.setItem(draftKey(selected), text); composerInput.current?.focus({ preventScroll: true }); }
    } catch (error) { setError(errorText(error)); }
  }
  /** Stops the process that holds this conversation without answering, once the user agrees, and opens it. */
  async function stopAndOpen() {
    if (!session || !connected) return;
    const key = session.key;
    if (!await confirmation.request({ title: "Stop the earlier process?", context: confirmationContext, accept: "Stop and open",
      body: <p>Desk stops the process that still holds this conversation, then opens it again. Whatever it was in the middle of is lost,
        such as a reply being written. Its saved messages stay.</p> })) return;
    setStoppingOld(key);
    try { await api(`/sessions/${key}/restart`, { takeover: true, stop: true }); }
    catch (error) { setError(errorText(error)); }
    finally { setStoppingOld(current => current === key ? undefined : current); }
  }
  async function restartSession() {
    if (!session || !connected) return;
    try {
      await api(`/sessions/${session.key}/restart`, { takeover: true });
    } catch (error) { setError(errorText(error)); }
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
  return (
    <WorkFocus.Provider value={openWork}><RewindContext.Provider value={{ rewind: session && connected && !busy && !closing ? message => void rewind(message) : undefined }}><BriefContext.Provider value={{
      // Offered while Pi is idle: a brief is saved in the conversation, and a review is a message of its own.
      ...(!busy && session?.snapshot?.activity === "idle" && connected && !closing ? {
        latest: latestReply, turns,
        // Older workers brief only the latest reply.
        open: session?.ui && session.workerRuntime?.brief ? (reply: string) => { if (reply === latestReply || session.workerRuntime?.briefReply) openBrief(reply); } : undefined,
        earlier: !!session?.workerRuntime?.briefReply,
        review: session?.activation ? (reply: string) => void requestReview(reply) : undefined,
      } : {}),
      // The snapshot names the latest reply's brief by its session entry; transcript messages carry that as "entry:<id>".
      state: (reply: string) => {
        const state = briefs[briefSlot(reply)];
        return state?.working ? "writing" : state?.brief || reply === latestReply && session?.snapshot?.brief && latestReply === `entry:${session.snapshot.brief}` ? "ready" : undefined;
      } }}><div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <DeskStatusBar />
      <Sidebar open={sidebar} close={() => setSidebar(false)} host={host} connected={connected} transportConnected={transportConnected}
        selected={selected} sending={sending} select={key => { setSelected(key); setSidebar(false); setPanel(undefined); }}
        newConversation={newConversation.open} resume={() => { setResumeOpen(true); setSidebar(false); }}
        openSettings={section => { setSettingsSection(section); setPanel("settings"); setSidebar(false); }}
        move={setMoving} moves={moves} report={setError} closed={key => { if (selectedRef.current === key) setPanel(undefined); }} />
      <main className={`main${homeSelected ? " main-home" : ""}`} data-primary-focus tabIndex={-1}>
        {homeSelected ? <Home host={host} connected={connected} openNavigation={() => setSidebar(true)}
          openConversation={(key, view) => { setSelected(key); setSidebar(false); setPanel(view ? "view" : undefined); if (view) setFocusedView(view); }} /> : <>
        <header className="topbar">
          <Banner session={session} className="topbar-picture" />
          <button
            className="icon-button mobile-nav"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            ☰
          </button>
          {(() => {
            const name = session ? <ConversationTitle key={`${session.key}:${session.activation}`} title={conversationTitle(session)}
              disabled={!connected || session.state !== "ready" || closing}
              control={titleControl} rename={name => command({ kind: "name", name })} /> : <strong>{waiting ? "" : "Welcome"}</strong>;
            return headerPlan ? <PlanHeader view={headerPlan} title={name} disabled={!connected || closing}
              invoke={action => run({ kind: "action", view: headerPlan.id, revision: headerPlan.revision, action: action.id })} />
              : <div className="conversation-heading">
                {phone && <span>{session ? `${currentComputer ? `${currentComputer.name} · ` : ""}${folderName(session.cwd)}` : "Pi Desk"}</span>}
                {name}
              </div>;
          })()}
          <div className="top-actions">
            {session && <span className="conversation-activity" title={activityLabel(sessionActivity(session))}>
              <span className={`status-dot ${sessionActivity(session)}`} /><span>{activityLabel(sessionActivity(session))}</span>
            </span>}
            {!phone && !homeSelected && session?.workerRuntime?.learn && <button type="button" className={`header-chip${session.snapshot?.learn?.enabled ? " selected" : ""}`}
              aria-pressed={!!session.snapshot?.learn?.enabled} aria-label="Learn mode" disabled={!connected || session.state !== "ready" || controlBusy}
              title={`Learn mode${session.snapshot?.learn?.writing ? ": writing an explanation…" : session.snapshot?.learn?.enabled ? ": on" : ""}. Explains the theory behind recent work outside the agent’s context. Uses extra model calls.`}
              onClick={() => run({ kind: "learn", enabled: !session.snapshot?.learn?.enabled })}>
              <Icon name="learn" /></button>}
            {!phone && (totalAgents > 0 || agentHistory) && <button type="button" className={`header-chip${panel === "agents" ? " selected" : ""}`} aria-pressed={panel === "agents"}
              title={`${activeAgents} active · ${totalAgents} total`} onClick={() => setPanel(panel === "agents" ? undefined : "agents")}>
              <span className={`status-dot ${activeAgents ? "running" : "idle"}`} />Agents <b>{totalAgents}</b></button>}
            {messagesView && <button type="button" className={`header-chip${panel === "view" && focusedView === "messages" ? " selected" : ""}`}
              aria-label={`Messages: ${(messagesView.data as UiDetails).items!.length}`}
              title={(messagesView.data as UiDetails).summary ?? "Agent messages"} onClick={() => { setFocusedView("messages"); setPanel(panel === "view" && focusedView === "messages" ? undefined : "view"); }}>
              <Icon name="party" />{!phone && "Messages "}<b>{(messagesView.data as UiDetails).items!.length}</b></button>}
            {paneItems.length + loadedLinks.length > 0 && !homeSelected && <button type="button" className="icon-button"
              title={showWorkPane ? "Hide Work" : "Show Work"} aria-label="Work" aria-pressed={showWorkPane}
              onClick={() => { const hidden = showWorkPane; setMobileWorkOpen(!hidden); hideWork(hidden); if (!hidden && panel && !settings) setPanel(undefined); }}>
              <Icon name="panel-right" /></button>}
            <button type="button" className="icon-button" title="Conversation settings" aria-label="Conversation settings" aria-pressed={settings}
              onClick={() => {
                if (settings) { setPanel(undefined); return; }
                if (session && !["conversation", "context", "tools", "activity"].includes(settingsSection)) setSettingsSection("conversation");
                setPanel("settings");
              }}><Icon name="settings" /></button>
            {phone && session?.activation && <CloseConversationButton icon session={session} name={conversationTitle(session)}
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
        {connected && currentComputer && currentComputer.connection !== "connected" && <div className="connection-banner" role="status">
          {currentComputer.name}: {connectionLabel(currentComputer)}. What you do now waits for the connection, for up to two minutes.</div>}
        <ViewPreviews views={(ui?.views ?? []).filter(view => !view.scope && (phone || view.id !== "plan"))} open={id => { setFocusedView(id); setPanel("view"); }} />
        {phone && (totalAgents > 0 || agentHistory) && <button type="button" className={`agent-activity-bar${panel === "agents" ? " selected" : ""}`}
          aria-expanded={panel === "agents"} onClick={() => setPanel(panel === "agents" ? undefined : "agents")}>
          <strong>Agents</strong><span>{activeAgents} active · {totalAgents} total</span><span>View →</span>
        </button>}
        {session && <VersionBanner key={`${selected}:version`} session={session} computer={currentComputer ?? { name: host.name, release: host.release, updates: host.updates }} busy={busy || !connected} report={setError} />}
        {session && <ControlActivity key={`${selected}:controls`} session={selected} controls={controls.filter(control => control !== compactControl)} />}
        {session?.state === "ready" && extensionErrors.length > 0 && <div className="connection-banner" role="alert">
          <span>Pi could not load {extensionErrors.length === 1 ? "an extension" : "some extensions"}. Retry loading before sending messages. Your conversation is retained; this does not resend your last message.</span>
          <button disabled={!connected || controlBusy || !["idle", "error"].includes(session.snapshot?.activity ?? "")}
            onClick={() => run({ kind: "reload" })}>{controlBusy ? "Loading…" : "Retry loading"}</button>
        </div>}
        {session && !canCompose && <PendingInputs key={`${selected}:inputs`} session={session} connected={connected} report={setError} />}
        {session && !canCompose && (
          <div className="connection-banner">
            {/* Asleep: closed and kept with something to wake it; Desk reopens it then. */}
            <span>{session.state === "closed" && session.kept && (session.wakes || session.watching)
              ? `Asleep: Desk reopens it ${[session.wakes && wakeLabel(session.wakes).replace(/^Wakes /, "at "), session.watching && "when a watch has news",
                questions.length && "when you answer its question"].filter(Boolean).join(" or ")}. Open it to read or carry on.`
              : session.unresponsive ? "Its earlier process is still running but doesn't answer, so Desk won't open a second one beside it."
              : "Pi is not running. Resume to continue."}
              {session.state === "closed" && session.kept && session.waiting && <ul className="sleep-waiting">{session.waiting.map((item, index) =>
                <li key={index}><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}</li>)}</ul>}</span>
            {session.state === "closed" && session.kept && <ResumeModel sessions={host.sessions} session={session} disabled={!connected}
              change={choice => void api(`/sessions/${session.key}/restart`, { takeover: true, setup: choice, sleep: true }).catch(error => setError(errorText(error)))} />}
            {session.unresponsive && <button disabled={!connected || stoppingOld === session.key} onClick={() => void stopAndOpen()}>
              {stoppingOld === session.key ? "Stopping…" : "Stop it and open"}</button>}
            <button disabled={!connected || stoppingOld === session.key} onClick={() => void restartSession()}>
              {session.state === "closed" && session.kept ? "Open" : session.unresponsive ? "Try again" : session.file ? "Resume" : "Retry"}</button>
          </div>
        )}
        {host.directoryError && <div className="connection-banner" role="status">{host.directoryError}</div>}
        <TranscriptView key={`${selected}/${session?.ui?.generation ?? ""}`}
          session={selected} generation={session?.ui?.generation ?? ""}
          connected={connected && (session?.state === "ready" || session?.state === "starting" && !!session.historyReady
            // Not running, its saved messages are read from its file.
            || (session?.state === "closed" || session?.state === "failed") && !!session.file && readsStopped(currentComputer ?? host))} epoch={epoch}
          messages={messages} onLatest={storeHistory} latestRequest={latestRequest}
          overlay={session && compacting && <CompactionOverlay key={`${selected}:${compacting.started}`} compacting={compacting} context={session.snapshot?.context}
            stopping={stoppingCompaction || !connected} stop={() => { setStoppingCompaction(true); void commandPromise({ kind: "abort" }).finally(() => setStoppingCompaction(false)); }} />}
          renderMessage={(message, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected}
            summarised={contextFrom !== undefined && message.order < contextFrom} contextStart={message.order === contextFrom} />}
          empty={waiting ??
              <div className="welcome">
                <div className="welcome-mark">π</div>
                {session && <div className="eyebrow">{folderName(session.cwd)}</div>}
                <h1>
                  {session && !canCompose ? "Pi is not running"
                    : session?.reconnecting ? "Reconnecting to Pi…"
                    : session?.state === "starting" ? closing ? "Closing this conversation…" : controlBusy ? "Updating this conversation…" : "Opening this conversation…"
                    : session ? "New conversation" : "No conversation open"}
                </h1>
                {session && !canCompose && <p>{session.error || (session.file ? "Resume to carry on. Nothing has been resent." : "Resume Pi to load this conversation. Nothing has been resent.")}</p>}
                {!session && (
                  <button className="primary" onClick={() => newConversation.open()}>
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
            {outgoing.map(item => <div key={item.id} className="message-outgoing"><Message message={item.message} sessionKey={selected} /></div>)}
            {busy && (
              <div className="activity-line">
                <span className="pulse-dot" />
                {blockingQuestion ? "Waiting for your answer" : session?.reconnecting ? "Reconnecting to Pi…" : session?.state === "starting" ? "Loading Pi…" : "Pi is working…"}
              </div>
            )}</>}
        />
        {question && inlineQuestion && <InteractionForm inline key={`${selected}/${question.id}`} draftKey={`${selected}/${questionKey(question)}`}
          interaction={question} questions={questions} choose={id => { setActiveQuestion(id); setDismissedQuestion(""); }} drafts={questionDrafts.current}
          close={() => setDismissedQuestion(`${selected}/${question.id}`)} answer={answer => answerQuestion(question.id, answer)} />}
        {session && canCompose && (
          <div className="composer-dock">
            <PendingInputs key={`${selected}:inputs`} session={session} connected={connected} report={setError} shown={outgoingReceipts} />
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
            {session.snapshot && <NativeQueue key={selected} session={session.key} queue={session.snapshot.queue}
              edit={connected && session.state === "ready" && session.workerRuntime?.queueEdit
                ? async (queue, id, change) => {
                  const reply = await command<{ result: { text: string } }>(change
                    ? { kind: "queue_edit", queue, id, ...change } : { kind: "queue_read", queue, id });
                  return reply.result.text;
                } : undefined}
              keep={text => { const next = draft.trim() ? `${draft}\n\n${text}` : text; setDraft(next); localStorage.setItem(draftKey(selected), next); }}
              sendNow={connected && session.state === "ready" && session.workerRuntime?.queueNow
                ? (queue, index, text) => { setLatestRequest(value => value + 1); run({ kind: "queue_now", queue, index, text }); } : undefined}
              cancel={connected && session.state === "ready" && session.workerRuntime?.queueCancel
                ? (queue, index, text) => void cancelWaiting(queue, index, text) : undefined} />}
            <Composer session={session} selected={selected} selectedRef={selectedRef} composerInput={composerInput} recall={recall} messages={messages}
              draft={draft} setDraft={setDraft} attachments={attachments} completion={completion} deliveryMode={deliveryMode} setDeliveryMode={setDeliveryMode}
              send={send} command={command} run={run} commandPromise={commandPromise} busy={busy} controlBusy={controlBusy} settingBusy={settingBusy}
              connected={connected} closing={closing} sending={sending} controls={controls} extensionErrors={extensionErrors}
              computer={currentComputer?.name ?? state.host.name} dictation={dictationComputer(state.host?.computers, session?.computer, state.host?.dictation)}
              accounts={accountPanel} history={() => { setSettingsSection("conversation"); setPanel("settings"); }}
              openView={view => { setPanel("view"); setFocusedView(view.id); }} report={setError} />

          </div>
        )}
        </>}
      </main>

      {showWorkPane && <WorkPane items={paneItems} links={loadedLinks} selected={workSelected} select={setWorkSelected} expand={setWorkModal} session={selected}
        close={() => { setMobileWorkOpen(false); hideWork(true); }} />}
      {panel && (
        <Inspector settings={settings} className={panel === "agents" ? "agents-panel" : panel === "view" && focusedView === "plan" ? "plan-panel" : ""} title={settings ? "Settings" : panel === "agents" ? "Agents" : visibleViews[0]?.title ?? "Details"}
          close={() => setPanel(undefined)}>
          <div className="panel-title">
            <h2 data-surface-heading tabIndex={-1}>
              {settings ? "Settings" : panel === "agents" ? "Agents" : visibleViews[0]?.title ?? "Details"}
            </h2>
            <button
              className="icon-button"
              aria-label="Close panel"
              onClick={() => setPanel(undefined)}
            >
              ×
            </button>
          </div>
          <SettingsLayout enabled={settings} active={panel === "view" ? focusedView : settingsPage(settingsSection)}
            groups={settingsGroups({ session: session ? conversationTitle(session) : undefined, computer: currentComputer?.name ?? host.name,
              views: settingsViews.map(view => ({ id: view.id, title: view.title })) })}
            choose={id => {
              if (settingsViews.some(view => view.id === id && !MERGED_VIEWS.has(view.id))) { setFocusedView(id); setPanel("view"); }
              else { setSettingsSection(id); setPanel("settings"); }
            }}>

          {panel === "agents" && session && <AgentPane key={`${selected}:agents`} session={session} views={agentViews}
            history={agentHistory} historyInitiallyOpen={agentHistoryOpen}
            context={`${currentComputer?.name ?? host.name} · ${conversationTitle(session)}`}
            focused={focusedAgent} choose={chooseAgent} connected={connected && !closing} epoch={epoch} messages={state.messages}
            onLatest={storeHistory} renderMessage={(message, source, results, thinking, traceContinues) => <Message message={message} results={results} thinking={thinking} traceContinues={traceContinues} sessionKey={selected} source={source} />}
            answer={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
            openView={id => { setFocusedView(id); setPanel("view"); }} />}
          {panel === "view" &&
            (visibleViews.length ? (
              visibleViews.map(view => <ViewCard key={view.id} view={view} session={selected} generation={ui!.generation} connected={connected}
                closing={closing} epoch={epoch} messages={state.messages} onLatest={storeHistory} run={run} openAgents={() => openAgentPane(undefined, true)} />)
            ) : (
              <p className="muted">This view is unavailable. Reopen it from this session's controls.</p>
            ))}
          {panel === "settings" && <SettingsContent section={settingsSection} host={host} account={account}
            session={session} computer={currentComputer} connected={connected} busy={busy || sending || controlBusy} settingBusy={settingBusy} providerHint={providerHint}
            invoke={command}
            move={session && currentComputer?.teleport && (session.agentId ?? session.snapshot?.id)
              ? () => setMoving({ source: currentComputer, session: (session.agentId ?? session.snapshot?.id)!, title: conversationTitle(session), cwd: session.cwd }) : undefined}
            restore={(target, text) => { if (selectedRef.current === target) setDraft(text); }} />}
          </SettingsLayout>
        </Inspector>
      )}
      {resumeOpen && <ResumeConversation computers={host.computers} connected={transportConnected} cwd={host.cwd}
        current={session} close={() => setResumeOpen(false)} selected={key => {
          setSelected(key); setResumeOpen(false); setPanel(undefined); setSidebar(false);
        }} switchTo={resumeOpen === "switch" ? async file => { await command({ kind: "switch", file }); setResumeOpen(false); } : undefined} />}
      {/* A settings control's follow-up form (an extension's menu or prompt). Pi waits for it, so closing the dialog cancels it. */}
      {settingsForm && <InteractionForm key={`${selected}/${settingsForm.id}`} interaction={settingsForm} draftKey={`${selected}/${settingsForm.id}`}
        drafts={questionDrafts.current} disabled={!connected || closing}
        close={() => { void command({ kind: "answer", id: settingsForm.id, answer: null }).catch(() => undefined); }}
        answer={answer => command({ kind: "answer", id: settingsForm.id, answer })} />}
      {moving && <MoveConversation request={moving} computers={state.host?.computers ?? []} close={() => setMoving(undefined)}
        start={(target, folder) => startMove(moving, target, folder)} />}
      {commandOutput && <Modal title={commandOutput.title} close={() => setCommandOutput(undefined)}>
        <pre className="command-output">{commandOutput.text}</pre>
      </Modal>}
      {newConversation.dialog}
      {confirmation.dialog}
      {workModal && <WorkModal item={paneItems.find(item => item.id === workModal.id) ?? workModal} session={selected} close={() => setWorkModal(undefined)} />}
      {question && !inlineQuestion && `${selected}/${question.id}` !== dismissedQuestion && (
        <InteractionForm
          key={`${selected}/${question.id}`}
          draftKey={`${selected}/${questionKey(question)}`}
          owner={`${currentComputer ? `${currentComputer.name} · ` : ""}${session ? conversationTitle(session) : ""}`}
          interaction={question}
          questions={questions}
          choose={id => { setActiveQuestion(id); setDismissedQuestion(""); }}
          drafts={questionDrafts.current}
          close={() => setDismissedQuestion(`${selected}/${question.id}`)}
          answer={answer => answerQuestion(question.id, answer)}
        />
      )}
    </div></BriefContext.Provider></RewindContext.Provider></WorkFocus.Provider>
  );
}

document.documentElement.dataset.theme =
  localStorage.getItem("pi-desk:theme") ?? "light";
applyTextFont(textFont());

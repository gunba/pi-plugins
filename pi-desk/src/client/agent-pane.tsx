import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { UiAction, UiConversation, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import type { ChatMessage, HistoryPage, SessionView, ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { api } from "./connection.ts";
import { useConfirmation } from "./confirmation.tsx";
import { composerKey, deliveryPreferenceKey, readDelivery, type Delivery } from "./composer-keys.ts";
import { DeliveryControl } from "./delivery-control.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { ViewPreviews } from "./view-previews.tsx";
import { transcriptKey, type CachedMessage } from "./state.ts";
import { agentInventory, type AgentRow } from "./agent-inventory.ts";
import { reportDeskError } from "./desk-status.ts";
import { WorkspaceActions } from "./workspace-actions.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { Icon } from "./icons.tsx";
import { activityLabel } from "./activity.ts";
import { SettingControl } from "./settings-controls.tsx";
import { useMedia } from "./surfaces.tsx";

const data = (view: ViewSnapshot) => view.data as UiConversation;
const empty: CachedMessage[] = [];
type Receipt = { id: string; activation: string; generation: string; command: WorkerCommand };

export function AgentPane({ session, context, views, history, historyInitiallyOpen = false, focused, choose, connected, epoch, messages, onLatest, renderMessage, answer, openView }: {
	context: string;
	session: SessionView; views: ViewSnapshot[]; history?: ViewSnapshot; historyInitiallyOpen?: boolean;
	focused: string; choose: (id: string) => void; connected: boolean; epoch: number;
	messages: Record<string, CachedMessage[]>; onLatest: (source: string | undefined, page: HistoryPage) => void;
	renderMessage: (message: ChatMessage, source: string, results: Record<string, ChatMessage>, thinking?: ChatMessage[], traceContinues?: boolean) => ReactNode; answer: (id: string) => void;
	openView: (id: string) => void;
}) {
	// Beside the conversation the list stays in view; as an overlay on a narrow screen it folds away while writing.
	const narrow = useMedia("(max-width: 1180px)");
	const [search, setSearch] = useState(""), [folded, setFolded] = useState(!historyInitiallyOpen && !!focused);
	const listing = !narrow || !folded;
	const [historyOpen, setHistoryOpen] = useState(historyInitiallyOpen), [opening, setOpening] = useState("");
	const [limitOpen, setLimitOpen] = useState(false);
	const requested = useRef(new Set<string>());
	const confirmation = useConfirmation(`${session.key}:${session.activation}:${session.ui?.generation}:${connected}`);
	const { current, history: previous, historyView, total } = agentInventory([...views, ...(history ? [history] : [])]);
	const selected = views.find(view => view.id === focused);
	const matches = (row: AgentRow) => `${row.title} ${row.subtitle ?? ""} ${row.status}`.toLowerCase().includes(search.toLowerCase());
	const currentRows = current.map(view => ({ id: view.id, title: view.title, subtitle: data(view).activity ?? data(view).subtitle, status: data(view).status, view }));
	const limitView = session.ui?.views.find(view => view.id === "agent-limit" && !view.scope);
	const slots = (historyView?.data as UiDetails | undefined)?.fields?.find(field => field.label === "Live agent slots")?.value;
	const manage = async (action: UiAction, value?: UiValue, view = historyView) => {
		if (!view || !session.ui || !connected || view.working) return;
		if (action.destructive && !await confirmation.request({ title: `${action.label}?`, context, accept: action.label,
			body: <p>Changes this conversation's agent launch settings. Existing agents keep their saved settings.</p> })) return;
		try { await api(`/sessions/${session.key}/command`, { id: crypto.randomUUID(), generation: session.ui.generation,
			command: { kind: "action", view: view.id, revision: view.revision, action: action.id, value } }); }
		catch (error) { reportDeskError(error); }
	};
	const open = async (row: AgentRow) => {
		choose(row.id); setFolded(true);
		if (row.view || !row.action || !historyView || !connected || !session.ui) return;
		requested.current.add(row.id); setOpening(row.id);
		try {
			await api(`/sessions/${session.key}/command`, { id: crypto.randomUUID(), generation: session.ui.generation,
				command: { kind: "action", view: historyView.id, revision: historyView.revision, action: row.action.id } });
		} catch (error) { reportDeskError(error); }
		finally { setOpening(""); }
	};
	useEffect(() => { setHistoryOpen(historyInitiallyOpen); }, [historyInitiallyOpen]);
	useEffect(() => { if (!focused && current.length) choose(current[0]!.id); }, [focused, current]);
	useEffect(() => {
		const row = previous.find(row => row.id === focused);
		if (!selected && row && connected && !requested.current.has(focused)) {
			requested.current.add(focused); void open(row);
		}
	}, [focused, selected, historyView, connected]);
	return <div className="agent-pane">
		<div className="agent-picker-heading">
			{narrow ? <button type="button" aria-expanded={listing} onClick={() => setFolded(listing)}><Icon name="layers" />Agents <span>{total}</span><span aria-hidden="true">{listing ? "⌃" : "⌄"}</span></button>
				: <strong>Agents <span>{total}</span></strong>}
			<span className="agent-parent" title={context}>{context}</span>
			{/* The limit is changed rarely; it opens from the slot count. */}
			{connected && slots && limitView ? <button type="button" className="agent-slots" aria-expanded={limitOpen} title="Live agent limit"
				onClick={() => setLimitOpen(!limitOpen)}>{slots} live slots</button>
				: <span className="muted">{connected ? slots ? `${slots} live slots` : `${current.length} current` : "Disconnected"}</span>}
			{listing && historyView && <WorkspaceActions view={historyView} disabled={!connected || !!historyView.working} invoke={action => void manage(action)} />}
		</div>
		{listing && limitOpen && limitView && (limitView.data as UiDetails).controls?.map(control => <SettingControl key={control.action.id} control={control}
			disabled={!connected || !!limitView.working} invoke={(action, value) => void manage(action, value, limitView)} />)}
		{listing && <div className="agent-picker">
			{total > 8 && <div className="agent-filter"><input aria-label="Find an agent" placeholder="Find an agent" value={search} onChange={event => setSearch(event.target.value)} /></div>}
			<AgentList rows={currentRows.filter(matches)} focused={focused} label="Current agents" empty="No active or queued agents." open={row => void open(row)} />
			{previous.length > 0 && <details className="agent-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
				<summary>Previous agents ({previous.length})</summary>
				{historyOpen && <AgentList rows={previous.filter(matches)} focused={focused} label="Previous agents" empty="No matching previous agents." open={row => void open(row)} />}
			</details>}
		</div>}
		{selected && session.ui ? <AgentConversation key={`${selected.id}:${session.ui.generation}`} session={session} context={context} view={selected}
			connected={connected} epoch={epoch} messages={messages} onLatest={onLatest} renderMessage={renderMessage} answer={answer} onEditing={() => setFolded(true)} openView={openView} />
			: <p className="muted">{opening ? "Opening saved history…" : focused ? "Choose an agent to open its saved history." : "Active agents appear here. Earlier work stays in Previous agents."}</p>}
		{confirmation.dialog}
	</div>;
}

const ROW = 32;
function AgentList({ rows, focused, label, empty, open }: {
	rows: AgentRow[]; focused: string; label: string; empty: string; open: (row: AgentRow) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => list.current, estimateSize: () => ROW, overscan: 3,
		getItemKey: index => rows[index]!.id });
	useEffect(() => { virtual.scrollToOffset(0); }, [rows.length]);
	return <div className="agent-list" ref={list} aria-label={label} style={{ height: `min(${Math.min(6 * ROW, Math.max(ROW, rows.length * ROW))}px, 24dvh)` }}>
		{!rows.length && <p className="muted">{empty}</p>}
		<div style={{ height: virtual.getTotalSize(), position: "relative" }}>
			{virtual.getVirtualItems().map(item => {
				const row = rows[item.index]!;
				return <button type="button" className={`agent-row${row.id === focused ? " selected" : ""}`} key={item.key}
					aria-pressed={row.id === focused} style={{ position: "absolute", top: 0, width: "100%", height: item.size, transform: `translateY(${item.start}px)` }}
					title={row.subtitle} onClick={() => open(row)}><span className={`status-dot ${row.status}`} /><strong>{row.title}</strong>
					<small>{row.subtitle}</small><span>{activityLabel(row.status)}</span></button>;
			})}
		</div>
	</div>;
}

function AgentConversation({ session, context, view, connected, epoch, messages, onLatest, renderMessage, answer, onEditing, openView }: {
	context: string;
	session: SessionView; view: ViewSnapshot; connected: boolean; epoch: number; messages: Record<string, CachedMessage[]>;
	onLatest: (source: string | undefined, page: HistoryPage) => void; renderMessage: (message: ChatMessage, source: string, results: Record<string, ChatMessage>, thinking?: ChatMessage[], traceContinues?: boolean) => ReactNode;
	answer: (id: string) => void;
	onEditing: () => void;
	openView: (id: string) => void;
}) {
	const item = data(view), source = item.transcript;
	const key = `pi-desk:agent-draft:${session.key}:${view.id}`, receiptKey = `${key}:receipt`;
	const [draft, setDraft] = useState(() => localStorage.getItem(key) ?? "");
	const [receipt, setReceipt] = useState<Receipt | undefined>(() => {
		try { return JSON.parse(localStorage.getItem(receiptKey) ?? "null") ?? undefined; } catch { return undefined; }
	});
	const [sending, setSending] = useState(false), [latest, setLatest] = useState(0), [facts, setFacts] = useState(false);
	const inFlight = useRef(false), live = useRef(true);
	const currentView = useRef(view); currentView.current = view;
	useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
	const confirmation = useConfirmation(`${session.key}:${session.activation}:${session.ui!.generation}:${view.id}:${connected}`);
	const actions = view.actions ?? [], messaging = actions.filter(action => action.input === "message");
	const primary = messaging.find(action => action.delivery === "steer") ?? messaging[0];
	const followup = messaging.find(action => action.delivery === "followUp");
	const questions = item.scope ? session.ui!.interactions.filter(question => question.scope?.id === item.scope) : [];
	const disabled = !connected || session.state !== "ready" || !!view.working || sending;
	const edit = (value: string) => { setDraft(value); localStorage.setItem(key, value); };
	const invoke = async (operation: Receipt) => {
		if (inFlight.current || !connected) return;
		inFlight.current = true; setSending(true);
		try {
			await api(`/sessions/${session.key}/command`, { id: operation.id, generation: operation.generation, command: operation.command });
			if (!live.current) return;
			localStorage.removeItem(receiptKey); setReceipt(undefined);
			const text = operation.command.kind === "action" ? operation.command.value : undefined;
			if (localStorage.getItem(key) === text) { localStorage.removeItem(key); setDraft(""); }
			setLatest(value => value + 1);
		} catch (error) { if (live.current) reportDeskError(error); }
		finally { inFlight.current = false; if (live.current) setSending(false); }
	};
	// "Send now" interrupts a conversation's own turn; an agent is steered instead.
	const [delivery, setDelivery] = useState<Delivery>(() => { const saved = readDelivery(localStorage); return saved === "now" ? "steer" : saved; });
	const busy = item.status === "running" || item.status === "working";
	const send = async (mode: Delivery) => {
		const action = mode === "followUp" ? followup ?? primary : primary;
		if (!action || disabled || inFlight.current || !draft.trim() || !session.activation) return;
		if (receipt && !await confirmation.request({ title: "Send as a new message?", context: `${context} · ${view.title}`, accept: "Send new message",
			body: <><p>The earlier delivery is not confirmed. Check this agent's transcript before sending again.</p><pre className="confirmation-preview">{draft.slice(0, 2000)}</pre></> })) return;
		if (!live.current || inFlight.current) return;
		const current = currentView.current;
		if (!current.actions?.some(candidate => candidate.id === action.id && candidate.input === "message")) {
			reportDeskError("This agent's controls changed. Check its current state before sending."); return;
		}
		const operation: Receipt = { id: crypto.randomUUID(), activation: session.activation, generation: session.ui!.generation,
			command: { kind: "action", view: view.id, revision: current.revision, action: action.id, value: draft } };
		try { localStorage.setItem(receiptKey, JSON.stringify(operation)); setReceipt(operation); await invoke(operation); }
		catch (error) { reportDeskError(error); }
	};
	const control = async (action: UiAction) => {
		if (disabled) return;
		if (action.destructive && !await confirmation.request({ title: `${action.label}?`, context: `${context} · ${view.title}`, accept: action.label,
			body: <p>Stops this agent's current work. Other agents keep running. Queued tasks stay saved.</p> })) return;
		if (!live.current) return;
		const current = currentView.current;
		if (!current.actions?.some(candidate => candidate.id === action.id)) { reportDeskError("This agent's controls changed."); return; }
		try { await api(`/sessions/${session.key}/command`, { id: crypto.randomUUID(), generation: session.ui!.generation,
			command: { kind: "action", view: view.id, revision: current.revision, action: action.id } }); }
		catch (error) { if (live.current) reportDeskError(error); }
	};
	return <div className="agent-conversation">
		<header className="agent-review-heading"><span className={`status-dot ${questions.length ? "waiting" : item.status}`} />
			<h3 title={view.title}>{view.title}</h3>
			<span className="agent-current-status">{questions.length ? "Needs input" : activityLabel(item.status)}{item.activity ? ` · ${item.activity}` : ""}</span>
			<button type="button" className="quiet-action" aria-expanded={facts} onClick={() => setFacts(!facts)}>Details</button>
			<ActionMenu actions={actions.filter(action => !action.input)} disabled={disabled} invoke={action => void control(action)} label="Agent controls" /></header>
		{facts && <div className="agent-facts"><p>{item.subtitle}</p>
			<dl className="detail-fields">{item.fields?.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
			{item.scope && <ViewPreviews views={session.ui!.views.filter(view => view.scope?.id === item.scope)} open={openView} />}
		</div>}
		{(item.error || view.actionError) && <p className="error-text" role="alert">{view.actionError || item.error}</p>}
		{view.working && <p className="muted" role="status">{view.working}…</p>}
		{questions.map(question => <button type="button" className="question-banner" key={question.id} onClick={() => answer(question.id)}>
			{question.form.title}<span>Answer →</span>
		</button>)}
		{source ? <TranscriptView key={source} session={session.key} source={source} generation={session.ui!.generation}
			connected={connected && session.state === "ready"} epoch={epoch} messages={messages[transcriptKey(session.key, source)] ?? empty}
			onLatest={onLatest} renderMessage={(message, results, thinking, traceContinues) => renderMessage(message, source, results, thinking, traceContinues)} latestRequest={latest} />
			: <p className="muted">This agent has no available transcript.</p>}
		{receipt && <div className="agent-receipt" role="status">
			<p>{sending ? "Confirming message admission…" : "Delivery is not confirmed. The draft is retained; check the transcript before sending again."}</p>
			<button type="button" disabled={disabled || receipt.activation !== session.activation} onClick={() => void invoke(receipt)}>Check delivery</button>
			<button type="button" disabled={sending} onClick={() => void (async () => {
				if (!await confirmation.request({ title: "Discard this draft?", context: `${context} · ${view.title}`, accept: "Discard draft",
					body: <p>This removes the local draft and delivery notice. It cannot cancel a message already accepted.</p> })) return;
				localStorage.removeItem(receiptKey); localStorage.removeItem(key); setReceipt(undefined); setDraft("");
			})()}>Discard draft</button>
		</div>}
		{(messaging.length > 0 || draft || receipt) && <form className="composer agent-composer"
			onFocus={() => { if (matchMedia("(max-width: 1180px)").matches) onEditing(); }}
			onSubmit={event => { event.preventDefault(); void send(delivery); }}>
			<textarea aria-label={`Message ${view.title}`} placeholder={primary ? `Message ${view.title}…` : "This agent cannot receive messages now"}
				value={draft} disabled={sending} rows={2} maxLength={1_000_000} onChange={event => edit(event.target.value)}
				onKeyDown={event => {
					const action = composerKey({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
						shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }, matchMedia("(pointer:fine)").matches, delivery);
					if (!action) return;
					event.preventDefault();
					if (action === "newline") {
						const editor = event.currentTarget, start = editor.selectionStart;
						edit(`${draft.slice(0, start)}\n${draft.slice(editor.selectionEnd)}`);
						requestAnimationFrame(() => editor.setSelectionRange(start + 1, start + 1));
					} else void send(action);
				}} />
			<div className="composer-controls"><div className="send-controls">
				{/* The main message box's send control and saved default; an agent has no "send now". */}
				<DeliveryControl value={delivery} scope={`${session.key}:${view.id}`} busy={busy} canSendNow={false} send={value => void send(value)}
					choose={value => { setDelivery(value); localStorage.setItem(deliveryPreferenceKey, value); }}
					disabled={disabled || !draft.trim() || !primary} />
			</div></div>
		</form>}
		{confirmation.dialog}
	</div>;
}

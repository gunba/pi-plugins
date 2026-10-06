import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { Modal } from "./surfaces.tsx";
import { DOT_FILE_COUNT, type DotInput, type DotMessage, type DotSnapshot, type DotUpload, type DotDownload, type DotSurfaceFrame, type DotSurfaceMode } from "../shared/dot.ts";
import { stageDotFiles, saveDotDownload } from "./dot-files.ts";
import { DotNativeView } from "./dot-native-view.tsx";
import { DotAccounts } from "./dot-accounts.tsx";
import type { Computer } from "./workspace.ts";
import { api, ApiError } from "./connection.ts";
import { dotOutboxKey, dotReservedFiles, enqueueDot, nextDotInput, pendingDotMessages, readDotOutbox, reconcileDotInput, reviewDotQueue, sameDotInput, type DotOutbox, type DotOutboxInput } from "./dot-outbox.ts";

const empty: DotSnapshot = { state: "disconnected", messages: [], inputs: [] };
const errorText = (error: unknown) => {
	const text = error instanceof Error ? error.message : String(error);
	if (/Session with given id not found|No session with given id/i.test(text)) return "The Dot connection was lost. Reconnect Dot.";
	return error instanceof ApiError && error.status === 404 ? "Update Desk on this computer to connect Dot." : text;
};
const storageKey = (computer?: string) => `pi-desk:dot:${computer ?? "local"}`;
const merge = (older: DotMessage[], newer: DotMessage[]) => [...new Map([...older, ...newer].map(message => [message.id, message])).values()]
	.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));

export function useDotConversation(computers: Computer[] | undefined, enabled: boolean) {
	const [chosen, setChosen] = useState(() => localStorage.getItem("pi-desk:dot-computer") ?? "");
	const computer = computers ? (computers.find(item => item.id === chosen) ?? computers.find(item => item.connected) ?? computers[0]) : undefined;
	const id = computer?.id, online = enabled && (!computers || !!computer?.connected);
	useEffect(() => { if (id && !chosen) { setChosen(id); localStorage.setItem("pi-desk:dot-computer", id); } }, [id, chosen]);
	const [view, setView] = useState<DotSnapshot>(empty);
	const [loaded, setLoaded] = useState(false);
	const supported = view.transport === "direct";
	const [older, setOlder] = useState<DotMessage[]>([]);
	const [before, setBefore] = useState<string>();
	const [outbox, setOutbox] = useState<DotOutbox>({ draft: "", inputs: [] });
	const outboxRef = useRef(outbox); outboxRef.current = outbox;
	const outboxLoaded = useRef(false), posting = useRef(new Set<string>());
	const draft = outbox.draft;
	const pending = outbox.inputs.find(input => input.dot === view.id && input.state !== "accepted" && !input.ignored);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(""), [pollError, setPollError] = useState("");
	const [loadingHistory, setLoadingHistory] = useState(false);
	const generation = useRef(0);
	const loadedComputer = useRef<{ id?: string } | undefined>(undefined);
	const loadedDot = useRef<string | undefined>(undefined), loadedConnection = useRef<string | undefined>(undefined);
	const selection = useRef(0), readSequence = useRef(0);
	const receive = (next: DotSnapshot) => {
		if (next.id !== loadedDot.current || next.connection !== loadedConnection.current) {
			loadedDot.current = next.id; loadedConnection.current = next.connection; setOlder([]); setBefore(undefined);
		}
		setView(next); setLoaded(true);
	};
	const commit = (next: DotOutbox) => {
		if (!outboxLoaded.current) return false;
		try { localStorage.setItem(dotOutboxKey(id), JSON.stringify(next)); }
		catch { setError("Dot messages could not be saved on this device. Your draft has not been sent."); return false; }
		outboxRef.current = next; setOutbox(next); return true;
	};
	const saveDraft = (text: string) => {
		const next = { ...outboxRef.current, draft: text };
		if (!commit(next)) { outboxRef.current = next; setOutbox(next); }
	};
	const settled = (input: DotInput) => {
		const previous = outboxRef.current.inputs.find(item => item.id === input.id);
		if (previous && !sameDotInput(previous, input)) return amend(input.id, { state: "unknown", error: "The delivery receipt belongs to different content or a different account. Review it before retrying." });
		return commit(reconcileDotInput(outboxRef.current, input));
	};
	const amend = (inputId: string, patch: Partial<DotOutboxInput>) => commit({ ...outboxRef.current,
		inputs: outboxRef.current.inputs.map(input => input.id === inputId && !(input.state === "accepted" && patch.state && patch.state !== "accepted") ? { ...input, ...patch } : input) });
	useEffect(() => {
		const epoch = ++generation.current;
		setError(""); setPollError(""); setBusy(false); setLoadingHistory(false);
		if (!loadedComputer.current || loadedComputer.current.id !== id) {
			loadedComputer.current = { id }; loadedDot.current = undefined; loadedConnection.current = undefined;
			setLoaded(false); setView(empty); setOlder([]); setBefore(undefined);
			outboxLoaded.current = false;
			try { const saved = readDotOutbox(localStorage, id); outboxRef.current = saved; setOutbox(saved); outboxLoaded.current = true; }
			catch { outboxRef.current = { draft: "", inputs: [] }; setOutbox(outboxRef.current); setError("Saved Dot messages could not be read. Reload before sending more messages."); }
		} else if (!online && outboxRef.current.inputs.some(input => input.state === "sending")) {
			commit({ ...outboxRef.current, inputs: outboxRef.current.inputs.map(input => input.state === "sending"
				? { ...input, state: "unknown", error: "Connection lost. Checking delivery when it reconnects…" } : input) });
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				if (online && (!document.hidden || outboxRef.current.inputs.some(input => !input.ignored && ["queued", "sending", "unknown"].includes(input.state)))) {
					const choice = selection.current, sequence = ++readSequence.current;
					const next = await api<DotSnapshot>("/dot", undefined, id);
					if (generation.current !== epoch) return;
					if (choice !== selection.current || sequence !== readSequence.current) { timer = setTimeout(refresh, 2_000); return; }
					receive(next); setPollError("");
					let updated = outboxRef.current;
					for (const input of next.inputs) updated = reconcileDotInput(updated, input);
					if (next.transport === "direct" && next.id && next.connection) updated = reviewDotQueue(updated, next.id, next.connection);
					const remote = new Set(next.messages.map(message => message.id));
					updated = { ...updated, inputs: updated.inputs.filter(input => !(input.state === "accepted" && input.dot === next.id && (!input.connection || input.connection === next.connection) && input.messageId && remote.has(input.messageId))) };
					if (JSON.stringify(updated) !== JSON.stringify(outboxRef.current)) commit(updated);
				}
			} catch (error) { if (generation.current === epoch) setPollError(errorText(error)); }
			if (generation.current === epoch) timer = setTimeout(refresh, 2_000);
		};
		void refresh();
		return () => { generation.current++; clearTimeout(timer); };
	}, [id, online]);
	const messages = supported ? merge(older, view.messages) : [];
	const reserved = dotReservedFiles(outbox, view.inputs);
	const files = (view.uploads ?? []).filter(file => file.state !== "handed-off" && !reserved.has(file.id));
	const filesReady = !!view.connection && files.every(file => file.connection === view.connection && ["ready", "uploaded"].includes(file.state));
	const action = async (name: "connect" | "disconnect", account?: string) => {
		if (!supported) { setError("Update Desk on this computer to connect Dot."); return; }
		if (name === "connect" && !account) { setError("Choose a ChatGPT account for Dot."); return; }
		const epoch = generation.current; selection.current++; readSequence.current++; setBusy(true); setError("");
		try {
			await api(`/dot/${name}`, name === "connect" ? { account } : {}, id);
			const sequence = ++readSequence.current, next = await api<DotSnapshot>("/dot", undefined, id);
			if (epoch === generation.current && sequence === readSequence.current) receive(next);
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const send = () => {
		if (!supported || !view.id || !view.connection || busy || !filesReady || !outboxLoaded.current) return;
		const held = dotReservedFiles(outboxRef.current, view.inputs);
		try { if (commit(enqueueDot(outboxRef.current, view.id, view.connection, files.filter(file => !held.has(file.id))))) setError(""); }
		catch (error) { setError(errorText(error)); }
	};
	useEffect(() => {
		if (!online || !supported || view.state !== "ready" || view.paused || !view.id || !view.connection || loadedDot.current !== view.id || loadedConnection.current !== view.connection || view.busy || busy || !outboxLoaded.current) return;
		const key = dotOutboxKey(id), input = nextDotInput(outboxRef.current, view.id, view.connection);
		if (!input || posting.current.has(key)) return;
		const current = () => loadedComputer.current?.id === id;
		if (!amend(input.id, { state: "sending" })) return;
		posting.current.add(key);
		void (async () => {
			try {
				const response = await api<{ input: DotInput }>("/dot/inputs", { id: input.id, dot: input.dot, connection: input.connection, text: input.text, files: input.files }, id);
				if (current()) settled(response.input);
			} catch (error) {
				// A lost reply is not permission to submit again. Reconcile the same receipt.
				let receipt: DotInput | null = null;
				try { receipt = (await api<{ input: DotInput | null }>(`/dot/inputs/${input.id}`, undefined, id)).input; } catch {}
				if (current()) {
					if (receipt) settled(receipt);
					else amend(input.id, { state: "unknown", error: `${errorText(error)} Delivery needs confirmation.` });
				}
			} finally { posting.current.delete(key); }
		})();
	}, [outbox, id, online, view, busy]);
	const check = async (inputId: string) => {
		if (busy) return;
		const epoch = generation.current; setBusy(true);
		try {
			const result = await api<{ input: DotInput | null }>(`/dot/inputs/${inputId}`, undefined, id);
			if (epoch !== generation.current) return;
			if (result.input) settled(result.input);
			else amend(inputId, { error: "No receipt yet. Cancel this attempt to confirm it cannot be sent, or check again." });
		} catch (error) { if (epoch === generation.current) amend(inputId, { error: errorText(error) }); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const cancelUnconfirmed = async (input: DotOutboxInput) => {
		if (busy) return;
		const epoch = generation.current; setBusy(true);
		try {
			const result = await api<{ input: DotInput }>(`/dot/inputs/${input.id}/cancel`, { id: input.id, dot: input.dot, connection: input.connection, text: input.text, files: input.files }, id);
			if (epoch === generation.current) settled(result.input);
		} catch (error) { if (epoch === generation.current) amend(input.id, { error: errorText(error) }); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const retry = (input: DotOutboxInput) => {
		if (!supported || !view.connection || input.state !== "not-sent" || input.dot !== view.id) return;
		if (input.files?.length && input.connection !== view.connection) { setError("These attachments belong to an earlier connection. Reconnect that account, or skip this attempt and select the files again."); return; }
		amend(input.id, { id: crypto.randomUUID(), connection: view.connection, requestId: undefined, messageId: undefined, state: "queued", error: undefined, ignored: false });
	};
	const history = async () => {
		const cursor = before ?? view.before; if (!supported || !cursor || loadingHistory) return;
		const epoch = generation.current, binding = loadedConnection.current; setLoadingHistory(true);
		try {
			const result = await api<{ messages: DotMessage[]; before?: string }>(`/dot/history?before=${encodeURIComponent(cursor)}`, undefined, id);
			if (epoch !== generation.current || binding !== loadedConnection.current) return;
			setOlder(previous => merge(result.messages, previous)); setBefore(result.before ?? "");
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setLoadingHistory(false); }
	};
	const attach = async (chosen: File[]) => {
		if (!supported || busy || !view.id || !view.connection) return;
		const epoch = generation.current; setBusy(true); setError("");
		try { await stageDotFiles(chosen, view.id, view.connection, id, file => {
			if (epoch === generation.current) setView(previous => ({ ...previous, uploads: [...(previous.uploads ?? []).filter(item => item.id !== file.id), file] }));
		}); }
		catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const discard = async (file: DotUpload) => {
		if (busy) return;
		const epoch = generation.current; setBusy(true);
		try { await api(`/dot/uploads/${file.id}/discard`, {}, id);
			if (epoch === generation.current) setView(previous => ({ ...previous, uploads: previous.uploads?.filter(item => item.id !== file.id) })); }
		catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const download = async (message: string, attachment: string) => {
		const epoch = generation.current; setBusy(true); setError("");
		try { const file = await api<DotDownload>("/dot/downloads", { message, attachment }, id); await saveDotDownload(file, id); }
		catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const receipt = view.inputs.find(input => input.id === pending?.id);
	const ready = online && supported && !!view.connection && view.state === "ready";
	const status = !online ? computer?.connection === "paused" ? "App paused" : "Offline"
		: loaded && !supported ? "Update Desk" : view.state === "ready" ? view.paused ? "Paused" : view.writing ? "Writing…" : view.live === false ? "Syncing updates…" : "Connected" : view.state === "connecting" ? "Connecting…" : "Not connected";
	return { computers, id, online, view, loaded, supported, messages, optimistic: pendingDotMessages(outbox, view.id, messages), before: supported ? before ?? view.before : undefined, draft, pending, busy, error: error || pollError,
		loadingHistory, receipt, ready, status, action, send, check, cancelUnconfirmed, retry, history, saveDraft, files, filesReady, attach, discard, download,
		skip(input: DotOutboxInput) { amend(input.id, { ignored: true, ...(input.state === "queued" ? { state: "not-sent", error: "Cancelled before sending." } : {}) }); },
		chooseComputer(value: string) { setChosen(value); localStorage.setItem("pi-desk:dot-computer", value); },
	};
}

export type DotConversationState = ReturnType<typeof useDotConversation>;

export function DotAvatar({ image }: { image?: string }) {
	return <span className="dot-avatar">{image ? <img src={image} alt="" /> : <Icon name="chat" />}</span>;
}
export function DotNavigation({ dot, selected, open }: { dot: DotConversationState; selected: boolean; open: () => void }) {
	return <button className={`session-item dot-navigation${selected ? " selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={open}>
		<DotAvatar image={dot.view.avatar} />
		<span><strong>{dot.view.name ?? "Dot"}</strong><small>{dot.view.writing && <span className="status-dot running" />} {dot.status}</small></span>
	</button>;
}

export function DotConversation({ dot, openNavigation }: { dot: DotConversationState; openNavigation: () => void }) {
	const [showConnection, setShowConnection] = useState(false), [native, setNative] = useState<DotSurfaceFrame>(), [opening, setOpening] = useState(false), [nativeError, setNativeError] = useState("");
	const [discarding, setDiscarding] = useState<DotUpload>();
	const picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null), live = useRef(true), nativeLock = useRef(false), connection = useRef({ computer: dot.id, dot: dot.view.id, binding: dot.view.connection });
	connection.current = { computer: dot.id, dot: dot.view.id, binding: dot.view.connection };
	useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
	useEffect(() => { setNative(undefined); setDiscarding(undefined); setNativeError(""); }, [dot.id, dot.view.id, dot.view.connection]);
	const openNative = async (mode: DotSurfaceMode) => {
		if (!dot.ready || nativeLock.current) return;
		const computer = dot.id, identity = dot.view.id, binding = dot.view.connection;
		const current = () => live.current && connection.current.computer === computer && connection.current.dot === identity && connection.current.binding === binding;
		nativeLock.current = true; setOpening(true); setNativeError("");
		try {
			const frame = await api<DotSurfaceFrame>("/dot/surface", { mode }, computer);
			if (!current()) { await api(`/dot/surface/${frame.id}/close`, {}, computer); return; }
			setNative(frame);
		} catch (error) { if (current()) setNativeError(error instanceof Error ? error.message : String(error)); }
		finally { nativeLock.current = false; if (live.current) setOpening(false); }
	};
	useEffect(() => { const node = editor.current; if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 220)}px`; } }, [dot.draft]);
	const feed = useRef<HTMLDivElement>(null), atBottom = useRef(true), scrollTop = useRef(0);
	const { view, messages, receipt, pending, ready, busy } = dot;
	const name = view.name ?? "Dot", last = messages.at(-1), scrollKey = `${storageKey(dot.id)}:scroll:${view.connection ?? view.id ?? "none"}`;
	useEffect(() => {
		atBottom.current = true; scrollTop.current = 0;
		try {
			const saved = JSON.parse(localStorage.getItem(scrollKey) ?? "null");
			if (saved && Number.isFinite(saved.top) && saved.top >= 0 && typeof saved.bottom === "boolean") { scrollTop.current = saved.top; atBottom.current = saved.bottom; }
		} catch {}
	}, [scrollKey]);
	useEffect(() => {
		if (feed.current) feed.current.scrollTop = atBottom.current ? feed.current.scrollHeight : scrollTop.current;
	}, [last?.id, last?.text, native?.id, messages.length, dot.optimistic.length, dot.optimistic.at(-1)?.state, scrollKey]);
	return <>
		<header className="topbar dot-topbar">
			<button className="icon-button mobile-nav" aria-label="Open navigation" onClick={openNavigation}>☰</button>
			<DotAvatar image={view.avatar} />
			<div className="conversation-heading"><span>Dot · {dot.status}</span><strong>{name}</strong></div>
			<div className="top-actions dot-actions">
				{ready && !native && <button className="subtle-button" disabled={busy || !!pending || opening} onClick={() => void openNative("activity")}>Activity</button>}
				{ready && <button className="subtle-button" aria-expanded={showConnection} onClick={() => setShowConnection(value => !value)}>Connection</button>}
				{ready && !native && <ActionMenu label="Dot options" disabled={busy || opening || pending?.state === "sending"}
					actions={[{ id: "conversation", label: "Native view" }, { id: "settings", label: "Manage Dot" }, ...(!pending ? [{ id: "computer", label: "Computer" }] : [])]}
					invoke={action => void openNative(action.id as DotSurfaceMode)} />}
			</div>
		</header>
		{(dot.error || dot.supported && view.error || nativeError) && <div className="connection-banner dot-error" role="alert">{errorText(dot.error || dot.supported && view.error || nativeError)}</div>}
		{(!ready || showConnection) && <section className="dot-connection" aria-label="Dot connection">
			<h2>{ready ? "Dot connection" : view.state === "connecting" ? "Connecting Dot…" : "Connect your Dot"}</h2>
			{dot.computers && <label>Connection computer<select aria-label="Dot connection computer" value={dot.id ?? ""} disabled={busy || opening} onChange={event => dot.chooseComputer(event.target.value)}>
				{dot.computers.map(computer => <option key={computer.id} value={computer.id}>{computer.name}{computer.connected ? "" : " · Offline"}</option>)}
			</select></label>}
			{dot.supported ? <>
				<DotAccounts key={dot.id ?? "local"} computer={dot.id} online={dot.online} account={view.account} accountName={view.accountName} identity={view.identity}
					ready={ready} busy={busy || opening || !!view.busy || view.state === "connecting"} connect={account => dot.action("connect", account)} disconnect={() => dot.action("disconnect")} />
				<p>No ChatGPT window is needed for messages, attachments or live updates. Keep the connection computer online.</p>
				<p className="muted">Activity, computer and management views open ChatGPT only when you ask. Those views may need a separate browser sign-in to the same account.</p>
			</> : <p role="status">{dot.loaded ? "Update Desk on this computer to use Dot’s saved-account connection. Your queued messages have not been sent." : "Checking this computer’s Dot support…"}</p>}
			{!dot.online && <p className="muted">Bring this computer online to connect Dot.</p>}
		</section>}
		{native ? <DotNativeView key={`${dot.id}:${view.connection}:${native.id}`} initial={native} connection={view.connection!} computer={dot.id} close={() => setNative(undefined)} /> : <>
		<div className="transcript dot-transcript" ref={feed} role="log" aria-label="Dot messages" aria-live="polite" onScroll={event => {
			const node = event.currentTarget; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; scrollTop.current = node.scrollTop;
			localStorage.setItem(scrollKey, JSON.stringify({ top: node.scrollTop, bottom: atBottom.current }));
		}}>
			<div className="dot-messages">
				{dot.before && <button className="older" disabled={dot.loadingHistory} onClick={() => void dot.history()}>{dot.loadingHistory ? "Loading…" : "Earlier messages"}</button>}
				{messages.map((message, index) => {
					const day = new Date(message.created), previous = messages[index - 1];
					const showDay = !previous || new Date(previous.created).toDateString() !== day.toDateString();
					return <div key={message.id}>
						{showDay && <div className="dot-date"><time dateTime={message.created}>{day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</time></div>}
						<article className={`message ${message.author === "owner" ? "message-user" : "message-assistant"}`}>
							<div className="message-heading">
								{message.author !== "owner" && <DotAvatar image={message.author === "dot" ? view.avatar : undefined} />}
								<strong>{message.author === "dot" ? name : message.author === "owner" ? "You" : message.name ?? "Message"}</strong>
								<time dateTime={message.created}>{day.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
							</div>
							<div className="message-body"><div className="markdown"><Markdown remarkPlugins={[remarkGfm]}
								components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{message.text}</Markdown></div>
								{message.attachments.map((attachment, index) => <button type="button" className="dot-attachment" key={attachment.id ?? index} disabled={!ready || busy || opening}
									onClick={() => attachment.downloadable ? void dot.download(message.id, attachment.id) : void openNative("conversation")}>
									{attachment.name}{attachment.downloadable ? " ↓" : " ↗"}
								</button>)}
							</div>
						</article>
					</div>;
				})}
				{dot.optimistic.map(input => <article className="message message-user dot-local-message" key={input.id}>
					<div className="message-heading"><strong>You</strong><time dateTime={input.created}>{new Date(input.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
					<div className="message-body"><div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{input.text}</Markdown></div>
						{input.attachments.map(file => <span className="dot-attachment" key={file.id}>{file.name}</span>)}
					</div>
					<div className={`dot-delivery ${input.state}`} role="status">
						{input.state === "sending" && <span className="status-dot running" aria-hidden="true" />}
						<span>{input.state === "queued" ? !dot.online ? "Queued · Offline" : view.paused ? "Queued · Dot paused" : "Queued" : input.state === "sending" ? "Sending…" : input.state === "accepted" ? "Sent" : input.state === "not-sent" ? "Not sent" : "Delivery needs confirmation"}</span>
						{!input.ignored && <>
							{input.state === "queued" && <button className="text-button" onClick={() => dot.skip(input)}>Cancel</button>}
							{input.state === "not-sent" && <><button className="text-button" disabled={busy || !dot.supported || !view.connection} onClick={() => dot.retry(input)}>Retry</button><button className="text-button" onClick={() => dot.skip(input)}>Skip</button></>}
							{input.state === "unknown" && <><button className="text-button" disabled={busy} onClick={() => void dot.check(input.id)}>Check delivery</button>
								<ActionMenu label="Delivery options" disabled={busy || opening} actions={[...(ready && (!input.connection || input.connection === view.connection) ? [{ id: "review", label: "Review in Dot" }] : []),
									{ id: "cancel", label: "Cancel unconfirmed attempt" }, { id: "continue", label: "Leave unresolved and continue queue" }]}
									invoke={action => action.id === "review" ? void openNative("conversation") : action.id === "cancel" ? void dot.cancelUnconfirmed(input) : dot.skip(input)} /></>}
						</>}
					</div>
					{input.error && <small className="dot-delivery-note">{errorText(input.error)}</small>}
				</article>)}
				{view.writing && <div className="dot-writing" role="status"><DotAvatar image={view.avatar} /><span className="status-dot running" /><span>{name} is writing…</span></div>}
				{!messages.length && !dot.optimistic.length && ready && <div className="dot-empty"><DotAvatar image={view.avatar} /><h1>{name}</h1>
					<p>What’s on your mind?</p>
				</div>}
			</div>
		</div>
		<div className="composer-dock dot-composer-dock">
			{dot.files.length > 0 && <div className="dot-draft-files">{dot.files.map(file => <div className="dot-draft-file" key={file.id}>
				<div className="dot-draft-file-info"><strong>{file.name}</strong><span>{file.state === "ready" ? `${(file.size / 1024).toFixed(0)} KB` : file.state === "staging" ? `${Math.round(file.received / file.size * 100)}%` : file.state === "unknown" ? "Needs review" : file.state}</span>
					{file.connection !== view.connection && <small>From an earlier Dot connection. Reconnect that account or select the file again.</small>}
					{file.error && <small>{file.error}</small>}</div>
				{["unknown", "uploaded", "failed"].includes(file.state) && <button className="subtle-button" disabled={!ready || busy || opening || receipt?.state === "sending"} onClick={() => void openNative("conversation")}>Review</button>}
				<button aria-label={`Discard staged ${file.name}`} disabled={busy || file.state === "uploading"} onClick={() => ["ready", "staging"].includes(file.state) ? void dot.discard(file) : setDiscarding(file)}>×</button>
			</div>)}</div>}
			<input ref={picker} type="file" multiple hidden onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (files.length) void dot.attach(files); }} />
			<form className="dot-compose-form" onSubmit={event => { event.preventDefault(); atBottom.current = true; dot.send(); }}>
				<div className="dot-compose-row">
					<button type="button" className="icon-button dot-attach-button" aria-label="Attach files to Dot" title="Attach files" disabled={!ready || busy || opening || dot.files.length >= DOT_FILE_COUNT} onClick={() => picker.current?.click()}><Icon name="plus" /></button>
					<div className="composer dot-composer"><textarea ref={editor} aria-label="Message Dot" placeholder={`Message ${name}`} rows={1} value={dot.draft} maxLength={32_000}
						onChange={event => dot.saveDraft(event.target.value)} onKeyDown={event => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); atBottom.current = true; dot.send(); }
						}} /></div>
					<button className="send-button" type="submit" aria-label="Send message to Dot" disabled={!dot.supported || !view.connection || !view.id || busy || opening || !dot.filesReady || (!dot.draft.trim() && !dot.files.length)}><Icon name="send" /></button>
				</div>
				<div className="dot-composer-hint">{view.paused ? "Dot is paused. Resume it from Manage Dot to send queued messages." : "Shift+Enter for a new line"}</div>
			</form>
		</div>
		</>}
		{discarding && <Modal title="Discard staged file" close={() => setDiscarding(undefined)}>
			<p>Discard Desk’s local copy of <strong>{discarding.name}</strong>?</p>
			<p className="muted">This does not remove an upload or draft already in ChatGPT. Review its native conversation first.</p>
			<div className="dialog-actions"><button disabled={busy} onClick={() => setDiscarding(undefined)}>Keep file</button>
				<button disabled={busy || !!pending} onClick={() => { void dot.discard(discarding); setDiscarding(undefined); }}>Discard local copy</button></div>
		</Modal>}
	</>;
}

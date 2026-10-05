import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { Modal } from "./surfaces.tsx";
import { DOT_FILE_COUNT, type DotInput, type DotMessage, type DotSnapshot, type DotUpload, type DotDownload, type DotSurfaceFrame, type DotSurfaceMode } from "../shared/dot.ts";
import { stageDotFiles, saveDotDownload } from "./dot-files.ts";
import { DotNativeView } from "./dot-native-view.tsx";
import type { Computer } from "./workspace.ts";
import { api, ApiError } from "./connection.ts";
import { dotOutboxKey, dotReservedFiles, enqueueDot, nextDotInput, pendingDotMessages, readDotOutbox, reconcileDotInput, type DotOutbox, type DotOutboxInput } from "./dot-outbox.ts";

const empty: DotSnapshot = { state: "disconnected", messages: [], inputs: [] };
const errorText = (error: unknown) => {
	const text = error instanceof Error ? error.message : String(error);
	if (/Session with given id not found|No session with given id/i.test(text)) return "The Dot browser connection was lost. Reconnect Dot.";
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
	const [older, setOlder] = useState<DotMessage[]>([]);
	const [before, setBefore] = useState<string>();
	const [outbox, setOutbox] = useState<DotOutbox>({ draft: "", inputs: [] });
	const outboxRef = useRef(outbox); outboxRef.current = outbox;
	const outboxLoaded = useRef(false), posting = useRef(new Set<string>());
	const draft = outbox.draft;
	const pending = outbox.inputs.find(input => input.dot === view.id && input.state !== "accepted" && !input.ignored);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [loadingHistory, setLoadingHistory] = useState(false);
	const generation = useRef(0);
	const loadedComputer = useRef<{ id?: string } | undefined>(undefined);
	const loadedDot = useRef<string | undefined>(undefined);
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
	const settled = (input: DotInput) => commit(reconcileDotInput(outboxRef.current, input));
	const amend = (inputId: string, patch: Partial<DotOutboxInput>) => commit({ ...outboxRef.current,
		inputs: outboxRef.current.inputs.map(input => input.id === inputId && !(input.state === "accepted" && patch.state && patch.state !== "accepted") ? { ...input, ...patch } : input) });
	useEffect(() => {
		const epoch = ++generation.current;
		setError(""); setBusy(false);
		if (!loadedComputer.current || loadedComputer.current.id !== id) {
			loadedComputer.current = { id }; loadedDot.current = undefined;
			setView(empty); setOlder([]); setBefore(undefined);
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
					const next = await api<DotSnapshot>("/dot", undefined, id);
					if (generation.current !== epoch) return;
					if (next.id && loadedDot.current !== next.id) { loadedDot.current = next.id; setOlder([]); setBefore(undefined); }
					setView(next);
					let updated = outboxRef.current;
					for (const input of next.inputs) updated = reconcileDotInput(updated, input);
					const remote = new Set(next.messages.map(message => message.id));
					updated = { ...updated, inputs: updated.inputs.filter(input => !(input.state === "accepted" && input.messageId && remote.has(input.messageId))) };
					if (JSON.stringify(updated) !== JSON.stringify(outboxRef.current)) commit(updated);
				}
			} catch (error) { if (generation.current === epoch) setError(errorText(error)); }
			if (generation.current === epoch) timer = setTimeout(refresh, 2_000);
		};
		void refresh();
		return () => { generation.current++; clearTimeout(timer); };
	}, [id, online]);
	const messages = merge(older, view.messages);
	const reserved = dotReservedFiles(outbox, view.inputs);
	const files = (view.uploads ?? []).filter(file => file.state !== "handed-off" && !reserved.has(file.id));
	const filesReady = files.every(file => ["ready", "uploaded"].includes(file.state));
	const action = async (name: "connect" | "disconnect") => {
		const epoch = generation.current; setBusy(true); setError("");
		try {
			await api(`/dot/${name}`, {}, id);
			const next = await api<DotSnapshot>("/dot", undefined, id);
			if (epoch === generation.current) { setView(next); setOlder([]); setBefore(undefined); }
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const send = () => {
		if (!view.id || busy || !filesReady || !outboxLoaded.current) return;
		const held = dotReservedFiles(outboxRef.current, view.inputs);
		if (commit(enqueueDot(outboxRef.current, view.id, files.filter(file => !held.has(file.id))))) setError("");
	};
	useEffect(() => {
		if (!online || view.state !== "ready" || !view.id || loadedDot.current !== view.id || view.busy || busy || !outboxLoaded.current) return;
		const key = dotOutboxKey(id), input = nextDotInput(outboxRef.current, view.id);
		if (!input || posting.current.has(key)) return;
		const current = () => loadedComputer.current?.id === id;
		if (!amend(input.id, { state: "sending" })) return;
		posting.current.add(key);
		void (async () => {
			try {
				const response = await api<{ input: DotInput }>("/dot/inputs", { id: input.id, dot: input.dot, text: input.text, files: input.files }, id);
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
			const result = await api<{ input: DotInput }>(`/dot/inputs/${input.id}/cancel`, { id: input.id, dot: input.dot, text: input.text, files: input.files }, id);
			if (epoch === generation.current) settled(result.input);
		} catch (error) { if (epoch === generation.current) amend(input.id, { error: errorText(error) }); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const retry = (input: DotOutboxInput) => {
		if (input.state !== "not-sent" || input.dot !== view.id) return;
		amend(input.id, { id: crypto.randomUUID(), state: "queued", error: undefined, ignored: false });
	};
	const history = async () => {
		const cursor = before ?? view.before; if (!cursor || loadingHistory) return;
		const epoch = generation.current; setLoadingHistory(true);
		try {
			const result = await api<{ messages: DotMessage[]; before?: string }>(`/dot/history?before=${encodeURIComponent(cursor)}`, undefined, id);
			if (epoch !== generation.current) return;
			setOlder(previous => merge(result.messages, previous)); setBefore(result.before ?? "");
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setLoadingHistory(false); }
	};
	const attach = async (chosen: File[]) => {
		if (busy || !view.id) return;
		const epoch = generation.current; setBusy(true); setError("");
		try { await stageDotFiles(chosen, view.id, id, file => {
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
	const ready = online && view.state === "ready";
	const status = !online ? computer?.connection === "paused" ? "App paused" : "Offline"
		: view.state === "ready" ? view.paused ? "Paused" : view.writing ? "Writing…" : "Connected" : view.state === "connecting" ? "Connecting…" : "Not connected";
	return { computers, id, online, view, messages, optimistic: pendingDotMessages(outbox, view.id, messages), before: before ?? view.before, draft, pending, busy, error,
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
	const picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null), live = useRef(true), nativeLock = useRef(false), connection = useRef({ computer: dot.id, dot: dot.view.id });
	connection.current = { computer: dot.id, dot: dot.view.id };
	useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
	useEffect(() => { setNative(undefined); setDiscarding(undefined); setNativeError(""); }, [dot.id, dot.view.id]);
	const openNative = async (mode: DotSurfaceMode) => {
		if (!dot.ready || nativeLock.current) return;
		const computer = dot.id, identity = dot.view.id;
		const current = () => live.current && connection.current.computer === computer && connection.current.dot === identity;
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
	const name = view.name ?? "Dot", last = messages.at(-1), scrollKey = `${storageKey(dot.id)}:scroll:${view.id ?? "none"}`;
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
					actions={[{ id: "conversation", label: "Native view" }, ...(!pending ? [{ id: "computer", label: "Computer" }, { id: "settings", label: "Manage Dot" }] : [])]}
					invoke={action => void openNative(action.id as DotSurfaceMode)} />}
			</div>
		</header>
		{(dot.error || view.error || nativeError) && <div className="connection-banner dot-error" role="alert">{errorText(dot.error || view.error || nativeError)}</div>}
		{(!ready || showConnection) && <section className="dot-connection" aria-label="Dot connection">
			<h2>{ready ? "Dot connection" : view.state === "connecting" ? "Connecting Dot…" : "Connect your Dot"}</h2>
			{dot.computers && <label>Connection computer<select aria-label="Dot connection computer" value={dot.id ?? ""} disabled={busy || !!pending || opening} onChange={event => dot.chooseComputer(event.target.value)}>
				{dot.computers.map(computer => <option key={computer.id} value={computer.id}>{computer.name}{computer.connected ? "" : " · Offline"}</option>)}
			</select></label>}
			<div className="dot-connection-actions"><button className={ready ? "subtle-button" : "primary"} disabled={!dot.online || busy || opening || view.state === "connecting" || receipt?.state === "sending"}
				onClick={() => void dot.action(ready ? "disconnect" : "connect")}>{view.state === "connecting" ? "Connecting…" : busy ? "Working…" : ready ? "Disconnect" : dot.error || view.error ? "Reconnect Dot" : "Connect Dot"}</button>
				{ready && <small>Disconnecting Desk does not pause your hosted Dot.</small>}
			</div>
			{!ready && <p>Sign into ChatGPT in Chrome on {dot.computers?.find(computer => computer.id === dot.id)?.name ?? "this computer"}, then connect here.</p>}
			<p className="muted">Dot uses Chrome’s ChatGPT sign-in, not your conversation’s Codex account. Desk opens a background tab.</p>
			{!dot.online && <p className="muted">Bring this computer online to connect Dot.</p>}
		</section>}
		{native ? <DotNativeView key={`${dot.id}:${native.id}`} initial={native} computer={dot.id} close={() => setNative(undefined)} /> : <>
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
						<span>{input.state === "queued" ? dot.online ? "Queued" : "Queued · Offline" : input.state === "sending" ? "Sending…" : input.state === "accepted" ? "Sent" : input.state === "not-sent" ? "Not sent" : "Delivery needs confirmation"}</span>
						{!input.ignored && <>
							{input.state === "queued" && <button className="text-button" onClick={() => dot.skip(input)}>Cancel</button>}
							{input.state === "not-sent" && <><button className="text-button" disabled={busy} onClick={() => dot.retry(input)}>Retry</button><button className="text-button" onClick={() => dot.skip(input)}>Skip</button></>}
							{input.state === "unknown" && <><button className="text-button" disabled={busy} onClick={() => void dot.check(input.id)}>Check delivery</button>
								<ActionMenu label="Delivery options" disabled={busy || opening} actions={[...(ready ? [{ id: "review", label: "Review in Dot" }] : []),
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
					<button className="send-button" type="submit" aria-label="Send message to Dot" disabled={!view.id || busy || opening || !dot.filesReady || (!dot.draft.trim() && !dot.files.length)}><Icon name="send" /></button>
				</div>
				<div className="dot-composer-hint">Shift+Enter for a new line</div>
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

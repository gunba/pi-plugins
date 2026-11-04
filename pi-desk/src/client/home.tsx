import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HomeMessage, HomeSnapshot, HomeWork } from "../shared/home.ts";
import type { ChatMessage } from "../shared/protocol.ts";
import { MessageView } from "./message-view.tsx";
import { api } from "./connection.ts";
import { sessionKey, type WorkspaceState } from "./workspace.ts";
import { HomePage } from "./home-page.tsx";
import { Icon } from "./icons.tsx";
import { Modal } from "./surfaces.tsx";
import { AttachmentList, useAttachments } from "./attachments.tsx";
import { DictationButton, dictationComputer, withDictation } from "./dictation.tsx";
import { withDictationNote } from "../shared/dictation-note.ts";
import "./home.css";

const referenceKey = (computer: string | undefined, key: string) => computer ? sessionKey(computer, key) : key;
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
interface Pending { id: string; text: string; attachments?: string[]; files: string[]; draft: string }
const EMPTY: HomeSnapshot = { messages: [], busy: false };
/** What Home asks of the message box: take back a message that was not sent, or let go of one that was. */
interface ComposerControl { restore: (text: string) => void; clearIf: (text: string) => void }

/** The next snapshot, keeping the previous objects where nothing changed, so only what changed renders again. */
function shared(previous: HomeSnapshot, next: HomeSnapshot): HomeSnapshot {
	const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
	const known = new Map(previous.messages.map(message => [message.id, message]));
	const messages = next.messages.map(message => { const old = known.get(message.id); return old && same(old, message) ? old : message; });
	return { ...next,
		messages: messages.length === previous.messages.length && messages.every((message, index) => message === previous.messages[index]) ? previous.messages : messages,
		work: same(previous.work, next.work) ? previous.work : next.work, watches: same(previous.watches, next.watches) ? previous.watches : next.watches };
}

export function Home({ host, connected, openConversation, openNavigation }: {
	host: WorkspaceState; connected: boolean; openConversation: (key: string, view?: string) => void; openNavigation: () => void;
}) {
	const server = host.computers?.find(computer => computer.teleport?.hold), computer = server?.id;
	const online = host.computers ? !!server?.connected : connected;
	const [snapshot, setSnapshot] = useState<HomeSnapshot>(EMPTY);
	// The snapshot this view shows; a poll that names it gets only "unchanged" back when nothing changed.
	const revision = useRef<string | undefined>(undefined);
	const accept = (next: HomeSnapshot) => { if (next.unchanged) return; revision.current = next.revision; setSnapshot(previous => shared(previous, next)); };
	const [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const [discardPending, setDiscardPending] = useState(false);
	const storageKey = `pi-desk:home:${computer ?? "local"}`;
	const [pending, setPending] = useState<Pending>(), [outboxReady, setOutboxReady] = useState(false);
	const pendingRef = useRef(pending); pendingRef.current = pending;
	const composer = useRef<ComposerControl>(null);
	const epoch = useRef(0), posting = useRef(false);
	const attachments = useAttachments(storageKey, setError);
	const key = snapshot.session ? referenceKey(computer, snapshot.session) : undefined;
	const session = host.sessions.find(item => item.key === key);
	const latest = snapshot.messages.filter(message => message.role === "assistant").at(-1);
	// The conversation with Home sits beside the canvas; closed, only its latest reply shows above the box.
	const [chatOpen, setChatOpen] = useState(() => { try { return (localStorage.getItem("pi-desk:home:chat") ?? (innerWidth > 760 ? "open" : "closed")) === "open"; } catch { return true; } });
	const toggleChat = () => setChatOpen(open => { try { localStorage.setItem("pi-desk:home:chat", open ? "closed" : "open"); } catch { /* Kept for this visit. */ } return !open; });
	// A message on its way shows in the log at once, until the log has it.
	const outgoing = pending && !snapshot.messages.some(message => message.id === pending.id) ? pending : undefined;
	// The log follows new messages while it is at its end; reading further up, it stays put. Its length is capped, so
	// the newest message, not the count, says when there is something new.
	const log = useRef<HTMLDivElement>(null), follow = useRef(true);
	const newest = snapshot.messages.at(-1)?.id;
	useLayoutEffect(() => { const node = log.current; if (chatOpen && node && follow.current) node.scrollTop = node.scrollHeight; }, [chatOpen, newest, snapshot.busy, outgoing]);
	// On a phone the open conversation shares the screen with the page, split where Jordan drags it.
	const body = useRef<HTMLDivElement>(null);
	const [share, setShare] = useState(() => { try { const saved = Number(localStorage.getItem("pi-desk:home:split")); return saved >= 0.2 && saved <= 0.85 ? saved : 0.5; } catch { return 0.5; } });
	const resize = (next: number) => { const value = Math.min(0.85, Math.max(0.2, next)); setShare(value); try { localStorage.setItem("pi-desk:home:split", value.toFixed(3)); } catch { /* Kept for this visit. */ } };
	const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const box = body.current?.getBoundingClientRect(); if (!box) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const move = (moved: PointerEvent) => resize((box.bottom - moved.clientY) / box.height);
		const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
		window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
	};
	useEffect(() => {
		const generation = ++epoch.current;
		setSnapshot(EMPTY); revision.current = undefined; setError(""); setBusy(false);
		setOutboxReady(false); pendingRef.current = undefined; setPending(undefined);
		try {
			const restored = JSON.parse(localStorage.getItem(`${storageKey}:pending`) ?? "null") ?? undefined;
			if (restored && (typeof restored.id !== "string" || typeof restored.text !== "string" || typeof restored.draft !== "string" || !Array.isArray(restored.files))) throw Error("Invalid Home outbox.");
			pendingRef.current = restored; setPending(restored); setOutboxReady(true);
		}
		catch { setError("Saved Home messages could not be read. Check this device's storage before sending."); }
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				if (online) {
					const next = await api<HomeSnapshot>(revision.current ? `/home?known=${revision.current}` : "/home", undefined, computer);
					if (epoch.current === generation) accept(next);
				}
			}
			catch (error) { if (epoch.current === generation) setError(failure(error)); }
			if (epoch.current === generation) timer = setTimeout(poll, document.hidden ? 10_000 : 1500);
		};
		void poll();
		return () => { epoch.current++; clearTimeout(timer); };
	}, [storageKey, online]);
	useEffect(() => {
		if (!key || !session?.finished || (session.seen ?? 0) >= session.finished) return;
		const seen = () => { if (!document.hidden && document.hasFocus()) void api(`/sessions/${key}/seen`, {}).catch(() => {}); };
		seen(); window.addEventListener("focus", seen); document.addEventListener("visibilitychange", seen);
		return () => { window.removeEventListener("focus", seen); document.removeEventListener("visibilitychange", seen); };
	}, [key, session?.finished, session?.seen]);
	const open = async () => { const generation = epoch.current, next = await api<HomeSnapshot>("/home/open", {}, computer);
		if (generation !== epoch.current) throw Error("The workspace server changed. Open Home again.");
		accept(next); return next; };
	/** The outbox's message reached Home: it leaves the outbox, and the box if it is still there. */
	const settle = async (input: Pending) => {
		localStorage.removeItem(`${storageKey}:pending`); setPending(undefined); pendingRef.current = undefined;
		composer.current?.clearIf(input.draft);
		await attachments.clear(input.files); setError("");
	};
	const deliver = async (input: Pending) => {
		if (!online || posting.current) return;
		posting.current = true; setBusy(true); const generation = epoch.current;
		try {
			const next = await api<HomeSnapshot>("/home/messages", { id: input.id, text: input.text, attachments: input.attachments }, computer);
			if (epoch.current !== generation) return;
			accept(next); await settle(input);
		} catch (error) { if (epoch.current === generation) setError(`${failure(error)} Your message is saved. Retry checks the same delivery; it will not send a second copy.`); }
		finally { posting.current = false; if (epoch.current === generation) setBusy(false); }
	};
	useEffect(() => { if (online && pendingRef.current) void deliver(pendingRef.current); }, [online, storageKey]);
	// Home lists a message only once it has accepted it, so one in the log has arrived even if its reply was lost.
	useEffect(() => { if (pending && !outgoing && !posting.current) void settle(pending).catch(error => setError(failure(error))); }, [pending, outgoing]);
	/** Puts a message in the outbox and delivers it; true once the outbox holds it, so the box can let it go. */
	const send = async (text: string, dictated: boolean): Promise<boolean> => {
		if (busy || posting.current || !outboxReady) return false;
		if (pendingRef.current) { void deliver(pendingRef.current); return false; }
		if (!text.trim() && !attachments.files.length) return false;
		const generation = epoch.current;
		let uploaded: string[] = [];
		if (attachments.files.length) {
			setBusy(true);
			try {
				if (!online) throw Error("Reconnect the workspace server to upload these files. They are saved on this device.");
				const current = await open();
				const sessionId = referenceKey(computer, current.session!);
				uploaded = await attachments.upload(sessionId, command => api(`/sessions/${sessionId}/uploads`, { activation: current.activation, command }));
			} catch (error) { if (epoch.current === generation) setError(failure(error)); return false; }
			finally { if (epoch.current === generation) setBusy(false); }
			if (epoch.current !== generation) return false;
		}
		const input: Pending = { id: crypto.randomUUID(), text: dictated ? withDictationNote(text.trim()) : text.trim(), draft: text,
			attachments: uploaded, files: attachments.files.map(file => file.id) };
		try { localStorage.setItem(`${storageKey}:pending`, JSON.stringify(input)); }
		catch { setError("This device could not save the message, so it was not sent."); return false; }
		pendingRef.current = input; setPending(input); follow.current = true;
		void deliver(input);
		return true;
	};
	// Stable, so the page and the log don't render again while Jordan types.
	const current = useRef({ openConversation, computer, key }); current.current = { openConversation, computer, key };
	const openWork = useCallback((work: HomeWork) => current.current.openConversation(referenceKey(work.computer ?? current.current.computer, work.id), work.view), []);
	const openWatches = useCallback(() => { const { key, openConversation } = current.current; if (key) openConversation(key, "pi-watch"); }, []);
	/** Jordan's own change to his page, saved over the version he sees; a conflict leaves the page as it now is. */
	const pageVersion = snapshot.pageVersion;
	const changePage = useMemo(() => online && pageVersion ? async (text: string) => {
		const generation = epoch.current;
		try {
			const next = await api<HomeSnapshot>("/home/page", { version: pageVersion, text }, computer);
			if (epoch.current === generation) { accept(next); setError(""); }
		} catch (error) { if (epoch.current === generation) setError(failure(error)); throw error; }
	} : undefined, [online, pageVersion, computer]);
	const outgoingMessage = useMemo(() => outgoing && chatMessage({ id: outgoing.id, role: "user", text: outgoing.text, at: 0 }), [outgoing]);
	return <>
		<header className="topbar home-topbar"><button className="icon-button mobile-nav" aria-label="Open navigation" onClick={openNavigation}>☰</button>
			<div className="conversation-heading"><strong>Home</strong>{snapshot.busy && <span>Working…</span>}</div>
			<div className="top-actions"><span className="home-run" title={snapshot.run ? `${snapshot.run.input} input · ${snapshot.run.output} output · ${snapshot.run.cacheRead} cached tokens` : undefined}>
				{snapshot.run ? `$${snapshot.run.cost.toFixed(4)} last run` : "Terra 6.1"}</span>
				<button className="subtle-button" disabled={!key} onClick={() => {
					if (key && session) openConversation(key);
					else void open().then(next => { if (next.session) openConversation(referenceKey(computer, next.session)); }).catch(error => setError(failure(error)));
				}}>History</button><button className={`icon-button${chatOpen ? " selected" : ""}`} aria-label={chatOpen ? "Hide the conversation" : "Show the conversation"} aria-pressed={chatOpen} onClick={toggleChat}><Icon name="chat" /></button></div>
		</header>
		{(!online || error || snapshot.error) && <div className="connection-banner" role="status">{error || snapshot.error || (host.computers && !server ? "Choose a workspace server under Computers → Keep conversation copies to use Home." : "Workspace server offline. Your canvas and draft stay here.")}</div>}
		<div ref={body} className={`home-body${chatOpen ? " chat-open" : ""}`} style={{ "--home-chat-share": `${share * 100}%` } as CSSProperties}>
		<HomePage page={snapshot.page ?? ""} work={snapshot.work ?? NONE} watches={snapshot.watches ?? NONE} open={openWork} openWatches={openWatches} change={changePage} />
		<section className="home-chat" aria-label="Talk to Home">
			{chatOpen && <div className="home-split" role="separator" aria-orientation="horizontal" aria-label="Resize the conversation" tabIndex={0}
				aria-valuemin={20} aria-valuemax={85} aria-valuenow={Math.round(share * 100)} onPointerDown={drag}
				onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); resize(share + (event.key === "ArrowUp" ? 0.05 : -0.05)); } }} />}
			{chatOpen && <div className="home-log" ref={log} role="log" aria-live="polite"
				onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
				{snapshot.messages.length || outgoingMessage ? snapshot.messages.map(message => <MessageView key={message.id} message={chatMessage(message)} sessionKey={key ?? "home"} />)
					: <p className="home-log-empty">Ask Home to add, change or rearrange anything.</p>}
				{outgoingMessage && <div className="home-outgoing"><MessageView message={outgoingMessage} sessionKey={key ?? "home"} /></div>}
				{snapshot.busy && <p className="home-log-busy">Working…</p>}
			</div>}
			{session?.inputs?.some(input => input.state === "failed" || input.state === "interrupted") && <button className="question-banner" onClick={() => key && openConversation(key)}>A Home message needs review. Open history →</button>}
			{session?.ui?.interactions.length ? <button className="question-banner" onClick={() => key && openConversation(key)}><strong>Home needs your answer</strong><span>Open →</span></button> : null}
			{!chatOpen && latest && <LatestReply text={latest.text} />}
			{/* In the open log a message on its way shows itself; the status line is for problems, or when the log is hidden. */}
			{pending && (!chatOpen || !(online && busy)) && <div className="home-pending" role="status">{online ? busy ? "Sending…" : "Delivery not confirmed" : "Queued · offline"}<span><button className="text-button" disabled={!online || busy} onClick={() => void deliver(pending)}>Check delivery</button><button className="text-button" disabled={busy} onClick={() => setDiscardPending(true)}>Discard local attempt</button></span></div>}
			<AttachmentList files={attachments.files} remove={id => attachments.remove(id)} disabled={busy || !!pending} />
			<HomeComposer key={storageKey} storageKey={storageKey} control={composer} ready={outboxReady} busy={busy} held={!!pending} attachments={attachments}
				dictation={dictationComputer(host.computers, computer)} send={send} report={setError} />
		</section>
		</div>
		{discardPending && <Modal title="Discard local attempt" close={() => setDiscardPending(false)}><p>This does not cancel a message already accepted by Home. Check History before sending another copy. Its text goes back to the message box.</p><div className="dialog-actions"><button onClick={() => setDiscardPending(false)}>Keep checking</button><button onClick={() => {
			try { localStorage.removeItem(`${storageKey}:pending`); if (pendingRef.current) composer.current?.restore(pendingRef.current.draft); pendingRef.current = undefined; setPending(undefined); setDiscardPending(false); }
			catch (error) { setError(failure(error)); }
		}}>Discard local attempt</button></div></Modal>}
	</>;
}
const NONE: never[] = [];

/**
 * The message box, with its draft kept here so typing renders only the box. A sent message leaves it as soon as it is
 * in the outbox; one that can't be sent stays.
 */
function HomeComposer({ storageKey, control, ready, busy, held, attachments, dictation, send, report }: {
	storageKey: string; control: RefObject<ComposerControl | null>; ready: boolean; busy: boolean;
	/** A message is in the outbox: another waits until it is delivered or discarded. */
	held: boolean;
	attachments: ReturnType<typeof useAttachments>; dictation: ReturnType<typeof dictationComputer>;
	send: (text: string, dictated: boolean) => Promise<boolean>; report: (error: string) => void;
}) {
	const [draft, setDraft] = useState(() => { try { return localStorage.getItem(`${storageKey}:draft`) ?? ""; } catch { return ""; } });
	const draftRef = useRef(draft), dictated = useRef(false), picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null);
	const save = (text: string) => { setDraft(text); draftRef.current = text; try { localStorage.setItem(`${storageKey}:draft`, text); } catch { report("Your draft could not be saved on this device."); } };
	control.current = {
		restore: text => save(draftRef.current.trim() ? `${text}\n\n${draftRef.current}` : text),
		clearIf: text => { if (draftRef.current === text) save(""); },
	};
	useEffect(() => {
		const node = editor.current; if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 150)}px`; }
	}, [draft]);
	const submit = (text = draftRef.current) => {
		void send(text, dictated.current).then(sent => { if (!sent) return; dictated.current = false; if (draftRef.current === text) save(""); });
	};
	return <form className="home-compose" onSubmit={event => { event.preventDefault(); submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
		onDrop={event => { event.preventDefault(); if (!busy && !held) attachments.add(event.dataTransfer.files); }}>
		<input type="file" multiple hidden ref={picker} onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
		<button type="button" className="icon-button" aria-label="Attach files" disabled={busy || held} onClick={() => picker.current?.click()}><Icon name="plus" /></button>
		<textarea ref={editor} rows={1} aria-label="Message Home" placeholder="Tell Desk what you need…" value={draft} maxLength={32_000} onChange={event => save(event.target.value)}
			onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); attachments.add(event.clipboardData.files); } }}
			onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
		<DictationButton disabled={!ready || busy || held} computer={dictation} report={report} append={text => { dictated.current = true; save(withDictation(draftRef.current, text)); }}
			submit={text => { dictated.current = true; const next = withDictation(draftRef.current, text); save(next); submit(next); }} />
		<button className="send-button" type="submit" aria-label="Send to Home" disabled={!ready || busy || held || (!draft.trim() && !attachments.files.length)}><Icon name="send" /></button>
	</form>;
}

/** Home's latest reply, shown above the box while the conversation is hidden; parsed again only when it changes. */
const LatestReply = memo(function LatestReply({ text }: { text: string }) {
	return <div className="home-reply markdown" role="log" aria-live="polite"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;
});

/** Home's messages in the main chat's own message view, one object per message so unchanged ones don't render again. */
const chatMessages = new WeakMap<HomeMessage, ChatMessage>();
function chatMessage(message: HomeMessage): ChatMessage {
	let chat = chatMessages.get(message);
	if (!chat) chatMessages.set(message, chat = { id: message.id, order: message.at, revision: 0, role: message.role, timestamp: message.at, blocks: [
		...(message.text ? [{ type: "text" as const, text: message.text }] : []),
		...(message.files?.length ? [{ type: "text" as const, text: `Attached ${message.files.join(", ")}` }] : [])] });
	return chat;
}

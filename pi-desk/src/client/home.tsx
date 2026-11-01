import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { emptyHomeScene, type HomeMessage, type HomeSnapshot, type HomeWork } from "../shared/home.ts";
import type { ChatMessage } from "../shared/protocol.ts";
import { MessageView } from "./message-view.tsx";
import { api } from "./connection.ts";
import { sessionKey, type WorkspaceState } from "./workspace.ts";
import { HomeCanvas } from "./home-canvas.tsx";
import { Icon } from "./icons.tsx";
import { Modal } from "./surfaces.tsx";
import { AttachmentList, useAttachments } from "./attachments.tsx";
import { DictationButton, dictationComputer, withDictation } from "./dictation.tsx";
import { withDictationNote } from "../shared/dictation-note.ts";
import "./home.css";

const referenceKey = (computer: string | undefined, key: string) => computer ? sessionKey(computer, key) : key;
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
interface Pending { id: string; text: string; attachments?: string[]; files: string[]; draft: string }
export function Home({ host, connected, openConversation, openNavigation }: {
	host: WorkspaceState; connected: boolean; openConversation: (key: string, view?: string) => void; openNavigation: () => void;
}) {
	const server = host.computers?.find(computer => computer.teleport?.hold), computer = server?.id;
	const online = host.computers ? !!server?.connected : connected;
	const [snapshot, setSnapshot] = useState<HomeSnapshot>({ scene: emptyHomeScene(), messages: [], busy: false });
	const [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const [discardPending, setDiscardPending] = useState(false);
	const storageKey = `pi-desk:home:${computer ?? "local"}`;
	const [draft, setDraft] = useState(""), [pending, setPending] = useState<Pending>();
	const [draftLoaded, setDraftLoaded] = useState(false);
	const draftRef = useRef(draft); draftRef.current = draft;
	const pendingRef = useRef(pending); pendingRef.current = pending;
	const dictated = useRef(false), picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null);
	const epoch = useRef(0), posting = useRef(false);
	const attachments = useAttachments(storageKey, setError);
	const key = snapshot.session ? referenceKey(computer, snapshot.session) : undefined;
	const session = host.sessions.find(item => item.key === key);
	const latest = snapshot.messages.filter(message => message.role === "assistant").at(-1);
	// The conversation with Home sits beside the canvas; closed, only its latest reply shows above the box.
	const [chatOpen, setChatOpen] = useState(() => { try { return (localStorage.getItem("pi-desk:home:chat") ?? (innerWidth > 760 ? "open" : "closed")) === "open"; } catch { return true; } });
	const toggleChat = () => setChatOpen(open => { try { localStorage.setItem("pi-desk:home:chat", open ? "closed" : "open"); } catch { /* Kept for this visit. */ } return !open; });
	const log = useRef<HTMLDivElement>(null);
	useEffect(() => { if (chatOpen) log.current?.scrollTo({ top: log.current.scrollHeight }); }, [chatOpen, snapshot.messages.length]);
	const saveDraft = (text: string) => { setDraft(text); draftRef.current = text; try { localStorage.setItem(`${storageKey}:draft`, text); } catch { setError("Your draft could not be saved on this device."); } };
	useEffect(() => {
		const generation = ++epoch.current;
		setSnapshot({ scene: emptyHomeScene(), messages: [], busy: false }); setError(""); setBusy(false);
		setDraftLoaded(false); pendingRef.current = undefined; setPending(undefined);
		try {
			setDraft(localStorage.getItem(`${storageKey}:draft`) ?? "");
			const restored = JSON.parse(localStorage.getItem(`${storageKey}:pending`) ?? "null") ?? undefined;
			if (restored && (typeof restored.id !== "string" || typeof restored.text !== "string" || typeof restored.draft !== "string" || !Array.isArray(restored.files))) throw Error("Invalid Home outbox.");
			pendingRef.current = restored; setPending(restored); setDraftLoaded(true);
		}
		catch { setDraft(""); setError("Saved Home messages could not be read. Check this device's storage before sending."); }
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try { if (online) { const next = await api<HomeSnapshot>("/home", undefined, computer); if (epoch.current === generation) setSnapshot(next); } }
			catch (error) { if (epoch.current === generation) setError(failure(error)); }
			if (epoch.current === generation) timer = setTimeout(poll, document.hidden ? 10_000 : 1500);
		};
		void poll();
		return () => { epoch.current++; clearTimeout(timer); };
	}, [storageKey, online]);
	useEffect(() => {
		const node = editor.current; if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 150)}px`; }
	}, [draft]);
	useEffect(() => {
		if (!key || !session?.finished || (session.seen ?? 0) >= session.finished) return;
		const seen = () => { if (!document.hidden && document.hasFocus()) void api(`/sessions/${key}/seen`, {}).catch(() => {}); };
		seen(); window.addEventListener("focus", seen); document.addEventListener("visibilitychange", seen);
		return () => { window.removeEventListener("focus", seen); document.removeEventListener("visibilitychange", seen); };
	}, [key, session?.finished, session?.seen]);
	const open = async () => { const generation = epoch.current, next = await api<HomeSnapshot>("/home/open", {}, computer);
		if (generation !== epoch.current) throw Error("The workspace server changed. Open Home again.");
		setSnapshot(next); return next; };
	const deliver = async (input: Pending) => {
		if (!online || posting.current) return;
		posting.current = true; setBusy(true); const generation = epoch.current;
		try {
			const next = await api<HomeSnapshot>("/home/messages", { id: input.id, text: input.text, attachments: input.attachments }, computer);
			if (epoch.current !== generation) return;
			setSnapshot(next); localStorage.removeItem(`${storageKey}:pending`); setPending(undefined); pendingRef.current = undefined;
			if (draftRef.current === input.draft) saveDraft("");
			await attachments.clear(input.files); setError("");
		} catch (error) { if (epoch.current === generation) setError(`${failure(error)} Your message is saved. Retry checks the same delivery; it will not send a second copy.`); }
		finally { posting.current = false; if (epoch.current === generation) setBusy(false); }
	};
	useEffect(() => { if (online && pendingRef.current) void deliver(pendingRef.current); }, [online, storageKey]);
	const send = async (text = draftRef.current) => {
		if (busy || posting.current || !draftLoaded) return;
		if (pendingRef.current) { void deliver(pendingRef.current); return; }
		if (!text.trim() && !attachments.files.length) return;
		setBusy(true); const generation = epoch.current;
		try {
			if (!online && attachments.files.length) throw Error("Reconnect the workspace server to upload these files. They are saved on this device.");
			let uploaded: string[] = [];
			if (attachments.files.length) {
				const current = await open();
				const sessionId = referenceKey(computer, current.session!);
				const state = await api<{ sessions: WorkspaceState["sessions"] }>("/state", undefined, computer);
				const activation = state.sessions.find(item => item.key === current.session)?.activation;
				uploaded = await attachments.upload(sessionId, command => api(`/sessions/${sessionId}/uploads`, { activation, command }));
			}
			if (epoch.current !== generation) return;
			const input: Pending = { id: crypto.randomUUID(), text: dictated.current ? withDictationNote(text.trim()) : text.trim(), draft: text,
				attachments: uploaded, files: attachments.files.map(file => file.id) };
			localStorage.setItem(`${storageKey}:pending`, JSON.stringify(input)); pendingRef.current = input; setPending(input); dictated.current = false;
			await deliver(input);
		} catch (error) { if (epoch.current === generation) setError(failure(error)); }
		finally { if (epoch.current === generation) setBusy(false); }
	};
	const openWork = (work: HomeWork) => openConversation(referenceKey(work.computer ?? computer, work.id), work.view);
	return <>
		<header className="topbar home-topbar"><button className="icon-button mobile-nav" aria-label="Open navigation" onClick={openNavigation}>☰</button>
			<div className="conversation-heading"><strong>Home</strong><span>{snapshot.busy ? "Arranging and working…" : "Your work, in one place"}</span></div>
			<div className="top-actions"><span className="home-run" title={snapshot.run ? `${snapshot.run.input} input · ${snapshot.run.output} output · ${snapshot.run.cacheRead} cached tokens` : undefined}>
				{snapshot.run ? `$${snapshot.run.cost.toFixed(4)} last run` : "Terra 6.1"}</span>
				<button className="subtle-button" disabled={!key} onClick={() => {
					if (key && session) openConversation(key);
					else void open().then(next => { if (next.session) openConversation(referenceKey(computer, next.session)); }).catch(error => setError(failure(error)));
				}}>History</button><button className={`icon-button${chatOpen ? " selected" : ""}`} aria-label={chatOpen ? "Hide the conversation" : "Show the conversation"} aria-pressed={chatOpen} onClick={toggleChat}><Icon name="chat" /></button></div>
		</header>
		{(!online || error || snapshot.error) && <div className="connection-banner" role="status">{error || snapshot.error || (host.computers && !server ? "Choose a workspace server under Computers → Keep conversation copies to use Home." : "Workspace server offline. Your canvas and draft stay here.")}</div>}
		<div className={`home-body${chatOpen ? " chat-open" : ""}`}>
		<HomeCanvas svg={snapshot.scene.svg} work={snapshot.work ?? []} open={openWork} />
		<section className="home-chat" aria-label="Talk to Home">
			{chatOpen && <div className="home-log" ref={log} role="log" aria-live="polite">
				{snapshot.messages.length ? snapshot.messages.map((message, index) => <MessageView key={message.id} message={chatMessage(message, index)} sessionKey={key ?? "home"} />)
					: <p className="home-log-empty">Ask Home to add, change or rearrange anything.</p>}
				{snapshot.busy && <p className="home-log-busy">Working…</p>}
			</div>}
			{session?.inputs?.some(input => input.state === "failed" || input.state === "interrupted") && <button className="question-banner" onClick={() => key && openConversation(key)}>A Home message needs review. Open history →</button>}
			{session?.ui?.interactions.length ? <button className="question-banner" onClick={() => key && openConversation(key)}><strong>Home needs your answer</strong><span>Open →</span></button> : null}
			{!chatOpen && latest && <div className="home-reply markdown" role="log" aria-live="polite"><Markdown remarkPlugins={[remarkGfm]}>{latest.text}</Markdown></div>}
			{pending && <div className="home-pending" role="status">{online ? busy ? "Sending…" : "Delivery not confirmed" : "Queued · offline"}<span><button className="text-button" disabled={!online || busy} onClick={() => void deliver(pending)}>Check delivery</button><button className="text-button" disabled={busy} onClick={() => setDiscardPending(true)}>Discard local attempt</button></span></div>}
			<AttachmentList files={attachments.files} remove={id => attachments.remove(id)} disabled={busy || !!pending} />
			<input type="file" multiple hidden ref={picker} onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
			<form className="home-compose" onSubmit={event => { event.preventDefault(); void send(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
				onDrop={event => { event.preventDefault(); if (!busy && !pending) attachments.add(event.dataTransfer.files); }}>
				<button type="button" className="icon-button" aria-label="Attach files" disabled={busy || !!pending} onClick={() => picker.current?.click()}><Icon name="plus" /></button>
				<textarea ref={editor} rows={1} aria-label="Message Home" placeholder="Tell Desk what you need…" value={draft} maxLength={32_000} disabled={!!pending} onChange={event => saveDraft(event.target.value)}
					onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); attachments.add(event.clipboardData.files); } }}
					onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
				<DictationButton disabled={!draftLoaded || busy || !!pending} computer={dictationComputer(host.computers, computer)} report={setError} append={text => { dictated.current = true; saveDraft(withDictation(draftRef.current, text)); }}
					submit={text => { dictated.current = true; const next = withDictation(draftRef.current, text); saveDraft(next); void send(next); }} />
				<button className="send-button" type="submit" aria-label="Send to Home" disabled={!draftLoaded || busy || (!draft.trim() && !attachments.files.length)}><Icon name="send" /></button>
			</form>
		</section>
		</div>
		{discardPending && <Modal title="Discard local attempt" close={() => setDiscardPending(false)}><p>This does not cancel a message already accepted by Home. Check History before sending another copy.</p><div className="dialog-actions"><button onClick={() => setDiscardPending(false)}>Keep checking</button><button onClick={() => {
			try { localStorage.removeItem(`${storageKey}:pending`); pendingRef.current = undefined; setPending(undefined); setDiscardPending(false); }
			catch (error) { setError(failure(error)); }
		}}>Discard local attempt</button></div></Modal>}
	</>;
}
/** Home's messages in the main chat's own message view. */
function chatMessage(message: HomeMessage, order: number): ChatMessage {
	return { id: message.id, order, revision: 0, role: message.role, blocks: [{ type: "text", text: message.text }], timestamp: message.at };
}

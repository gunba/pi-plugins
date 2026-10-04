import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { DotInput, DotMessage, DotSnapshot } from "../shared/dot.ts";
import type { Computer } from "./workspace.ts";
import { api, ApiError } from "./connection.ts";

const empty: DotSnapshot = { state: "disconnected", messages: [], inputs: [] };
const errorText = (error: unknown) => error instanceof ApiError && error.status === 404
	? "Update Desk on this computer to connect Dot." : error instanceof Error ? error.message : String(error);
const storageKey = (computer?: string) => `pi-desk:dot:${computer ?? "local"}`;
interface Pending { id: string; dot: string; text: string }
const merge = (older: DotMessage[], newer: DotMessage[]) => [...new Map([...older, ...newer].map(message => [message.id, message])).values()]
	.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));

export function DotPane({ computers }: { computers?: Computer[] }) {
	const [chosen, setChosen] = useState(() => localStorage.getItem("pi-desk:dot-computer") ?? "");
	const computer = computers ? (computers.find(item => item.id === chosen) ?? computers.find(item => item.connected) ?? computers[0]) : undefined;
	const id = computer?.id, online = !computers || !!computer?.connected;
	useEffect(() => { if (id && !chosen) { setChosen(id); localStorage.setItem("pi-desk:dot-computer", id); } }, [id, chosen]);
	const [view, setView] = useState<DotSnapshot>(empty);
	const [older, setOlder] = useState<DotMessage[]>([]);
	const [before, setBefore] = useState<string>();
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState<Pending>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [loadingHistory, setLoadingHistory] = useState(false);
	const feed = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const generation = useRef(0);
	const pendingRef = useRef(pending); pendingRef.current = pending;
	const draftRef = useRef(draft); draftRef.current = draft;
	const savePending = (value?: Pending) => {
		setPending(value); pendingRef.current = value;
		value ? localStorage.setItem(`${storageKey(id)}:pending`, JSON.stringify(value)) : localStorage.removeItem(`${storageKey(id)}:pending`);
	};
	const saveDraft = (text: string) => { setDraft(text); localStorage.setItem(`${storageKey(id)}:draft`, text); };
	const settled = (input: DotInput) => {
		if (input.state === "accepted") {
			if (draftRef.current.trim() === input.text) saveDraft("");
			savePending();
		} else if (input.state === "not-sent") {
			if (!draftRef.current) saveDraft(input.text);
			savePending(); setError(input.error ?? "Message was not sent. Your draft is retained.");
		}
	};
	useEffect(() => {
		const epoch = ++generation.current;
		setView(empty); setOlder([]); setBefore(undefined); setError(""); setBusy(false);
		setDraft(localStorage.getItem(`${storageKey(id)}:draft`) ?? "");
		try { setPending(JSON.parse(localStorage.getItem(`${storageKey(id)}:pending`) ?? "null") ?? undefined); }
		catch { setPending(undefined); }
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				if (online && !document.hidden) {
					const next = await api<DotSnapshot>("/dot", undefined, id);
					if (generation.current !== epoch) return;
					setView(next);
					const input = next.inputs.find(input => input.id === pendingRef.current?.id);
					if (input) settled(input);
				}
			} catch (error) { if (generation.current === epoch) setError(errorText(error)); }
			if (generation.current === epoch) timer = setTimeout(refresh, 2_000);
		};
		void refresh();
		return () => { generation.current++; clearTimeout(timer); };
	}, [id, online]);
	const messages = merge(older, view.messages);
	const last = messages.at(-1);
	useEffect(() => { if (atBottom.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [last?.id, last?.text]);
	const action = async (name: "connect" | "disconnect") => {
		const epoch = generation.current; setBusy(true); setError("");
		try {
			await api(`/dot/${name}`, {}, id);
			const next = await api<DotSnapshot>("/dot", undefined, id);
			if (epoch === generation.current) { setView(next); setOlder([]); setBefore(undefined); }
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const send = async () => {
		if (busy || pendingRef.current || !draft.trim() || !view.id) return;
		const epoch = generation.current, input = { id: crypto.randomUUID(), dot: view.id, text: draft.trim() };
		savePending(input); setBusy(true); setError("");
		try {
			const response = await api<{ input: DotInput }>("/dot/inputs", input, id);
			if (epoch !== generation.current) return;
			setView(previous => ({ ...previous, inputs: [response.input, ...previous.inputs.filter(item => item.id !== input.id)] }));
			if (response.input.state === "sending" && draftRef.current.trim() === input.text) saveDraft("");
			settled(response.input);
		} catch (error) { if (epoch === generation.current) setError(`${errorText(error)} Check delivery before trying again.`); }
		finally { if (epoch === generation.current) setBusy(false); }
	};
	const check = async () => {
		if (!pending || busy) return;
		const epoch = generation.current; setBusy(true);
		try {
			const result = await api<{ input: DotInput | null }>(`/dot/inputs/${pending.id}`, undefined, id);
			if (epoch !== generation.current) return;
			if (result.input) { settled(result.input); setView(previous => ({ ...previous, inputs: [result.input!, ...previous.inputs.filter(item => item.id !== result.input!.id)] })); }
			else { savePending(); setError("Desk did not admit this message. Your draft is retained."); }
		} catch (error) { if (epoch === generation.current) setError(errorText(error)); }
		finally { if (epoch === generation.current) setBusy(false); }
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
	const receipt = view.inputs.find(input => input.id === pending?.id);
	const ready = online && view.state === "ready";
	return <section className="dot-pane" aria-label="Dot conversation">
		<div className="dot-connection">
			{computers && <label>Connection computer<select value={id ?? ""} disabled={busy || !!pending} onChange={event => {
				setChosen(event.target.value); localStorage.setItem("pi-desk:dot-computer", event.target.value);
			}}>{computers.map(computer => <option key={computer.id} value={computer.id}>{computer.name}{computer.connected ? "" : " · Offline"}</option>)}</select></label>}
			<div className="dot-identity"><strong>{view.name ?? "Dot"}</strong><span>{!online ? "Computer offline" : view.state === "ready" ? view.paused ? "Paused" : "Connected" : view.state === "connecting" ? "Connecting…" : "Not connected"}</span>
				<button className="subtle-button" disabled={!online || busy || view.state === "connecting" || receipt?.state === "sending"} onClick={() => void action(ready ? "disconnect" : "connect")}>{ready ? "Disconnect" : "Connect"}</button></div>
		</div>
		{!ready && view.state !== "connecting" && <p className="dot-hint">Connect the Dot already in your ChatGPT account. Chrome on this computer must be signed in; its tab runs in the background.</p>}
		{(error || view.error) && <p className="dot-error" role="alert">{error || view.error}</p>}
		<div className="dot-feed" ref={feed} role="log" aria-live="polite" onScroll={event => { const n = event.currentTarget; atBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; }}>
			{(before ?? view.before) && <button className="subtle-button" disabled={loadingHistory} onClick={() => void history()}>{loadingHistory ? "Loading…" : "Earlier messages"}</button>}
			{messages.map(message => <article key={message.id} className={`dot-message dot-${message.author}`}>
				<div className="dot-message-heading"><strong>{message.author === "dot" ? view.name ?? "Dot" : message.author === "owner" ? "You" : message.name ?? "Message"}</strong><time dateTime={message.created}>{new Date(message.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
				<Markdown components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{message.text}</Markdown>
				{message.attachments.map((name, index) => <small className="dot-attachment" key={index}>{name}</small>)}
			</article>)}
			{ready && !messages.length && <p className="dot-hint">Messages will appear here.</p>}
		</div>
		{pending && <div className="dot-receipt" role="status"><span>{receipt?.state === "sending" ? "Sending…" : receipt?.error ?? "Delivery is unconfirmed."}</span>
			<button className="subtle-button" disabled={busy} onClick={() => void check()}>Check delivery</button>
			{receipt?.state === "unknown" && <button className="subtle-button" onClick={() => { savePending(); setError("Delivery remains unconfirmed. Your draft is retained; check Dot before sending it again."); }}>I’ve reviewed Dot</button>}
		</div>}
		<form className="dot-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
			<textarea aria-label="Message Dot" placeholder={`Message ${view.name ?? "Dot"}`} rows={3} value={draft} maxLength={32_000} onChange={event => saveDraft(event.target.value)} onKeyDown={event => {
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
			}} />
			<button type="submit" disabled={!ready || busy || !!pending || !draft.trim()}>Send</button>
		</form>
	</section>;
}

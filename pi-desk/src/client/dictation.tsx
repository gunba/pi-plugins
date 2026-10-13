import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import type { Computer, WorkspaceState } from "./workspace.ts";
import type { DictationSettings } from "../shared/protocol.ts";

/** Recordings stay within one request: five minutes of speech at 16 kbit/s. */
const MAX_SECONDS = 5 * 60;
const MIME = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(type => globalThis.MediaRecorder?.isTypeSupported?.(type));

/**
 * The computer that transcribes: the conversation's own when it can, otherwise any connected computer that can.
 * undefined means this browser's local host; null means none can.
 */
export function dictationComputer(computers: Computer[] | undefined, preferred: string | undefined, localDictation?: boolean): string | undefined | null {
	if (!computers?.length) return localDictation ? undefined : null;
	const able = computers.filter(computer => computer.connected && computer.dictation);
	return (able.find(computer => computer.id === preferred) ?? able[0])?.id ?? null;
}

const blobBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
	reader.onerror = () => reject(reader.error ?? new Error("The recording could not be read."));
	reader.readAsDataURL(blob);
});

/**
 * Dictate into a composer: record while the button is on, then the whole clip is transcribed by ElevenLabs and
 * added to the draft. Nothing appears while speaking, and nothing is sent.
 */
export function DictationButton({ append, disabled, report, computer }: {
	append: (text: string) => void; disabled?: boolean; report: (error: string) => void;
	/** From dictationComputer: the computer that transcribes, undefined for this host, null when none can. */
	computer: string | undefined | null;
}) {
	const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle"), [seconds, setSeconds] = useState(0);
	const recorder = useRef<MediaRecorder | undefined>(undefined), discard = useRef(false);
	useEffect(() => () => { discard.current = true; recorder.current?.stop(); }, []);
	useEffect(() => {
		if (phase !== "recording") return;
		const started = Date.now();
		const timer = setInterval(() => {
			const elapsed = Math.floor((Date.now() - started) / 1000);
			setSeconds(elapsed);
			if (elapsed >= MAX_SECONDS) recorder.current?.stop();
		}, 250);
		return () => clearInterval(timer);
	}, [phase]);
	if (!MIME || !navigator.mediaDevices?.getUserMedia) return null;
	const unavailable = computer === null;

	const start = async () => {
		let stream: MediaStream;
		try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
		catch (error) { report(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow microphone access for this site to dictate." : "No microphone is available."); return; }
		const chunks: Blob[] = [], media = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 16_000 });
		discard.current = false;
		media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
		media.onstop = async () => {
			stream.getTracks().forEach(track => track.stop());
			recorder.current = undefined;
			if (discard.current || !chunks.length) { setPhase("idle"); return; }
			setPhase("transcribing");
			try {
				const clip = new Blob(chunks, { type: MIME });
				const language = navigator.language?.slice(0, 2).toLowerCase();
				const { text } = await api<{ text: string }>("/dictation", { audio: await blobBase64(clip), mime: MIME, ...(language ? { language } : {}) }, computer ?? undefined);
				if (text.trim()) append(text.trim());
				else report("No speech was heard in that recording.");
			} catch (error) { report(error instanceof Error ? error.message : String(error)); }
			finally { setPhase("idle"); }
		};
		recorder.current = media;
		media.start(1000);
		setSeconds(0); setPhase("recording");
	};
	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return <span className="dictation">
		{phase === "recording" && <span className="dictation-status" role="status">
			<span className="dictation-dot" aria-hidden="true" />{clock}
			<button type="button" className="quiet-action" onClick={() => { discard.current = true; recorder.current?.stop(); }}>Cancel</button>
		</span>}
		{phase === "transcribing" && <span className="dictation-status" role="status">Transcribing…</span>}
		<button type="button" className={`icon-button dictation-button${phase === "recording" ? " listening" : ""}`}
			disabled={phase === "transcribing" || (disabled || unavailable) && phase !== "recording"} aria-pressed={phase === "recording"}
			aria-label={phase === "recording" ? "Stop and transcribe" : "Dictate"}
			title={unavailable ? "Dictation needs an ElevenLabs API key: add one in Settings & tools → Dictation" : phase === "recording" ? "Stop and transcribe" : "Dictate"}
			onClick={() => phase === "recording" ? recorder.current?.stop() : void start()}><Icon name="mic" /></button>
	</span>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Settings & tools → Dictation: the ElevenLabs key and the terms to recognise, kept on one computer. */
export function DictationSettingsPanel({ host, computer, connected }: { host: WorkspaceState; computer?: Computer; connected: boolean }) {
	const [chosen, setChosen] = useState("");
	const computers = host.computers;
	const id = chosen || computer?.id || computers?.find(item => item.connected)?.id || computers?.[0]?.id;
	const target = computers?.find(item => item.id === id);
	return <>
		{computers && <label className="setting-control">Computer<select aria-label="Dictation computer" value={id ?? ""} onChange={event => setChosen(event.target.value)}>
			{!computers.length && <option value="">No computers</option>}
			{computers.map(item => <option key={item.id} value={item.id}>{item.name}{item.connected ? "" : " — disconnected"}</option>)}
		</select></label>}
		{(!computers || id) && <DictationKey key={id ?? "local"} computer={id} name={target?.name ?? host.name}
			connected={computers ? !!target?.connected : connected} />}
	</>;
}

function DictationKey({ computer, name, connected }: { computer?: string; name: string; connected: boolean }) {
	const [settings, setSettings] = useState<DictationSettings>();
	const [key, setKey] = useState(""), [terms, setTerms] = useState("");
	const [error, setError] = useState(""), [notice, setNotice] = useState(""), [working, setWorking] = useState(false);
	const show = (value: DictationSettings) => { setSettings(value); setTerms(value.keyterms.join("\n")); };
	useEffect(() => {
		if (!connected) return;
		let live = true;
		api<DictationSettings>("/dictation/settings", undefined, computer).then(value => { if (live) show(value); }, error => { if (live) setError(message(error)); });
		return () => { live = false; };
	}, [computer, connected]);
	const save = (body: Record<string, unknown>, done: string) => {
		setWorking(true); setError(""); setNotice("");
		api<DictationSettings>("/dictation/settings", body, computer)
			.then(value => { show(value); setKey(""); setNotice(done); }, error => setError(message(error)))
			.finally(() => setWorking(false));
	};
	const disabled = !connected || working || !settings;
	return <>
		<section className="panel-card"><h3><Icon name="mic" />ElevenLabs</h3>
			<p className="muted">Dictation records the whole clip, then {name} sends it to ElevenLabs Scribe to transcribe. Browsers use the
				conversation's computer when it has a key, otherwise any connected computer that does.</p>
			{!connected && <p className="muted">This computer is disconnected.</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			{notice && <p className="muted" role="status">{notice}</p>}
			{settings && <p className="muted">{settings.configured ? `${name} has a key; dictation is on.` : `${name} has no key yet.`}</p>}
			<form className="provider-account-add" onSubmit={event => { event.preventDefault(); save({ key }, `Key saved on ${name}.`); }}>
				<label>{settings?.configured ? "Replace API key" : "API key"}<input type="password" autoComplete="off" spellCheck={false} maxLength={200}
					value={key} placeholder="sk_…" disabled={disabled} onChange={event => setKey(event.target.value)} /></label>
				<button type="submit" disabled={disabled || !key.trim()}>Save key</button>
			</form>
			<p className="muted">Create one under <a href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener noreferrer">ElevenLabs API keys ↗</a>.
				It only needs speech-to-text access.</p>
			{settings?.configured && <button className="quiet-action" disabled={disabled}
				onClick={() => save({ key: null }, `Key removed; dictation is off on ${name}.`)}>Remove key</button>}
		</section>
		{settings?.configured && <section className="panel-card"><h3>Terms to recognise</h3>
			<p className="muted">One per line: names, products and jargon to spell your way, up to 100. Any terms add about 20% to the cost.</p>
			<textarea aria-label="Terms to recognise" rows={6} spellCheck={false} value={terms} disabled={disabled} onChange={event => setTerms(event.target.value)} />
			<button disabled={disabled || terms === settings.keyterms.join("\n")} onClick={() => save({ keyterms: terms.split("\n") }, "Terms saved.")}>Save terms</button>
		</section>}
	</>;
}

/** Join dictated text onto a draft with sensible spacing. */
export function withDictation(draft: string, text: string): string {
	if (!draft) return text[0]!.toUpperCase() + text.slice(1);
	return /[\s]$/.test(draft) ? draft + text : `${draft} ${text}`;
}

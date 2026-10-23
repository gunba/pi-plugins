import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { Row } from "./settings-pages.tsx";
import type { Computer } from "./workspace.ts";
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

/** Below this peak level a whole clip is silence: the microphone gave nothing to transcribe. */
const SILENCE = 0.01;
/**
 * The microphone's level while recording. Created within the click or key press, so browsers let it run.
 * `peak` is undefined when the level could not be measured, so a clip is never refused on a guess.
 */
function levelMeter(show: (level: number) => void) {
	let context: AudioContext | undefined, timer: ReturnType<typeof setInterval> | undefined, peak = 0;
	try { context = new AudioContext(); void context.resume(); } catch { context = undefined; }
	return {
		listen(stream: MediaStream) {
			if (!context) return;
			const analyser = context.createAnalyser(), data = new Float32Array(1024);
			analyser.fftSize = 1024; context.createMediaStreamSource(stream).connect(analyser);
			timer = setInterval(() => {
				analyser.getFloatTimeDomainData(data);
				let level = 0;
				for (const value of data) level = Math.max(level, Math.abs(value));
				peak = Math.max(peak, level); show(level);
			}, 100);
		},
		peak: () => context?.state === "running" && timer ? peak : undefined,
		close() { clearInterval(timer); timer = undefined; void context?.close().catch(() => {}); context = undefined; },
	};
}

/** Holding the shortcut at least this long records only while it is held. */
const HOLD_MS = 400;
type Finish = "insert" | "send" | "discard";
type Phase = "idle" | "starting" | "recording" | "transcribing";

/**
 * Dictate into a composer. The whole clip is transcribed by ElevenLabs when recording stops, so pauses to think
 * cost nothing. Ctrl+Space starts recording; while it records, Ctrl+Space again adds the text to the draft, Enter
 * sends the draft with it, and Esc discards the clip. Holding Ctrl+Space records only while it is held.
 */
export function DictationButton({ append, submit, disabled, report, computer }: {
	append: (text: string) => void; disabled?: boolean; report: (error: string) => void;
	/** Sends the draft with the dictated text, which never appears in the composer. */
	submit?: (text: string) => void;
	/** From dictationComputer: the computer that transcribes, undefined for this host, null when none can. */
	computer: string | undefined | null;
}) {
	const [phase, setPhaseState] = useState<Phase>("idle"), [seconds, setSeconds] = useState(0), [level, setLevel] = useState(0);
	const recorder = useRef<MediaRecorder | undefined>(undefined), phaseRef = useRef<Phase>("idle"), finish = useRef<Finish>("insert");
	const held = useRef<number | undefined>(undefined), pending = useRef(false), button = useRef<HTMLButtonElement>(null);
	// The shortcut listener is registered once; it reads the current props from here.
	const latest = useRef({ append, submit, disabled, report, computer });
	latest.current = { append, submit, disabled, report, computer };
	const setPhase = (next: Phase) => { phaseRef.current = next; setPhaseState(next); };
	const stop = (how: Finish) => {
		finish.current = how;
		if (recorder.current?.state === "recording") recorder.current.stop();
		// The microphone is still opening: stop as soon as it records.
		else if (phaseRef.current === "starting") pending.current = true;
	};
	const start = async () => {
		if (phaseRef.current !== "idle") return;
		setPhase("starting"); finish.current = "insert"; pending.current = false; setLevel(0);
		const meter = levelMeter(setLevel);
		let stream: MediaStream;
		// No echo cancellation: nothing plays while dictating, and asking for it makes Android record through its
		// voice-call path, which can pick another microphone (such as earbuds) or give silence.
		try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
		catch (error) {
			meter.close(); setPhase("idle");
			latest.current.report(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow microphone access for this site to dictate." : "No microphone is available.");
			return;
		}
		meter.listen(stream);
		const chunks: Blob[] = [], media = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 16_000 });
		media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
		media.onstop = async () => {
			stream.getTracks().forEach(track => track.stop());
			recorder.current = undefined;
			const how = finish.current, peak = meter.peak();
			meter.close();
			if (how === "discard" || !chunks.length) { setPhase("idle"); return; }
			if (peak !== undefined && peak < SILENCE) {
				setPhase("idle");
				latest.current.report("The microphone recorded only silence. Check the browser is using the right microphone; on Android, another app such as voice typing or the Assistant may be holding it.");
				return;
			}
			setPhase("transcribing");
			try {
				const clip = new Blob(chunks, { type: MIME });
				const language = navigator.language?.slice(0, 2).toLowerCase();
				const { text } = await api<{ text: string }>("/dictation", { audio: await blobBase64(clip), mime: MIME, ...(language ? { language } : {}), ...(peak !== undefined ? { peak } : {}) }, latest.current.computer ?? undefined);
				if (!text.trim()) latest.current.report("No speech was heard in that recording.");
				else if (how === "send" && latest.current.submit) latest.current.submit(text.trim());
				else latest.current.append(text.trim());
			} catch (error) { latest.current.report(error instanceof Error ? error.message : String(error)); }
			finally { setPhase("idle"); }
		};
		recorder.current = media;
		media.start(1000);
		setSeconds(0); setPhase("recording");
		if (pending.current) media.stop();
	};
	useEffect(() => () => { finish.current = "discard"; recorder.current?.stop(); }, []);
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
	useEffect(() => {
		if (!MIME || !navigator.mediaDevices?.getUserMedia) return;
		// Only the composer on screen answers the shortcut.
		const shown = () => !!button.current?.isConnected && button.current.offsetParent !== null;
		const active = () => phaseRef.current === "starting" || phaseRef.current === "recording";
		const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopPropagation(); };
		const down = (event: KeyboardEvent) => {
			if (!shown()) return;
			if (event.code === "Space" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
				consume(event);
				if (event.repeat) return;
				if (active()) { held.current = undefined; stop("insert"); }
				else if (phaseRef.current === "idle" && !latest.current.disabled && latest.current.computer !== null) { held.current = Date.now(); void start(); }
				return;
			}
			if (!active() || event.isComposing) return;
			// Captured before the composer's own Enter handler, which would send the draft without this clip.
			if (event.key === "Enter" && !event.shiftKey) { consume(event); held.current = undefined; stop(latest.current.submit ? "send" : "insert"); }
			else if (event.key === "Escape") { consume(event); held.current = undefined; stop("discard"); }
		};
		const up = (event: KeyboardEvent) => {
			if (held.current === undefined || event.code !== "Space" && event.key !== "Control") return;
			const since = held.current;
			held.current = undefined;
			if (Date.now() - since >= HOLD_MS) stop("insert");
		};
		addEventListener("keydown", down, true); addEventListener("keyup", up, true);
		return () => { removeEventListener("keydown", down, true); removeEventListener("keyup", up, true); };
	}, []);
	if (!MIME || !navigator.mediaDevices?.getUserMedia) return null;
	const unavailable = computer === null, recording = phase === "recording" || phase === "starting";
	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return <span className="dictation">
		{recording && <span className="dictation-status" role="status">
			<span className="dictation-dot" aria-hidden="true" />{clock}
			<span className="dictation-level" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, Math.sqrt(level) * 1.6)})` }} /></span>
			<span className="dictation-keys">Enter sends · Esc cancels</span>
			<button type="button" className="quiet-action" onClick={() => stop("discard")}>Cancel</button>
		</span>}
		{phase === "transcribing" && <span className="dictation-status" role="status">Transcribing…</span>}
		<button ref={button} type="button" className={`icon-button dictation-button${recording ? " listening" : ""}`}
			disabled={phase === "transcribing" || (disabled || unavailable) && !recording} aria-pressed={recording}
			aria-label={recording ? "Stop and transcribe" : "Dictate"} aria-keyshortcuts="Control+Space"
			title={unavailable ? "Dictation needs an ElevenLabs API key: add one in Settings → Accounts & connections"
				: recording ? "Stop and add the text (Ctrl+Space)" : "Dictate (Ctrl+Space; hold to talk)"}
			onClick={() => recording ? stop("insert") : void start()}><Icon name="mic" /></button>
	</span>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Settings → Accounts & connections: the ElevenLabs key and the terms to recognise, kept on one computer. */
export function DictationKey({ computer, name, connected }: { computer?: string; name: string; connected: boolean }) {
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
	return <section className="settings-group">
		<Row label="ElevenLabs key" hint={`${name} sends each recorded clip to ElevenLabs Scribe. Browsers use the conversation's computer when it has a key, otherwise any connected computer that does. The key needs only speech-to-text access.`}>
			<span className="muted">{!connected ? "disconnected" : !settings ? "…" : settings.configured ? "saved · dictation on" : "none · dictation off"}</span>
			<form className="settings-inline-form" onSubmit={event => { event.preventDefault(); save({ key }, `Key saved on ${name}.`); }}>
				<input type="password" aria-label={settings?.configured ? "Replace API key" : "API key"} autoComplete="off" spellCheck={false} maxLength={200}
					value={key} placeholder={settings?.configured ? "Replace key" : "sk_…"} disabled={disabled} onChange={event => setKey(event.target.value)} />
				<button type="submit" disabled={disabled || !key.trim()}>Save</button>
			</form>
			{settings?.configured ? <button className="quiet-action" disabled={disabled} onClick={() => save({ key: null }, `Key removed; dictation is off on ${name}.`)}>Remove</button>
				: <a className="quiet-action" href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener noreferrer">Get a key ↗</a>}
		</Row>
		{(error || notice) && <Row label=""><span className={error ? "error-text" : "muted"} role={error ? "alert" : "status"}>{error || notice}</span></Row>}
		{settings?.configured && <Row label="Terms to recognise" hint="One per line, up to 100: names, products and jargon spelt your way. Any terms add about 20% to the cost.">
			<textarea className="grow" aria-label="Terms to recognise" rows={3} spellCheck={false} value={terms} disabled={disabled} placeholder="One per line" onChange={event => setTerms(event.target.value)} />
			<button disabled={disabled || terms === settings.keyterms.join("\n")} onClick={() => save({ keyterms: terms.split("\n") }, "Terms saved.")}>Save</button>
		</Row>}
	</section>;
}

/** Join dictated text onto a draft with sensible spacing. */
export function withDictation(draft: string, text: string): string {
	if (!draft) return text[0]!.toUpperCase() + text.slice(1);
	return /[\s]$/.test(draft) ? draft + text : `${draft} ${text}`;
}

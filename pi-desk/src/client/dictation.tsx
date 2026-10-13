import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import type { Computer } from "./workspace.ts";

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
 * Dictate into a composer: record while the button is on, then the whole clip is transcribed with Whisper and
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
			title={unavailable ? "Dictation needs a computer with Whisper, such as Fedora, to be connected" : phase === "recording" ? "Stop and transcribe" : "Dictate"}
			onClick={() => phase === "recording" ? recorder.current?.stop() : void start()}><Icon name="mic" /></button>
	</span>;
}

/** Join dictated text onto a draft with sensible spacing. */
export function withDictation(draft: string, text: string): string {
	if (!draft) return text[0]!.toUpperCase() + text.slice(1);
	return /[\s]$/.test(draft) ? draft + text : `${draft} ${text}`;
}

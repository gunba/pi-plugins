import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

interface Recognition extends EventTarget {
	lang: string; continuous: boolean; interimResults: boolean; processLocally?: boolean;
	start(): void; stop(): void; abort(): void;
	onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
}
type RecognitionClass = (new () => Recognition) & { available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string> };
const Speech = (globalThis as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }).SpeechRecognition
	?? (globalThis as unknown as { webkitSpeechRecognition?: RecognitionClass }).webkitSpeechRecognition;

const ERRORS: Record<string, string> = {
	"not-allowed": "Allow microphone access for this site to dictate.", "service-not-allowed": "This browser does not allow dictation here.",
	"audio-capture": "No microphone was found.", network: "Dictation needs an internet connection in this browser.", "language-not-supported": "Dictation does not support this language here.",
};

/** Speak into a composer: finished phrases are added to the draft; the phrase in progress shows beside the button. */
export function DictationButton({ append, disabled, report }: { append: (text: string) => void; disabled?: boolean; report: (error: string) => void }) {
	const [listening, setListening] = useState(false), [partial, setPartial] = useState("");
	const recognition = useRef<Recognition | undefined>(undefined);
	useEffect(() => () => recognition.current?.abort(), []);
	if (!Speech) return null;
	const start = async () => {
		const lang = navigator.language || "en-AU", instance = new Speech();
		instance.lang = lang; instance.continuous = true; instance.interimResults = true;
		// Prefer the browser's on-device recognizer where it has one installed; otherwise the browser's own service is used.
		try { if (await Speech.available?.({ langs: [lang], processLocally: true }) === "available") instance.processLocally = true; } catch { /* Older browsers. */ }
		instance.onresult = event => {
			let interim = "";
			for (let index = event.resultIndex; index < event.results.length; index++) {
				const result = event.results[index]!, text = result[0].transcript;
				if (result.isFinal) { if (text.trim()) append(text.trim()); }
				else interim += text;
			}
			setPartial(interim.trim());
		};
		instance.onerror = event => { if (event.error !== "no-speech" && event.error !== "aborted") report(ERRORS[event.error] ?? `Dictation stopped: ${event.error}.`); };
		instance.onend = () => { setListening(false); setPartial(""); if (recognition.current === instance) recognition.current = undefined; };
		recognition.current = instance;
		try { instance.start(); setListening(true); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
	};
	return <span className="dictation">
		{listening && <span className="dictation-partial" aria-live="polite">{partial || "Listening…"}</span>}
		<button type="button" className={`icon-button dictation-button${listening ? " listening" : ""}`} disabled={disabled && !listening}
			aria-pressed={listening} aria-label={listening ? "Stop dictation" : "Dictate"} title={listening ? "Stop dictation" : "Dictate"}
			onClick={() => listening ? recognition.current?.stop() : void start()}><Icon name="mic" /></button>
	</span>;
}

/** Join dictated text onto a draft with sensible spacing. */
export function withDictation(draft: string, text: string): string {
	if (!draft) return text[0]!.toUpperCase() + text.slice(1);
	return /[\s]$/.test(draft) ? draft + text : `${draft} ${text}`;
}

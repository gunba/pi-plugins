import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import type { DictationSettings } from "../shared/protocol.ts";
import { recordServiceUsage } from "../../../pi-service-usage/index.ts";

/**
 * How this computer transcribes dictation: an ElevenLabs API key, kept in dictation.json in Desk's data folder.
 * Without a key this computer offers no dictation, and browsers use one that does.
 */
interface DictationConfig {
	key: string;
	/** ElevenLabs speech-to-text model; default scribe_v2. */
	model?: string;
	/** Names and terms to favour, such as product names. ElevenLabs charges more for clips sent with any. */
	keyterms?: string[];
	/** USD per audio hour, used only for labeled cost estimates. */
	hourlyRate?: number;
	keytermHourlyRate?: number;
}
/** Clips are limited to what fits one request: about five minutes of speech at 16 kbit/s. */
export const MAX_DICTATION_BYTES = 800_000;
const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text", MODEL = "scribe_v2", CLIP_MS = 120_000;
/** Above 100 terms ElevenLabs bills every clip as at least 20 seconds. */
const MAX_KEYTERMS = 100;

/** The terms to save: trimmed, without repeats, and within ElevenLabs' limits. */
export function dictationTerms(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Terms must be a list.");
	const terms = [...new Set(value.map(item => typeof item === "string" ? item.trim() : "").filter(Boolean))];
	if (terms.length > MAX_KEYTERMS) throw new Error(`Keep to ${MAX_KEYTERMS} terms.`);
	const bad = terms.find(term => term.length >= 50 || term.split(/\s+/).length > 5 || /[<>{}[\]\\\x00-\x1f]/.test(term));
	if (bad) throw new Error(`"${bad.slice(0, 60)}" can't be used: keep each term under 50 characters and five words, without < > { } [ ] or \\.`);
	return terms;
}

/** Why ElevenLabs refused a clip, from whichever error shape it answered with. */
function failure(status: number, body: unknown): string {
	const detail = (body as { detail?: unknown } | undefined)?.detail;
	const reason = typeof detail === "string" ? detail
		: Array.isArray(detail) ? detail.map(item => (item as { msg?: unknown })?.msg).filter(item => typeof item === "string").join("; ")
		: typeof (detail as { message?: unknown } | undefined)?.message === "string" ? (detail as { message: string }).message : "";
	const advice = status === 401 ? " Check the API key in Settings → Accounts & connections." : "";
	return `ElevenLabs could not transcribe the recording: ${(reason || `HTTP ${status}`).slice(0, 300)}.${advice}`;
}

export class Dictation {
	private file: string;
	private agentDir: string;
	constructor(dataDir: string, agentDir = dataDir) { this.file = join(dataDir, "dictation.json"); this.agentDir = agentDir; }

	private config(): DictationConfig | undefined {
		try {
			const value = JSON.parse(readFileSync(this.file, "utf8")) as DictationConfig;
			return typeof value.key === "string" && value.key ? value : undefined;
		} catch { return undefined; }
	}
	get available(): boolean { return !!this.config(); }
	settings(): DictationSettings {
		const config = this.config();
		return { configured: !!config, keyterms: config?.keyterms ?? [], hourlyRate: config?.hourlyRate ?? 0.22, keytermHourlyRate: config?.keytermHourlyRate ?? 0.05 };
	}

	/** Save a key, terms or both; a null key turns dictation off on this computer. */
	configure(data: Record<string, unknown>): DictationSettings {
		if (data.key === null) { rmSync(this.file, { force: true }); return this.settings(); }
		if (data.key !== undefined && (typeof data.key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(data.key.trim())))
			throw new Error("Paste the API key from ElevenLabs, without spaces.");
		const current = this.config(), key = typeof data.key === "string" ? data.key.trim() : current?.key;
		if (!key) throw new Error("Enter an ElevenLabs API key.");
		const rates: Partial<DictationConfig> = {};
		for (const name of ["hourlyRate", "keytermHourlyRate"] as const) if (data[name] !== undefined) {
			const value = data[name];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) throw new Error("Enter a rate between $0 and $1,000 per hour.");
			rates[name] = value;
		}
		atomicJson(this.file, { ...current, ...rates, key, keyterms: data.keyterms === undefined ? current?.keyterms ?? [] : dictationTerms(data.keyterms) });
		return this.settings();
	}

	/** Transcribe one recorded clip. */
	async transcribe(audio: Buffer, mime: string, language?: string, recordedSeconds?: number): Promise<{ text: string; usageWarning?: string }> {
		const config = this.config();
		if (!config) throw new Error("Dictation is not set up on this computer.");
		if (!audio.length) throw new Error("The recording was empty.");
		if (audio.length > MAX_DICTATION_BYTES) throw new Error("The recording is too long; keep dictation under about five minutes.");
		const form = new FormData();
		form.append("model_id", config.model ?? MODEL);
		form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `dictation.${/ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : "webm"}`);
		// Dictation wants the words alone: no (laughter) tags, filler words or false starts.
		form.append("tag_audio_events", "false");
		form.append("no_verbatim", "true");
		if (language) form.append("language_code", language);
		for (const term of config.keyterms ?? []) form.append("keyterms", term);
		const charge = (seconds?: number) => recordServiceUsage(this.agentDir, { service: "elevenlabs", operation: config.model ?? MODEL,
			seconds, estimated: true, ...(seconds === undefined ? {} : { cost: seconds / 3600 * ((config.hourlyRate ?? 0.22) + (config.keyterms?.length ? config.keytermHourlyRate ?? 0.05 : 0)) }) });
		let response: Response;
		try { response = await fetch(ENDPOINT, { method: "POST", headers: { "xi-api-key": config.key }, body: form, signal: AbortSignal.timeout(CLIP_MS) }); }
		catch (error) {
			const warning = charge(); if (warning) console.error(warning);
			throw new Error(error instanceof Error && error.name === "TimeoutError" ? "Transcription took too long."
				: `ElevenLabs could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		}
		const body = await response.json().catch(() => undefined) as { text?: unknown; audio_duration_secs?: unknown } | undefined;
		const duration = typeof body?.audio_duration_secs === "number" ? body.audio_duration_secs : recordedSeconds;
		const seconds = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
		const usageWarning = charge(response.ok ? seconds : undefined);
		if (!response.ok) { if (usageWarning) console.error(usageWarning); throw new Error(failure(response.status, body)); }
		return { text: typeof body?.text === "string" ? body.text.trim() : "", ...(usageWarning ? { usageWarning } : {}) };
	}
}

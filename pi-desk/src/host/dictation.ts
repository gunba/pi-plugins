import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How this computer transcribes dictation: a faster-whisper installation, named in dictation.json in Desk's
 * data folder. Without that file this computer offers no dictation, and browsers use one that does.
 */
export interface DictationConfig {
	/** The Python that has faster-whisper installed. */
	python: string;
	/** A faster-whisper model name or folder; default large-v3-turbo. */
	model?: string;
	/** cuda or cpu; default cuda. */
	device?: string;
	/** Where models are downloaded and kept. */
	models?: string;
}
/** Clips are limited to what fits one request: about five minutes of speech at 16 kbit/s. */
export const MAX_DICTATION_BYTES = 800_000;
const SCRIPT = fileURLToPath(new URL("../../dictation/whisper_server.py", import.meta.url));
const IDLE_MS = 10 * 60_000, START_MS = 180_000, CLIP_MS = 120_000;

/** One Whisper process, started on first use and stopped when idle so it does not hold the graphics card. */
export class Dictation {
	private file: string;
	private child?: ChildProcessWithoutNullStreams;
	private ready?: Promise<void>;
	private waiting = new Map<string, { resolve: (value: { text: string; seconds: number }) => void; reject: (error: Error) => void }>();
	private idle?: ReturnType<typeof setTimeout>;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(dataDir: string) { this.file = join(dataDir, "dictation.json"); }

	config(): DictationConfig | undefined {
		try {
			const value = JSON.parse(readFileSync(this.file, "utf8")) as DictationConfig;
			return typeof value.python === "string" && existsSync(value.python) && existsSync(SCRIPT) ? value : undefined;
		} catch { return undefined; }
	}
	get available(): boolean { return !!this.config(); }

	/** Transcribe one recorded clip, in turn with any others. */
	transcribe(audio: Buffer, mime: string, language?: string): Promise<{ text: string; seconds: number }> {
		const run = this.queue.then(() => this.run(audio, mime, language));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async run(audio: Buffer, mime: string, language?: string): Promise<{ text: string; seconds: number }> {
		if (!audio.length) throw new Error("The recording was empty.");
		if (audio.length > MAX_DICTATION_BYTES) throw new Error("The recording is too long; keep dictation under about five minutes.");
		await this.start();
		const id = randomUUID(), path = join(tmpdir(), `pi-desk-dictation-${id}.${/ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : "webm"}`);
		writeFileSync(path, audio, { mode: 0o600 });
		try {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("Transcription took too long.")); }, CLIP_MS);
				this.waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
				this.child!.stdin.write(JSON.stringify({ id, path, ...(language ? { language } : {}) }) + "\n");
			});
		} finally {
			rmSync(path, { force: true });
			clearTimeout(this.idle);
			this.idle = setTimeout(() => this.close(), IDLE_MS);
			this.idle.unref();
		}
	}

	private start(): Promise<void> {
		if (this.ready) return this.ready;
		const config = this.config();
		if (!config) return Promise.reject(new Error("Dictation is not set up on this computer."));
		const child = spawn(config.python, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
			env: { ...process.env, PI_DESK_WHISPER_MODEL: config.model ?? "large-v3-turbo", PI_DESK_WHISPER_DEVICE: config.device ?? "cuda",
				...(config.models ? { PI_DESK_WHISPER_MODELS: config.models } : {}) } });
		this.child = child;
		let errors = "", buffer = "";
		child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
		this.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error("Whisper did not start in time.")); this.close(); }, START_MS);
			child.stdout.on("data", chunk => {
				buffer += chunk;
				for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
					const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
					let message: { ready?: boolean; id?: string; text?: string; seconds?: number; error?: string };
					try { message = JSON.parse(line); } catch { continue; }
					if (message.ready) { clearTimeout(timer); resolve(); continue; }
					const waiting = message.id ? this.waiting.get(message.id) : undefined;
					if (!waiting) continue;
					this.waiting.delete(message.id!);
					if (message.error) waiting.reject(new Error(`Transcription failed: ${message.error}`));
					else waiting.resolve({ text: message.text ?? "", seconds: message.seconds ?? 0 });
				}
			});
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("exit", code => {
				clearTimeout(timer);
				const error = new Error(`Whisper stopped${code === null ? "" : ` (exit ${code})`}${errors.trim() ? `: ${errors.trim().split("\n").at(-1)}` : "."}`);
				reject(error);
				for (const waiting of this.waiting.values()) waiting.reject(error);
				this.waiting.clear();
				if (this.child === child) { this.child = undefined; this.ready = undefined; }
			});
		});
		return this.ready;
	}

	close(): void {
		clearTimeout(this.idle);
		const child = this.child;
		this.child = undefined; this.ready = undefined;
		child?.stdin.end();
		child?.kill();
	}
}

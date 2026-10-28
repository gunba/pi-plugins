import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { get } from "node:https";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProxyAgent } from "proxy-agent";
import type { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession } from "onnxruntime-node";

const REVISION = "4328cf26390c98c5e3c738b4460a05b95f4911f5";
const REPOSITORY = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2";
export const SEARCH_EMBEDDING_MODEL = `${REPOSITORY}@${REVISION}:quint8-avx2:mean-256:v1`;
export const SEARCH_EMBEDDING_DIMENSIONS = 768;
const FILES = [
	{ remote: "onnx/model_quint8_avx2.onnx", local: "model.onnx", bytes: 278_802_503, sha256: "82f6b58b509e6f87a3c181fd08a94376499faa6c344eea0b36214d47d3943e61" },
	{ remote: "tokenizer.json", local: "tokenizer.json", bytes: 9_081_518, sha256: "2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8" },
	{ remote: "tokenizer_config.json", local: "tokenizer_config.json", bytes: 402, sha256: "a312d5bef89ec4c9355638520a31582e761f205d79df3002a3bd390d7077455f" },
] as const;

async function verified(path: string, file: typeof FILES[number]): Promise<boolean> {
	try {
		if ((await stat(path)).size !== file.bytes) return false;
		const digest = createHash("sha256");
		for await (const chunk of createReadStream(path)) digest.update(chunk);
		return digest.digest("hex") === file.sha256;
	} catch { return false; }
}
function modelUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "huggingface.co" && !url.hostname.endsWith(".hf.co"))
		throw Error("The embedding model redirected outside its trusted download hosts.");
	return url;
}
async function download(url: URL, path: string, file: typeof FILES[number], agent: ProxyAgent, signal: AbortSignal, redirects = 0): Promise<void> {
	signal.throwIfAborted();
	const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
		const request = get(url, { agent, signal, headers: { "User-Agent": "Pi-Desk-conversation-search" } }, resolve);
		request.on("error", reject);
	});
	if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
		response.resume();
		if (redirects >= 5) throw Error("Too many embedding model redirects.");
		return download(modelUrl(new URL(response.headers.location, url).href), path, file, agent, signal, redirects + 1);
	}
	if (response.statusCode !== 200) { response.resume(); throw Error(`Embedding model download returned HTTP ${response.statusCode}.`); }
	const temporary = `${path}.${randomUUID()}.part`, digest = createHash("sha256");
	let bytes = 0;
	try {
		await pipeline(response, new Transform({ transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > file.bytes) { callback(Error("Embedding model download exceeded its pinned size.")); return; }
			digest.update(chunk); callback(null, chunk);
		} }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
		if (bytes !== file.bytes || digest.digest("hex") !== file.sha256) throw Error("Embedding model download did not match its pinned digest.");
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

type Job = { texts: string[]; resolve(vectors: Float32Array[]): void; reject(error: unknown): void };
/** One CPU inference session per search worker. Queries take precedence over background batches, never over an in-flight batch. */
export class SearchEmbedder {
	private session?: InferenceSession;
	private tokenizer?: Tokenizer;
	private preparing?: Promise<void>;
	private jobs: Job[] = [];
	private queries: Job[] = [];
	private draining?: Promise<void>;
	private stopped = false;
	private abort = new AbortController();
	private retryAt = 0;
	private lastError?: string;
	private progress = "Local embeddings have not started.";
	private readonly directory: string;
	private readonly options: { proxy?: string; threads?: number; changed?: () => void };
	constructor(directory: string, options: { proxy?: string; threads?: number; changed?: () => void } = {}) {
		this.directory = join(directory, REVISION); this.options = options;
	}
	get ready(): boolean { return !!this.session && !this.stopped; }
	get error(): string | undefined { return this.lastError; }
	get message(): string { return this.progress; }
	/** Start provisioning without blocking lexical search. Failed provisioning is retried after ten minutes. */
	prepare(): void {
		if (this.ready || this.preparing || this.stopped || Date.now() < this.retryAt) return;
		this.lastError = undefined;
		this.preparing = this.load().catch(error => {
			if (!this.stopped) {
				this.lastError = error instanceof Error ? error.message : String(error);
				this.progress = "Semantic search is unavailable; keyword search remains available.";
				this.retryAt = Date.now() + 10 * 60_000;
			}
		}).finally(() => { this.preparing = undefined; this.options.changed?.(); });
		this.options.changed?.();
	}
	private async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const agent = new ProxyAgent(this.options.proxy ? { getProxyForUrl: () => this.options.proxy! } : undefined);
		try {
			for (const file of FILES) {
				this.abort.signal.throwIfAborted();
				const path = join(this.directory, file.local);
				if (await verified(path, file)) continue;
				this.progress = `Downloading the pinned local embedding ${file.local === "model.onnx" ? "model (279 MB)" : "tokenizer"}.`;
				this.options.changed?.();
				await download(modelUrl(`https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/${file.remote}`), path, file, agent,
					AbortSignal.any([this.abort.signal, AbortSignal.timeout(15 * 60_000)]));
			}
		} finally { agent.destroy(); }
		this.abort.signal.throwIfAborted();
		this.progress = "Loading the CPU embedding model."; this.options.changed?.();
		const [{ Tokenizer }, ort, json, config] = await Promise.all([
			import("@huggingface/tokenizers"), import("onnxruntime-node"),
			readFile(join(this.directory, "tokenizer.json"), "utf8"), readFile(join(this.directory, "tokenizer_config.json"), "utf8"),
		]);
		this.tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
		const threads = this.options.threads ?? Math.max(1, Math.min(16, Math.floor(availableParallelism() * 0.75)));
		const session = await ort.InferenceSession.create(join(this.directory, "model.onnx"), {
			executionProviders: ["cpu"], intraOpNumThreads: threads, interOpNumThreads: 1,
			enableCpuMemArena: false, enableMemPattern: false,
			extra: { session: { "intra_op.allow_spinning": "0", "inter_op.allow_spinning": "0" } },
		});
		if (this.stopped) { await session.release(); return; }
		this.session = session; this.progress = "Local embedding model ready.";
	}
	/** Embed at most 16 bounded passages. Throws while the model is unavailable; callers must expose lexical-only coverage. */
	embed(texts: string[], query = false): Promise<Float32Array[]> {
		if (!this.ready) return Promise.reject(Error(this.lastError ?? this.progress));
		if (!texts.length || texts.length > 16 || texts.some(text => typeof text !== "string" || !text.trim() || text.length > 2000))
			return Promise.reject(Error("Invalid embedding batch."));
		if (this.jobs.length + this.queries.length >= 32) return Promise.reject(Error("Semantic search is busy; try again shortly."));
		return new Promise((resolve, reject) => {
			(query ? this.queries : this.jobs).push({ texts, resolve, reject });
			this.start();
		});
	}
	private start(): void {
		if (this.draining || this.stopped) return;
		this.draining = this.drain().finally(() => {
			this.draining = undefined;
			// A result consumer can enqueue after the loop empties but before this finalizer runs.
			if (this.jobs.length || this.queries.length) this.start();
		});
	}
	private async drain(): Promise<void> {
		while (!this.stopped) {
			const job = this.queries.shift() ?? this.jobs.shift();
			if (!job) break;
			try { job.resolve(await this.infer(job.texts)); } catch (error) { job.reject(error); }
		}
	}
	private async infer(texts: string[]): Promise<Float32Array[]> {
		const ort = await import("onnxruntime-node");
		const encoded = texts.map(text => {
			const ids = this.tokenizer!.encode(text).ids;
			// Preserve the final separator when truncating, as the reference model's tokenizer does.
			return ids.length <= 256 ? ids : [...ids.slice(0, 255), ids[ids.length - 1]!];
		});
		const length = Math.max(...encoded.map(ids => ids.length)), count = texts.length * length;
		const input = new BigInt64Array(count).fill(1n), mask = new BigInt64Array(count);
		for (let row = 0; row < encoded.length; row++) for (let column = 0; column < encoded[row]!.length; column++) {
			input[row * length + column] = BigInt(encoded[row]![column]!); mask[row * length + column] = 1n;
		}
		const feeds: Record<string, import("onnxruntime-node").Tensor> = {
			input_ids: new ort.Tensor("int64", input, [texts.length, length]), attention_mask: new ort.Tensor("int64", mask, [texts.length, length]),
		};
		if (this.session!.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(count), [texts.length, length]);
		const output = await this.session!.run(feeds);
		try {
			const hidden = output.last_hidden_state ?? Object.values(output)[0]!;
			if (hidden.type !== "float32" || hidden.dims.length !== 3 || hidden.dims[0] !== texts.length || hidden.dims[1] !== length || hidden.dims[2] !== SEARCH_EMBEDDING_DIMENSIONS)
				throw Error("Unexpected embedding model output shape.");
			const data = hidden.data as Float32Array;
			return encoded.map((ids, row) => {
				const vector = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS);
				for (let token = 0; token < ids.length; token++) for (let d = 0; d < vector.length; d++) vector[d]! += data[(row * length + token) * vector.length + d]!;
				let squared = 0;
				for (let d = 0; d < vector.length; d++) { vector[d]! /= ids.length; squared += vector[d]! * vector[d]!; }
				if (!Number.isFinite(squared) || squared <= 0) throw Error("The embedding model returned an invalid vector.");
				const norm = Math.sqrt(squared);
				for (let d = 0; d < vector.length; d++) vector[d]! /= norm;
				return vector;
			});
		} finally { for (const tensor of Object.values(output)) tensor.dispose(); for (const tensor of Object.values(feeds)) tensor.dispose(); }
	}
	/** Cancel downloads and queued inference; an in-flight native inference finishes before its session is released. */
	async close(): Promise<void> {
		this.stopped = true; this.abort.abort();
		for (const job of [...this.queries.splice(0), ...this.jobs.splice(0)]) job.reject(Error("Conversation search is closing."));
		await Promise.all([this.preparing, this.draining]);
		await this.session?.release(); this.session = undefined; this.tokenizer = undefined;
	}
}

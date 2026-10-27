import { getIdentityHeaders, type AssistantImages, type ImageApi, type ImageModel, type ImagesContext, type ImagesOptions, type Usage } from "@earendil-works/pi-ai";

export const IMAGE_API = "pi-openai-images";
export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
export const SUBSCRIPTION_ERROR = "OpenAI's Sign in with ChatGPT does not support image generation. Use an OpenAI API key or the supported ChatGPT Codex connection; no other billing method was tried.";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
type Image = ImageModel<ImageApi>;

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function imageMime(data: unknown): { data: string; mimeType: string } {
	if (typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
		throw Error("Image data is missing, invalid, or exceeds the 32 MiB limit.");
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) throw Error("Invalid image base64.");
	const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
		: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
		: bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
	if (!mimeType) throw Error("Image data must be PNG, JPEG, or WebP.");
	return { data, mimeType };
}

function requestBody(model: Image, context: ImagesContext, codex: boolean): Record<string, unknown> {
	if (!IMAGE_MODELS.some(id => model.id === id || model.id === `${id}-2026-09-08`)) throw Error("Unsupported OpenAI image model.");
	const prompt = context.input.filter(item => item.type === "text").map(item => item.text).join("\n\n").trim();
	if (!prompt) throw Error("Image generation needs a non-empty text prompt.");
	const references = context.input.filter(item => item.type === "image");
	// Retain the Codex integration's five-reference bound; the public Images API documents sixteen.
	if (references.length > (codex ? 5 : 16)) throw Error(`At most ${codex ? 5 : 16} reference images are supported by this connection.`);
	if (references.reduce((bytes, image) => bytes + image.data.length, Buffer.byteLength(prompt)) > MAX_REQUEST_BYTES)
		throw Error("Image request exceeds the 64 MiB limit.");
	const images = references.map(image => {
		const checked = imageMime(image.data);
		if (checked.mimeType !== image.mimeType) throw Error("Reference image MIME type does not match its data.");
		return { image_url: `data:${checked.mimeType};base64,${checked.data}` };
	});
	return { model: model.id, prompt, background: "auto", quality: "auto", size: "auto", ...(images.length ? { images } : {}) };
}

function endpoint(baseUrl: string, codex: boolean, edit: boolean): URL {
	const url = new URL(baseUrl);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error("Invalid image service URL.");
	let path = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
	if (codex && !path.endsWith("/codex")) path += "/codex";
	url.pathname = `${path}/images/${edit ? "edits" : "generations"}`;
	url.hash = "";
	return url;
}

function requestHeaders(model: Image, options: ImagesOptions, codex: boolean): Headers {
	const headers = new Headers({ ...getIdentityHeaders(model, options.identity), accept: "application/json", "content-type": "application/json",
		...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...(codex ? { originator: "pi" } : {}) });
	const overridden = new Set<string>();
	for (const values of [model.headers, options.headers]) for (const [key, value] of Object.entries(values ?? {})) {
		overridden.add(key.toLowerCase());
		if (value === null) headers.delete(key); else headers.set(key, value);
	}
	if (codex && !overridden.has("chatgpt-account-id")) {
		const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
		let account: unknown;
		try { account = JSON.parse(Buffer.from(bearer!.split(".")[1]!, "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id; }
		catch { /* The error below must not expose the token. */ }
		if (typeof account !== "string" || !account.trim()) throw Error("Image generation needs a valid ChatGPT Codex account token. Sign in again.");
		headers.set("chatgpt-account-id", account);
	}
	return headers;
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
	if (Number(response.headers.get("content-length")) > limit) {
		void response.body?.cancel().catch(() => {}); throw Error("Image service response exceeds the size limit.");
	}
	if (!response.body) return "";
	const reader = response.body.getReader(), decoder = new TextDecoder();
	const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	let text = "", size = 0;
	try {
		signal.throwIfAborted();
		for (;;) {
			const { value, done } = await reader.read();
			signal.throwIfAborted();
			if (done) return text + decoder.decode();
			size += value.byteLength;
			if (size > limit) throw Error("Image service response exceeds the size limit.");
			text += decoder.decode(value, { stream: true });
		}
	} catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
	finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Direct Images requests have no cache discount; text and image inputs have different rates. */
function usage(value: unknown): Usage | undefined {
	const raw = object(value), details = object(raw.input_tokens_details);
	if (!count(raw.input_tokens) || !count(raw.output_tokens) || !count(details.text_tokens) || !count(details.image_tokens)
		|| details.text_tokens + details.image_tokens !== raw.input_tokens) return;
	const input = (details.text_tokens * 5 + details.image_tokens * 8) / 1_000_000, output = raw.output_tokens * 30 / 1_000_000;
	return { input: raw.input_tokens, output: raw.output_tokens, cacheRead: 0, cacheWrite: 0, totalTokens: raw.input_tokens + raw.output_tokens,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } };
}

/** A single billable request. Errors and cancellation use Pi's native image-result contract; requests are never replayed. */
export async function generateImages(model: Image, context: ImagesContext, options: ImagesOptions = {}, unsupportedToken?: (token: string) => boolean): Promise<AssistantImages> {
	const result: AssistantImages = { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: Date.now() };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		options.signal?.throwIfAborted();
		const deadline = new AbortController();
		if (options.timeoutMs !== undefined) {
			if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw Error("Image timeout must be between 1 and 2147483647 milliseconds.");
			timer = setTimeout(() => deadline.abort(Error("Image request timed out.")), options.timeoutMs); timer.unref();
		}
		const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
		const codex = model.provider === "openai-codex", headers = requestHeaders(model, options, codex);
		const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
		if (bearer && unsupportedToken?.(bearer)) throw Error(SUBSCRIPTION_ERROR);
		let body = requestBody(model, context, codex);
		const replacement = await options.onPayload?.(body, model);
		if (replacement !== undefined) {
			if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) throw Error("Image payload must be a JSON object.");
			body = replacement as Record<string, unknown>;
		}
		const encoded = JSON.stringify(body);
		if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw Error("Image request exceeds the 64 MiB limit.");
		signal.throwIfAborted();
		const response = await (options.fetch ?? globalThis.fetch)(endpoint(model.baseUrl, codex, Array.isArray(body.images) && body.images.length > 0), {
			method: "POST", headers, body: encoded, signal, redirect: "error",
		});
		try { await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model); }
		catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
		const text = await readBody(response, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES, signal);
		if (!response.ok) {
			// Service bodies can echo prompts or credentials. Report only the status, never their raw text.
			throw Error(`Image generation failed (HTTP ${response.status}).${response.status === 401 ? " Sign in again or replace this connection's API key." : response.status === 403 ? " This account may not have image access or require organization verification." : " The request was not retried."}`);
		}
		let payload: Record<string, unknown>;
		try { payload = object(JSON.parse(text)); } catch { throw Error("Image service returned invalid JSON."); }
		result.usage = usage(payload.usage);
		if (!Array.isArray(payload.data) || !payload.data.length || payload.data.length > 10) throw Error("Image service returned no images or too many images.");
		result.output = payload.data.map(item => ({ type: "image", ...imageMime(object(item).b64_json) }));
		signal.throwIfAborted();
	} catch (error) {
		result.output = [];
		result.stopReason = options.signal?.aborted ? "aborted" : "error";
		result.errorMessage = error instanceof Error ? error.message : "Image generation failed.";
	} finally { if (timer) clearTimeout(timer); }
	return result;
}

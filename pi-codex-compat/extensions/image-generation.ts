// Request shapes, edit-reference semantics, and fixed defaults are based on
// OpenAI Codex's Apache-2.0 image-generation extension and Images endpoint:
// codex-rs/ext/image-generation and codex-rs/codex-api/src/endpoint/images.rs.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ImageConverter,
	type NativeImageContent,
	createImageContent,
	normalizeLegacyImageBlock,
	prepareNativeImageContent,
} from "./image-content.ts";
import {
	MAX_IMAGE_API_RESPONSE_BYTES,
	MAX_LOCAL_IMAGE_BYTES,
	decodedBase64ByteLength,
	readLocalImageFile,
	readResponseTextWithinLimit,
} from "./image-limits.ts";
import { isChatGptCodexModel, isImageGenerationModel } from "./model-tools.ts";

const IMAGE_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const MAX_ERROR_TEXT_CHARS = 600;

type UnknownRecord = Record<string, unknown>;
type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ImageGenerationParams = {
	prompt: string;
	referenced_image_paths?: string[];
	num_last_images_to_include?: number;
};

export type ImageGenerationDetails = {
	path: string;
	operation: "generations" | "edits";
	bytes: number;
	callId: string;
	revisedPrompt?: string;
};

export type ImageGenerationDependencies = {
	fetchImpl?: FetchLike;
	convertImage?: ImageConverter;
	codexHome?: string;
	withFileMutationQueue?: <T>(
		path: string,
		mutation: () => Promise<T>,
	) => Promise<T>;
};

type ImageRequestReference = { image_url: string };
type ConversationImageSource =
	| { kind: "inline"; image: NativeImageContent }
	| { kind: "generated-path"; path: string };

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reject lossy TypeBox coercion before Pi validates the public schema. */
export function prepareImageGenerationArguments(
	args: unknown,
): ImageGenerationParams {
	if (!isRecord(args)) return args as ImageGenerationParams;
	if (args.prompt !== undefined && typeof args.prompt !== "string") {
		throw new Error("prompt must be a string");
	}
	if (args.referenced_image_paths !== undefined) {
		if (!Array.isArray(args.referenced_image_paths)) {
			throw new Error("referenced_image_paths must be an array of strings");
		}
		if (args.referenced_image_paths.length === 0) {
			throw new Error(
				"referenced_image_paths must contain at least one path when provided",
			);
		}
		if (args.referenced_image_paths.some((path) => typeof path !== "string")) {
			throw new Error("referenced_image_paths must be an array of strings");
		}
	}
	if (
		args.num_last_images_to_include !== undefined &&
		(!Number.isSafeInteger(args.num_last_images_to_include) ||
			(args.num_last_images_to_include as number) < 1 ||
			(args.num_last_images_to_include as number) > MAX_EDIT_IMAGES)
	) {
		throw new Error(
			`num_last_images_to_include must be between 1 and ${MAX_EDIT_IMAGES}`,
		);
	}
	if (
		args.referenced_image_paths !== undefined &&
		args.num_last_images_to_include !== undefined
	) {
		throw new Error(
			"provide only one of referenced_image_paths or num_last_images_to_include",
		);
	}
	return args as ImageGenerationParams;
}

function safePathSegment(value: string, fallback: string): string {
	const safe = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
	return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function codexHomePath(): string {
	const configured = process.env.CODEX_HOME?.trim();
	return configured ? resolve(configured) : join(homedir(), ".codex");
}

function decodeGeneratedImage(data: string): Buffer {
	const normalized = data.trim();
	if (!normalized)
		throw new Error("image generation returned empty image data");
	if (decodedBase64ByteLength(normalized) > MAX_LOCAL_IMAGE_BYTES) {
		throw new Error(
			`image generation returned more than ${MAX_LOCAL_IMAGE_BYTES} image bytes`,
		);
	}
	if (
		normalized.length % 4 === 1 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
	) {
		throw new Error("image generation returned invalid base64 image data");
	}
	const bytes = Buffer.from(normalized, "base64");
	if (bytes.length === 0) {
		throw new Error("image generation returned empty image data");
	}
	if (bytes.length > MAX_LOCAL_IMAGE_BYTES) {
		throw new Error(
			`image generation returned more than ${MAX_LOCAL_IMAGE_BYTES} image bytes`,
		);
	}
	return bytes;
}

export async function saveGeneratedImageAtomically(
	codexHome: string,
	sessionId: string,
	callId: string,
	data: string,
	mutationQueue: <T>(
		path: string,
		mutation: () => Promise<T>,
	) => Promise<T> = async (_path, mutation) => mutation(),
): Promise<{ path: string; bytes: number }> {
	const bytes = decodeGeneratedImage(data);
	const session = safePathSegment(sessionId, "session");
	const call = safePathSegment(callId, "image");
	const path = join(
		resolve(codexHome),
		"generated_images",
		session,
		`${call}.png`,
	);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;

	return mutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		try {
			await writeFile(temporaryPath, bytes, { flag: "wx" });
			await rename(temporaryPath, path);
		} finally {
			await rm(temporaryPath, { force: true });
		}
		return { path, bytes: bytes.length };
	});
}

function resolvedLocalPath(cwd: string, value: string): string {
	const normalized = value.trim().replace(/^@/, "");
	if (!normalized) throw new Error("referenced image path cannot be empty");
	return isAbsolute(normalized)
		? resolve(normalized)
		: resolve(cwd, normalized);
}

async function localImageReference(
	path: string,
	ctx: ExtensionContext,
	convertImage: ImageConverter,
): Promise<ImageRequestReference> {
	const absolutePath = resolvedLocalPath(ctx.cwd, path);
	try {
		const bytes = await readLocalImageFile(
			absolutePath,
			`referenced image at ${path}`,
		);
		const image = await prepareNativeImageContent(
			{ data: bytes.toString("base64") },
			convertImage,
		);
		return { image_url: imageDataUrl(image) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`unable to process referenced image at ${path}: ${message}`,
		);
	}
}

function nativeImageContent(value: unknown): NativeImageContent | undefined {
	const normalized = normalizeLegacyImageBlock(value);
	if (
		!isRecord(normalized) ||
		normalized.type !== "image" ||
		typeof normalized.data !== "string" ||
		typeof normalized.mimeType !== "string"
	) {
		return undefined;
	}
	try {
		return createImageContent(normalized.data, normalized.mimeType);
	} catch {
		return undefined;
	}
}

function entryContent(entry: unknown): unknown[] {
	if (!isRecord(entry)) return [];
	const message = isRecord(entry.message) ? entry.message : undefined;
	const content = message?.content ?? entry.content;
	return Array.isArray(content) ? content : [];
}

function entryMessage(entry: unknown): UnknownRecord | undefined {
	return isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
}

function presentToolCallIds(entries: unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const message = entryMessage(entry);
		if (message?.role !== "assistant") continue;
		for (const block of entryContent(entry)) {
			if (
				isRecord(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string"
			) {
				ids.add(block.id);
			}
		}
	}
	return ids;
}

function generatedImagePath(entry: unknown): string | undefined {
	const message = entryMessage(entry);
	if (message?.role !== "toolResult" || message.toolName !== "image_gen") {
		return undefined;
	}
	const details = isRecord(message.details) ? message.details : undefined;
	return typeof details?.path === "string" && details.path.trim()
		? details.path
		: undefined;
}

function chronologicalSources(
	sources: ConversationImageSource[],
): ConversationImageSource[] {
	return sources.reverse();
}

export function recentConversationImageSources(
	ctx: ExtensionContext,
	count: number,
): ConversationImageSource[] {
	const entries = ctx.sessionManager.buildContextEntries();
	const callIds = presentToolCallIds(entries);
	const sources: ConversationImageSource[] = [];
	for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
		const message = entryMessage(entries[entryIndex]);
		if (message?.role === "toolResult") {
			if (
				typeof message.toolCallId !== "string" ||
				!callIds.has(message.toolCallId)
			) {
				continue;
			}
		}

		const content = entryContent(entries[entryIndex]);
		let foundInlineImage = false;
		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
			const image = nativeImageContent(content[blockIndex]);
			if (!image) continue;
			foundInlineImage = true;
			sources.push({ kind: "inline", image });
			if (sources.length === count) {
				return chronologicalSources(sources);
			}
		}
		if (!foundInlineImage) {
			const path = generatedImagePath(entries[entryIndex]);
			if (path) {
				sources.push({ kind: "generated-path", path });
				if (sources.length === count) {
					return chronologicalSources(sources);
				}
			}
		}
	}
	return chronologicalSources(sources);
}

export async function recentConversationImages(
	ctx: ExtensionContext,
	count: number,
	convertImage: ImageConverter,
): Promise<NativeImageContent[]> {
	const sources = recentConversationImageSources(ctx, count);
	return Promise.all(
		sources.map(async (source) => {
			if (source.kind === "inline") {
				return prepareNativeImageContent(source.image, convertImage);
			}
			const bytes = await readLocalImageFile(
				source.path,
				`recent generated image at ${source.path}`,
			);
			return prepareNativeImageContent(
				{ data: bytes.toString("base64") },
				convertImage,
			);
		}),
	);
}

function imageDataUrl(image: NativeImageContent): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

async function requestImageReferences(
	params: ImageGenerationParams,
	ctx: ExtensionContext,
	convertImage: ImageConverter,
): Promise<ImageRequestReference[]> {
	const paths = params.referenced_image_paths ?? [];
	const count = params.num_last_images_to_include;
	if (paths.length > MAX_EDIT_IMAGES) {
		throw new Error(
			`referenced_image_paths must contain at most ${MAX_EDIT_IMAGES} paths`,
		);
	}
	if (params.referenced_image_paths !== undefined && paths.length === 0) {
		throw new Error(
			"referenced_image_paths must contain at least one path when provided",
		);
	}
	if (params.referenced_image_paths !== undefined && count !== undefined) {
		throw new Error(
			"provide only one of referenced_image_paths or num_last_images_to_include",
		);
	}
	if (
		count !== undefined &&
		(!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES)
	) {
		throw new Error(
			`num_last_images_to_include must be between 1 and ${MAX_EDIT_IMAGES}`,
		);
	}

	if (paths.length > 0) {
		return Promise.all(
			paths.map((path) => localImageReference(path, ctx, convertImage)),
		);
	}
	if (count === undefined) return [];

	const recent = await recentConversationImages(ctx, count, convertImage);
	if (recent.length !== count) {
		throw new Error(
			`requested the last ${count} conversation images, but only ${recent.length} were available`,
		);
	}
	return recent.map((image) => ({ image_url: imageDataUrl(image) }));
}

function decodeChatGptAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("invalid JWT");
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as UnknownRecord;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") {
			throw new Error("missing ChatGPT account ID");
		}
		const accountId = auth.chatgpt_account_id.trim();
		if (!accountId) throw new Error("missing ChatGPT account ID");
		return accountId;
	} catch {
		throw new Error(
			"failed to extract chatgpt-account-id from Codex OAuth token",
		);
	}
}

function endpointForModel(
	model: NonNullable<ExtensionContext["model"]>,
	operation: "generations" | "edits",
): string {
	const baseUrl = model.baseUrl?.trim().replace(/\/+$/, "");
	if (!baseUrl) throw new Error("the selected model has no image API base URL");
	if (isChatGptCodexModel(model)) {
		let codexBaseUrl = baseUrl;
		if (codexBaseUrl.endsWith("/codex/responses")) {
			codexBaseUrl = codexBaseUrl.slice(0, -"/responses".length);
		} else if (!codexBaseUrl.endsWith("/codex")) {
			codexBaseUrl = `${codexBaseUrl}/codex`;
		}
		return `${codexBaseUrl}/images/${operation}`;
	}
	const apiBaseUrl = baseUrl.endsWith("/responses")
		? baseUrl.slice(0, -"/responses".length)
		: baseUrl;
	return `${apiBaseUrl}/images/${operation}`;
}

function requestHeaders(
	model: NonNullable<ExtensionContext["model"]>,
	apiKey: string,
	authHeaders: Record<string, string> | undefined,
): Headers {
	const headers = new Headers(authHeaders);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	headers.set("authorization", `Bearer ${apiKey}`);
	if (isChatGptCodexModel(model)) {
		headers.set("chatgpt-account-id", decodeChatGptAccountId(apiKey));
		headers.set("originator", "pi");
	}
	return headers;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function responseError(response: Response, text: string): Error {
	const payload = parseJson(text);
	const error =
		isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
	const rawDetail =
		(typeof error?.message === "string" && error.message) ||
		text.trim() ||
		response.statusText ||
		"request failed";
	const detail = rawDetail.slice(0, MAX_ERROR_TEXT_CHARS);
	return new Error(
		`image generation request failed (${response.status}): ${detail}`,
	);
}

function responseImageData(payload: unknown): {
	data: string;
	revisedPrompt?: string;
} {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("image generation response did not contain image data");
	}
	const first = payload.data[0];
	if (
		!isRecord(first) ||
		typeof first.b64_json !== "string" ||
		!first.b64_json.trim()
	) {
		throw new Error("image generation response did not contain image data");
	}
	const revisedPrompt =
		typeof first.revised_prompt === "string" && first.revised_prompt.trim()
			? first.revised_prompt.trim()
			: undefined;
	return { data: first.b64_json.trim(), revisedPrompt };
}

export async function executeImageGeneration(
	toolCallId: string,
	params: ImageGenerationParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	dependencies: ImageGenerationDependencies = {},
): Promise<AgentToolResult<ImageGenerationDetails>> {
	const model = ctx.model;
	if (!model || !isImageGenerationModel(model)) {
		throw new Error("image_gen is unavailable for the selected model");
	}
	if (!params.prompt.trim()) throw new Error("prompt cannot be empty");
	if (signal?.aborted) throw new Error("image generation aborted");

	const convertImage = dependencies.convertImage ?? (async () => null);
	const images = await requestImageReferences(params, ctx, convertImage);
	const operation = images.length > 0 ? "edits" : "generations";
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) {
		throw new Error(
			`no API key or OAuth token is available for ${model.provider}`,
		);
	}

	const body = {
		...(operation === "edits" ? { images } : {}),
		prompt: params.prompt,
		background: "auto",
		model: IMAGE_MODEL,
		quality: "auto",
		size: "auto",
	};
	const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
	const response = await fetchImpl(endpointForModel(model, operation), {
		method: "POST",
		headers: requestHeaders(model, auth.apiKey, auth.headers),
		body: JSON.stringify(body),
		signal,
	});
	const responseText = await readResponseTextWithinLimit(
		response,
		MAX_IMAGE_API_RESPONSE_BYTES,
	);
	if (!response.ok) throw responseError(response, responseText);
	const imageResponse = responseImageData(parseJson(responseText));
	if (decodedBase64ByteLength(imageResponse.data) > MAX_LOCAL_IMAGE_BYTES) {
		throw new Error(
			`image generation returned more than ${MAX_LOCAL_IMAGE_BYTES} image bytes`,
		);
	}
	const generatedImage = await prepareNativeImageContent(
		{ data: imageResponse.data },
		convertImage,
	);
	if (generatedImage.mimeType !== "image/png") {
		throw new Error(
			`image generation returned unexpected ${generatedImage.mimeType} data`,
		);
	}
	if (signal?.aborted) throw new Error("image generation aborted");

	const saved = await saveGeneratedImageAtomically(
		dependencies.codexHome ?? codexHomePath(),
		ctx.sessionManager.getSessionId(),
		toolCallId,
		generatedImage.data,
		dependencies.withFileMutationQueue,
	);
	const content: Array<NativeImageContent | { type: "text"; text: string }> = [
		{ type: "text" as const, text: `Saved generated image to ${saved.path}` },
	];
	if (model.input?.includes("image")) content.unshift(generatedImage);
	return {
		content,
		details: {
			path: saved.path,
			operation,
			bytes: saved.bytes,
			callId: toolCallId,
			...(imageResponse.revisedPrompt
				? { revisedPrompt: imageResponse.revisedPrompt }
				: {}),
		},
	};
}

import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	readdir,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	executeImageGeneration,
	recentConversationImageSources,
} from "../extensions/image-generation.ts";
import {
	MAX_IMAGE_API_RESPONSE_BYTES,
	MAX_LOCAL_IMAGE_BYTES,
	readLocalImageFile,
} from "../extensions/image-limits.ts";

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const SECOND_PNG_DATA = (() => {
	const bytes = Buffer.from(PNG_DATA, "base64");
	bytes[30] ^= 1;
	return bytes.toString("base64");
})();
const BMP_DATA =
	"Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAAAP8AAP8AAAAA/wAA/wAAAA==";

function mockContext({
	model,
	branch = [],
	contextEntries = branch,
	auth,
	cwd,
	sessionId = "session-123",
}) {
	return {
		cwd,
		model,
		modelRegistry: {
			async getApiKeyAndHeaders(receivedModel) {
				assert.equal(receivedModel, model);
				return auth;
			},
		},
		sessionManager: {
			getBranch() {
				return branch;
			},
			buildContextEntries() {
				return contextEntries;
			},
			getSessionId() {
				return sessionId;
			},
		},
	};
}

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { "content-type": "application/json" },
	});
}

function jwt(accountId) {
	const part = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

async function withTempDir(fn) {
	const path = await mkdtemp(join(tmpdir(), "pi-codex-image-gen-"));
	try {
		return await fn(path);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}

test("OpenAI API-key generation posts fixed defaults and atomically saves Pi-native output", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1/",
			input: ["text", "image"],
		};
		let request;
		const ctx = mockContext({
			model,
			cwd: root,
			auth: { ok: true, apiKey: "sk-test", headers: { "x-test": "yes" } },
		});
		const result = await executeImageGeneration(
			"call-1",
			{ prompt: "paint a moonlit lake" },
			undefined,
			ctx,
			{
				codexHome: join(root, "codex-home"),
				async fetchImpl(url, init) {
					request = { url, init };
					return jsonResponse({
						data: [{ b64_json: PNG_DATA, revised_prompt: "a moonlit lake" }],
					});
				},
			},
		);

		assert.equal(request.url, "https://api.openai.test/v1/images/generations");
		assert.deepEqual(JSON.parse(request.init.body), {
			prompt: "paint a moonlit lake",
			background: "auto",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
		const headers = new Headers(request.init.headers);
		assert.equal(headers.get("authorization"), "Bearer sk-test");
		assert.equal(headers.get("x-test"), "yes");
		assert.equal(headers.get("chatgpt-account-id"), null);
		assert.deepEqual(result.content[0], {
			type: "image",
			data: PNG_DATA,
			mimeType: "image/png",
		});
		assert.match(
			result.content[1].text,
			/Saved generated image to .*call-1\.png$/,
		);
		assert.equal(result.details.operation, "generations");
		assert.equal(result.details.callId, "call-1");
		assert.equal(result.details.revisedPrompt, "a moonlit lake");
		assert.equal(
			(await readFile(result.details.path)).toString("base64"),
			PNG_DATA,
		);
		assert.deepEqual(
			await readdir(
				join(root, "codex-home", "generated_images", "session-123"),
			),
			["call-1.png"],
		);
	});
});

test("ChatGPT Codex OAuth edits local images through the codex endpoint", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "source.bmp"), Buffer.from(BMP_DATA, "base64"));
		const token = jwt("acct-42");
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.test/backend-api",
			input: ["text", "image"],
		};
		let request;
		let conversion;
		const result = await executeImageGeneration(
			"call-edit",
			{
				prompt: "add a red hat",
				referenced_image_paths: ["source.bmp"],
			},
			undefined,
			mockContext({
				model,
				cwd: root,
				auth: { ok: true, apiKey: token, headers: { "x-auth-extra": "kept" } },
			}),
			{
				codexHome: join(root, "codex-home"),
				async convertImage(data, mimeType) {
					conversion = { data, mimeType };
					return { data: PNG_DATA, mimeType: "image/png" };
				},
				async fetchImpl(url, init) {
					request = { url, init };
					return jsonResponse({ data: [{ b64_json: PNG_DATA }] });
				},
			},
		);

		assert.equal(conversion.data, BMP_DATA);
		assert.equal(conversion.mimeType, "image/bmp");
		assert.equal(
			request.url,
			"https://chatgpt.test/backend-api/codex/images/edits",
		);
		assert.deepEqual(JSON.parse(request.init.body), {
			images: [{ image_url: `data:image/png;base64,${PNG_DATA}` }],
			prompt: "add a red hat",
			background: "auto",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
		const headers = new Headers(request.init.headers);
		assert.equal(headers.get("authorization"), `Bearer ${token}`);
		assert.equal(headers.get("chatgpt-account-id"), "acct-42");
		assert.equal(headers.get("originator"), "pi");
		assert.equal(headers.get("x-auth-extra"), "kept");
		assert.equal(result.details.operation, "edits");
	});
});

test("recent conversation edits select the requested newest images in chronological order", async () => {
	await withTempDir(async (root) => {
		const first = PNG_DATA;
		const second = SECOND_PNG_DATA;
		const branch = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "image", data: first, mimeType: "image/png" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "image-call",
							name: "view_image",
							arguments: { path: "source.png" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "image-call",
					toolName: "view_image",
					content: [
						{ type: "text", text: "generated" },
						{ type: "image", data: second, mimeType: "image/png" },
					],
				},
			},
		];
		let body;
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		await executeImageGeneration(
			"call-recent",
			{ prompt: "combine these", num_last_images_to_include: 2 },
			undefined,
			mockContext({
				model,
				branch,
				cwd: root,
				auth: { ok: true, apiKey: "sk-test" },
			}),
			{
				codexHome: join(root, "codex-home"),
				async fetchImpl(_url, init) {
					body = JSON.parse(init.body);
					return jsonResponse({ data: [{ b64_json: PNG_DATA }] });
				},
			},
		);

		assert.deepEqual(body.images, [
			{ image_url: `data:image/png;base64,${first}` },
			{ image_url: `data:image/png;base64,${second}` },
		]);
	});
});

test("recent selection uses compacted context and reuses text-only generated paths", async () => {
	await withTempDir(async (root) => {
		const generatedPath = join(root, "generated.png");
		await writeFile(generatedPath, Buffer.from(PNG_DATA, "base64"));
		const oldCompactedImage = SECOND_PNG_DATA;
		const currentImage = SECOND_PNG_DATA;
		const generatedCall = {
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "generated-call",
						name: "image_gen",
						arguments: { prompt: "first" },
					},
				],
			},
		};
		const generatedResult = {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "generated-call",
				toolName: "image_gen",
				content: [
					{ type: "text", text: `Saved generated image to ${generatedPath}` },
				],
				details: { path: generatedPath, operation: "generations", bytes: 1 },
			},
		};
		const current = {
			type: "message",
			message: {
				role: "user",
				content: [{ type: "image", data: currentImage, mimeType: "image/png" }],
			},
		};
		const branch = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							data: oldCompactedImage,
							mimeType: "image/png",
						},
					],
				},
			},
			generatedCall,
			generatedResult,
			current,
		];
		const contextEntries = [generatedCall, generatedResult, current];
		let body;
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		const ctx = mockContext({
			model,
			branch,
			contextEntries,
			cwd: root,
			auth: { ok: true, apiKey: "sk-test" },
		});
		assert.equal(recentConversationImageSources(ctx, 3).length, 2);
		await executeImageGeneration(
			"call-compacted",
			{ prompt: "combine visible images", num_last_images_to_include: 2 },
			undefined,
			ctx,
			{
				codexHome: join(root, "codex-home"),
				async fetchImpl(_url, init) {
					body = JSON.parse(init.body);
					return jsonResponse({ data: [{ b64_json: PNG_DATA }] });
				},
			},
		);

		assert.deepEqual(body.images, [
			{ image_url: `data:image/png;base64,${PNG_DATA}` },
			{ image_url: `data:image/png;base64,${currentImage}` },
		]);
	});
});

test("orphan tool-result images are excluded from recent selection", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		const orphan = {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "missing-call",
				toolName: "view_image",
				content: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
			},
		};
		await assert.rejects(
			executeImageGeneration(
				"call-orphan",
				{ prompt: "edit", num_last_images_to_include: 1 },
				undefined,
				mockContext({
					model,
					branch: [orphan],
					cwd: root,
					auth: { ok: true, apiKey: "sk-test" },
				}),
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/only 0 were available/,
		);
	});
});

test("inline image-generation results take precedence over their saved-path fallback", () => {
	const call = {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "native-generation",
					name: "image_gen",
					arguments: { prompt: "image" },
				},
			],
		},
	};
	const result = {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "native-generation",
			toolName: "image_gen",
			content: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
			details: { path: "/not-needed.png" },
		},
	};
	const sources = recentConversationImageSources(
		mockContext({
			model: undefined,
			branch: [call, result],
			cwd: process.cwd(),
			auth: undefined,
		}),
		5,
	);
	assert.equal(sources.length, 1);
	assert.equal(sources[0].kind, "inline");
	assert.equal(sources[0].image.data, PNG_DATA);
});

test("local image references enforce the 20 MiB boundary", async () => {
	await withTempDir(async (root) => {
		const boundaryPath = join(root, "boundary.bmp");
		await writeFile(boundaryPath, Buffer.from("BM"));
		await truncate(boundaryPath, MAX_LOCAL_IMAGE_BYTES);
		assert.equal(
			(await readLocalImageFile(boundaryPath, "boundary image")).length,
			MAX_LOCAL_IMAGE_BYTES,
		);

		const oversizedPath = join(root, "oversized.bmp");
		await writeFile(oversizedPath, Buffer.from("BM"));
		await truncate(oversizedPath, MAX_LOCAL_IMAGE_BYTES + 1);
		await assert.rejects(
			readLocalImageFile(oversizedPath, "oversized image"),
			new RegExp(`larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`),
		);
	});
});

test("image API response bodies are rejected before an oversized payload is read", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		await assert.rejects(
			executeImageGeneration(
				"call-large-response",
				{ prompt: "paint" },
				undefined,
				mockContext({
					model,
					cwd: root,
					auth: { ok: true, apiKey: "sk-test" },
				}),
				{
					codexHome: root,
					fetchImpl: async () =>
						new Response("{}", {
							headers: {
								"content-length": String(MAX_IMAGE_API_RESPONSE_BYTES + 1),
							},
						}),
				},
			),
			new RegExp(`larger than ${MAX_IMAGE_API_RESPONSE_BYTES} bytes`),
		);
	});
});

test("edit reference validation runs before authentication or fetch", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		let authCalls = 0;
		const ctx = mockContext({
			model,
			cwd: root,
			auth: {
				get ok() {
					authCalls += 1;
					return true;
				},
				apiKey: "sk-test",
			},
		});

		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{
					prompt: "edit",
					referenced_image_paths: ["1", "2", "3", "4", "5", "6"],
				},
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/at most 5 paths/,
		);
		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{
					prompt: "edit",
					referenced_image_paths: ["1"],
					num_last_images_to_include: 1,
				},
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/provide only one/,
		);
		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{ prompt: "edit", referenced_image_paths: [] },
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/must contain at least one path/,
		);
		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{
					prompt: "edit",
					referenced_image_paths: [],
					num_last_images_to_include: 1,
				},
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/must contain at least one path|provide only one/,
		);
		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{ prompt: "edit", num_last_images_to_include: 1 },
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			/only 0 were available/,
		);
		const oversizedPath = join(root, "oversized.png");
		await writeFile(oversizedPath, "x");
		await truncate(oversizedPath, MAX_LOCAL_IMAGE_BYTES + 1);
		await assert.rejects(
			executeImageGeneration(
				"call-invalid",
				{ prompt: "edit", referenced_image_paths: ["oversized.png"] },
				undefined,
				ctx,
				{ codexHome: root, fetchImpl: async () => jsonResponse({}) },
			),
			new RegExp(`larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`),
		);
		assert.equal(authCalls, 0);
	});
});

test("API errors are concise and do not publish an image", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		await assert.rejects(
			executeImageGeneration(
				"call-error",
				{ prompt: "paint" },
				undefined,
				mockContext({
					model,
					cwd: root,
					auth: { ok: true, apiKey: "sk-test" },
				}),
				{
					codexHome: join(root, "codex-home"),
					fetchImpl: async () =>
						jsonResponse(
							{ error: { message: "image policy rejected the request" } },
							{ status: 400 },
						),
				},
			),
			/image generation request failed \(400\): image policy rejected the request/,
		);
		await assert.rejects(
			readdir(join(root, "codex-home", "generated_images")),
			/ENOENT/,
		);
	});
});

test("mandatory atomic publication surfaces save failures", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.test/v1",
			input: ["text", "image"],
		};
		await assert.rejects(
			executeImageGeneration(
				"call-save-failure",
				{ prompt: "paint" },
				undefined,
				mockContext({
					model,
					cwd: root,
					auth: { ok: true, apiKey: "sk-test" },
				}),
				{
					codexHome: join(root, "codex-home"),
					fetchImpl: async () =>
						jsonResponse({ data: [{ b64_json: PNG_DATA }] }),
					withFileMutationQueue: async () => {
						throw new Error("publication denied");
					},
				},
			),
			/publication denied/,
		);
	});
});

test("text-only Codex models receive a saved-path result without an image block", async () => {
	await withTempDir(async (root) => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.3-codex-spark",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.test/backend-api/codex",
			input: ["text"],
		};
		let capturedUrl;
		const result = await executeImageGeneration(
			"call-text",
			{ prompt: "draw a small blue square" },
			undefined,
			mockContext({
				model,
				cwd: root,
				auth: { ok: true, apiKey: jwt("acct-42") },
			}),
			{
				codexHome: join(root, "codex-home"),
				async fetchImpl(url) {
					capturedUrl = url;
					return jsonResponse({ data: [{ b64_json: PNG_DATA }] });
				},
			},
		);
		assert.equal(
			capturedUrl,
			"https://chatgpt.test/backend-api/codex/images/generations",
		);
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].type, "text");
		assert.match(result.content[0].text, /call-text\.png$/);
	});
});

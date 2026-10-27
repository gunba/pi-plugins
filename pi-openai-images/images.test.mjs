import assert from "node:assert/strict";
import test from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { withOpenAIImages } from "./index.ts";
import { IMAGE_API, SUBSCRIPTION_ERROR } from "./images.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYkKIBAALUAS0ACLPLAAAAAElFTkSuQmCC";
const picture = { type: "image", mimeType: "image/png", data: png };
const prompt = { input: [{ type: "text", text: "Draw a fox" }] };
const rawUsage = { input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens: 400, total_tokens: 700 };
const token = account => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const response = (extra = {}) => Response.json({ data: [{ b64_json: png }], ...extra });

async function fixture(provider = "openai", credential = { type: "api_key", key: "fixture-api-key" }, transform = base => base) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider, async () => credential);
	const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
	const original = transform(provider === "openai" ? openaiProvider() : openaiCodexProvider());
	models.setProvider(withOpenAIImages(original));
	return { models, original, credentials, model: models.getModelOfType("image", provider, "gpt-image-2.5-sunburst") };
}

test("native image generation uses the selected 2.5 model, reports split input costs and preserves chat", async () => {
	const { models, model, original } = await fixture();
	const provider = models.getProvider("openai");
	assert.deepEqual(provider.getModels(), original.getModels());
	assert.equal(provider.stream, original.stream);
	assert.equal(provider.streamSimple, original.streamSimple);
	assert.equal(provider.classify, original.classify);
	assert.equal(provider.auth.apiKey, original.auth.apiKey);
	assert.equal(provider.auth.oauth.login, original.auth.oauth.login);
	assert.equal(provider.auth.oauth.refresh, original.auth.oauth.refresh);
	assert.deepEqual((await models.getAvailableOfType("image", "openai")).map(model => model.id), [
		"gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08",
	]);
	let calls = 0, inspected;
	const result = await models.generateImages(model, prompt, { fetch: async (url, init) => {
		calls++;
		assert.equal(String(url), "https://api.openai.com/v1/images/generations");
		assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
		assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-api-key");
		assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-2.5-sunburst", prompt: "Draw a fox", background: "auto", quality: "auto", size: "auto" });
		return response({ usage: rawUsage });
	}, onResponse: value => { inspected = value; } });
	assert.equal(calls, 1);
	assert.equal(inspected.status, 200);
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(result.output, [picture]);
	assert.equal(result.model, model.id);
	assert.deepEqual(result.usage, { input: 300, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 700,
		cost: { input: .0021, output: .012, cacheRead: 0, cacheWrite: 0, total: .0021 + .012 } });
});

test("native edit references, payload hooks, endpoint overrides and header removal reach the same request", async () => {
	const { models } = await fixture();
	const model = { ...models.getModelOfType("image", "openai", "gpt-image-2.5-flare-2026-09-08"), baseUrl: "https://proxy.example/v1/responses/", headers: { "x-remove": "old", "x-project": "fixture" } };
	const result = await models.generateImages(model, { input: [...prompt.input, picture, { type: "text", text: "Keep the colors" }] }, {
		identity: { userAgent: { custom: "Image test" } }, headers: { "X-Remove": null, "x-project": "override" },
		onPayload(body) { assert.deepEqual(body.images, [{ image_url: `data:image/png;base64,${png}` }]); return { ...body, quality: "max", n: 2 }; },
		fetch: async (url, init) => {
			assert.equal(String(url), "https://proxy.example/v1/images/edits");
			const headers = new Headers(init.headers);
			assert.equal(headers.get("x-remove"), null); assert.equal(headers.get("x-project"), "override"); assert.equal(headers.get("user-agent"), "Image test");
			const body = JSON.parse(init.body);
			assert.equal(body.model, "gpt-image-2.5-flare-2026-09-08"); assert.equal(body.quality, "max"); assert.equal(body.prompt, "Draw a fox\n\nKeep the colors");
			return response({ data: [{ b64_json: png }, { b64_json: png }] });
		},
	});
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(result.output, [picture, picture]);
	assert.equal(result.usage, undefined, "unreported usage is not a free call");
});

test("legacy ChatGPT images use the current native OAuth token and refreshed account header", async () => {
	let refreshes = 0;
	const { models, model } = await fixture("openai-codex", { type: "oauth", access: token("old"), refresh: "fixture", expires: 0 }, base => ({ ...base,
		auth: { oauth: { ...base.auth.oauth, refresh: async () => { refreshes++; return { type: "oauth", access: token("refreshed"), refresh: "rotated", expires: Date.now() + 3600000 }; } } },
	}));
	const result = await models.generateImages(model, { input: [...prompt.input, picture] }, { fetch: async (url, init) => {
		assert.equal(String(url), "https://chatgpt.com/backend-api/codex/images/edits");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), `Bearer ${token("refreshed")}`);
		assert.equal(headers.get("chatgpt-account-id"), "refreshed"); assert.equal(headers.get("originator"), "pi");
		return response();
	} });
	assert.equal(refreshes, 1); assert.equal(result.stopReason, "stop", result.errorMessage); assert.deepEqual(result.output, [picture]);
});

test("public ChatGPT OAuth hides image models and rejects explicit calls without falling back to a key", async () => {
	const { models, model } = await fixture("openai", { type: "oauth", access: "opaque-oauth-token", refresh: "fixture", expires: Date.now() + 3600000 });
	assert.deepEqual(await models.getAvailableOfType("image", "openai"), []);
	assert.deepEqual(await models.getAvailableOfType("classifier", "openai"), [], "the native Decisions restriction survives");
	const result = await models.generateImages(model, prompt, { fetch: async () => assert.fail("unsupported OAuth must not reach Images") });
	assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, SUBSCRIPTION_ERROR);
	const explicit = await models.generateImages(model, prompt, { apiKey: "explicit-fixture-key", fetch: async (_url, init) => {
		assert.equal(new Headers(init.headers).get("authorization"), "Bearer explicit-fixture-key"); return response();
	} });
	assert.equal(explicit.stopReason, "stop", explicit.errorMessage);
});

test("cancellation stops before dispatch and cancels a streaming response body", async () => {
	const { models, model } = await fixture();
	const before = new AbortController(); before.abort();
	assert.equal((await models.generateImages(model, prompt, { signal: before.signal, fetch: async () => assert.fail("already cancelled") })).stopReason, "aborted");
	const controller = new AbortController(); let cancelCount = 0;
	const result = await models.generateImages(model, prompt, { signal: controller.signal, fetch: async () => new Response(new ReadableStream({
		pull() { controller.abort(); }, cancel() { cancelCount++; },
	})) });
	assert.equal(result.stopReason, "aborted"); assert.deepEqual(result.output, []); assert.equal(cancelCount, 1);
});

test("an explicit timeout cancels a response body without replaying the request", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { models, model } = await fixture(), started = Promise.withResolvers();
	let cancelled = 0;
	const pending = models.generateImages(model, prompt, { timeoutMs: 1000, fetch: async () => {
		started.resolve(); return new Response(new ReadableStream({ cancel() { cancelled++; } }));
	} });
	await started.promise;
	t.mock.timers.tick(1000);
	const result = await pending;
	assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "Image request timed out."); assert.equal(cancelled, 1);
});

test("bad responses retain known charges but never surface untrusted error bodies or retry a billed request", async () => {
	const { models, model } = await fixture();
	let calls = 0;
	const failed = await models.generateImages(model, prompt, { maxRetries: 3, fetch: async () => { calls++; return new Response("SECRET_KEY and PRIVATE_PROMPT", { status: 429 }); } });
	assert.equal(calls, 1); assert.equal(failed.stopReason, "error"); assert.match(failed.errorMessage, /HTTP 429/);
	assert.doesNotMatch(failed.errorMessage, /SECRET|PRIVATE/);
	for (const [body, expected] of [
		[{ data: [] }, /no images/], [{ data: [{ b64_json: "bad" }], usage: rawUsage }, /invalid/], [{ data: [{ url: "https://example.com/private.png" }] }, /missing/],
	]) {
		const result = await models.generateImages(model, prompt, { fetch: async () => Response.json(body) });
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, expected); assert.deepEqual(result.output, []);
		if (body.usage) assert.equal(result.usage.cost.total, .0021 + .012);
	}
	const invalid = await models.generateImages(model, prompt, { fetch: async () => new Response("PRIVATE_INVALID_JSON") });
	assert.equal(invalid.errorMessage, "Image service returned invalid JSON.");
	const incomplete = await models.generateImages(model, prompt, { fetch: async () => response({ usage: { input_tokens: 300, output_tokens: 400 } }) });
	assert.equal(incomplete.stopReason, "stop"); assert.equal(incomplete.usage, undefined);
});

test("bounded readers cancel oversized success and error responses, including chunked bodies", async () => {
	const { models, model } = await fixture();
	for (const header of [true, false]) {
		let cancelled = 0;
		const result = await models.generateImages(model, prompt, { fetch: async () => new Response(new ReadableStream({
			start(controller) { if (!header) controller.enqueue(new Uint8Array(16 * 1024 + 1)); }, cancel() { cancelled++; },
		}), { status: header ? 200 : 500, headers: header ? { "content-length": String(49 * 1024 * 1024) } : {} }) });
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /size limit/); assert.equal(cancelled, 1);
	}
});

test("invalid inputs fail before a request, and other image APIs keep their provider implementation", async () => {
	const { models, model, original } = await fixture();
	for (const [context, expected] of [
		[{ input: [picture] }, /text prompt/], [{ input: [...prompt.input, { ...picture, mimeType: "image/jpeg" }] }, /MIME type/],
		[{ input: [...prompt.input, ...Array(17).fill(picture)] }, /At most 16/],
	]) {
		const result = await models.generateImages(model, context, { fetch: async () => assert.fail("invalid input reached the service") });
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, expected);
	}
	for (const timeoutMs of [0, .5, Infinity, 2 ** 31]) {
		const result = await models.generateImages(model, prompt, { timeoutMs, fetch: async () => assert.fail("invalid timeout reached the service") });
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /timeout must be/);
	}
	const payload = await models.generateImages(model, prompt, { onPayload: () => null, fetch: async () => assert.fail("invalid payload reached the service") });
	assert.equal(payload.errorMessage, "Image payload must be a JSON object.");
	const other = { ...model, id: "other-image", api: "other-images" }, answer = { output: [picture], stopReason: "stop" };
	const provider = withOpenAIImages({ ...original, getAllModels: () => [...original.getAllModels(), other], generateImages: async () => answer });
	assert.equal(await provider.generateImages(other, prompt), answer);
	assert.equal(provider.getAllModels().filter(model => model.id === "other-image").length, 1);
	assert.equal(provider.getAllModels().filter(model => model.api === IMAGE_API).length, 4);
});

import assert from "node:assert/strict";
import test from "node:test";

import webSearchExtension, {
	WEB_SEARCH_PARAMETERS,
	executeWebSearch,
} from "../extensions/web-search.ts";
import { serviceEndpoint } from "../../pi-codex-service/index.ts";

function jwt(accountId) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function mockContext({ model, auth, sessionId = "session-123", available = [], searchModel = model }) {
	return {
		model,
		modelRegistry: {
			async getApiKeyAndHeaders(receivedModel) {
				assert.equal(receivedModel, searchModel);
				return auth;
			},
			getAvailable() {
				return available;
			},
		},
		sessionManager: {
			getSessionId() {
				return sessionId;
			},
		},
	};
}

const CODEX_MODEL = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.test/backend-api/codex",
};

test("registers one Codex-shaped search tool", () => {
	const tools = [];
	webSearchExtension({
		getActiveTools() {
			return ["web_search"];
		},
		on() {},
		registerTool(tool) {
			tools.push(tool);
		},
		setActiveTools() {},
	});
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "web_search");
	assert.equal(tools[0].label, "web.run");
	assert.equal(tools[0].parameters, WEB_SEARCH_PARAMETERS);
	// Only the operations conversations use; the other Codex operations went unused.
	assert.deepEqual(Object.keys(tools[0].parameters.properties), ["search_query", "open", "click", "find", "check", "response_length"]);
});

test("posts Codex commands with the selected Pi model and no model fallback", async () => {
	const token = jwt("acct-42");
	let request;
	const result = await executeWebSearch(
		{
			search_query: [
				{ q: "OpenAI Codex search source", recency: 7, domains: ["github.com"] },
			],
			response_length: "medium",
		},
		undefined,
		mockContext({
			model: CODEX_MODEL,
			auth: { ok: true, apiKey: token, headers: { "x-auth-source": "pi" } },
		}),
		{
			async fetchImpl(url, init) {
				request = { url, init };
				return new Response(
					JSON.stringify({
						encrypted_output: "not-forwarded",
						output: "Search result with https://github.com/openai/codex",
						results: [{ type: "text_result", ref_id: "turn0search0" }],
					}),
					{ status: 200 },
				);
			},
		},
	);

	assert.equal(request.url, "https://chatgpt.test/backend-api/codex/alpha/search");
	const body = JSON.parse(request.init.body);
	assert.deepEqual(body, {
		id: "session-123",
		model: "gpt-5.6-sol",
		commands: {
			search_query: [
				{ q: "OpenAI Codex search source", recency: 7, domains: ["github.com"] },
			],
			response_length: "medium",
		},
		settings: { allowed_callers: ["direct"], external_web_access: true },
		max_output_tokens: 10_000,
	});
	assert.equal(body.model, CODEX_MODEL.id);
	assert.equal(JSON.stringify(body).includes("gpt-5.4"), false);
	const headers = new Headers(request.init.headers);
	assert.equal(headers.get("authorization"), `Bearer ${token}`);
	assert.equal(headers.get("chatgpt-account-id"), "acct-42");
	assert.equal(headers.get("originator"), "pi");
	assert.equal(headers.get("x-auth-source"), "pi");
	assert.deepEqual(result.content, [
		{ type: "text", text: "Search result with https://github.com/openai/codex" },
	]);
	assert.deepEqual(result.details, {
		model: "openai-codex/gpt-5.6-sol",
		results: [{ type: "text_result", ref_id: "turn0search0" }],
	});
});

test("accepts Codex search responses larger than 64 KiB", async () => {
	const structuredResult = {
		type: "text_result",
		ref_id: "turn0search0",
		metadata: "x".repeat(70 * 1024),
	};
	const responseBody = JSON.stringify({
		encrypted_output: null,
		output: "Small model-facing search output",
		results: [structuredResult],
	});
	assert.ok(Buffer.byteLength(responseBody, "utf8") > 64 * 1024);

	const result = await executeWebSearch(
		{ search_query: [{ q: "large structured results" }] },
		undefined,
		mockContext({
			model: CODEX_MODEL,
			auth: { ok: true, apiKey: jwt("acct-42") },
		}),
		{
			async fetchImpl() {
				return new Response(responseBody, { status: 200 });
			},
		},
	);

	assert.deepEqual(result.content, [
		{ type: "text", text: "Small model-facing search output" },
	]);
	assert.deepEqual(result.details.results, [structuredResult]);
});

test("normalizes Codex response base URLs", () => {
	assert.equal(
		serviceEndpoint("https://example.test/backend-api", "alpha/search", true),
		"https://example.test/backend-api/codex/alpha/search",
	);
	assert.equal(
		serviceEndpoint("https://example.test/backend-api/codex/responses/", "alpha/search", true),
		"https://example.test/backend-api/codex/alpha/search",
	);
});

const ANTHROPIC_MODEL = {
		provider: "anthropic",
		id: "claude-opus-4-6",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
	};

test("searches through a signed-in Codex model when the conversation uses another provider", async () => {
	let body;
	const result = await executeWebSearch(
		{ search_query: [{ q: "test" }] },
		undefined,
		mockContext({ model: ANTHROPIC_MODEL, available: [ANTHROPIC_MODEL, CODEX_MODEL], searchModel: CODEX_MODEL, auth: { ok: true, apiKey: jwt("acct-42") } }),
		{
			async fetchImpl(_url, init) {
				body = JSON.parse(init.body);
				return new Response(JSON.stringify({ output: "found" }));
			},
		},
	);
	assert.equal(body.model, CODEX_MODEL.id);
	assert.equal(result.details.model, "openai-codex/gpt-5.6-sol");
});

test("without a ChatGPT login, search says so instead of using another provider", async () => {
	let called = false;
	await assert.rejects(
		executeWebSearch(
			{ search_query: [{ q: "test" }] },
			undefined,
			mockContext({ model: ANTHROPIC_MODEL, available: [ANTHROPIC_MODEL], auth: { ok: true, apiKey: "unused" } }),
			{
				async fetchImpl() {
					called = true;
					throw new Error("must not run");
				},
			},
		),
		/needs a ChatGPT login/,
	);
	assert.equal(called, false);
});

test("reports endpoint errors without falling back", async () => {
	let calls = 0;
	await assert.rejects(
		executeWebSearch(
			{ search_query: [{ q: "test" }] },
			undefined,
			mockContext({
				model: CODEX_MODEL,
				auth: { ok: true, apiKey: jwt("acct-42") },
			}),
			{
				async fetchImpl() {
					calls += 1;
					return new Response(JSON.stringify({ error: { message: "search unavailable" } }), {
						status: 503,
					});
				},
			},
		),
		/Codex search request failed \(503\): search unavailable/,
	);
	assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import webSearchExtension, {
	WEB_SEARCH_PARAMETERS,
	codexSearchEndpoint,
	executeWebSearch,
	syncWebSearchTool,
} from "../extensions/web-search.ts";

function jwt(accountId) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function mockContext({ model, auth, sessionId = "session-123" }) {
	return {
		model,
		modelRegistry: {
			async getApiKeyAndHeaders(receivedModel) {
				assert.equal(receivedModel, model);
				return auth;
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
	assert.deepEqual(Object.keys(tools[0].parameters.properties), [
		"search_query",
		"image_query",
		"open",
		"click",
		"find",
		"screenshot",
		"finance",
		"weather",
		"sports",
		"time",
		"response_length",
	]);
});

test("exposes search only for ChatGPT Codex without overriding manual disablement", () => {
	const initial = syncWebSearchTool(
		["read", "web_search"],
		CODEX_MODEL,
		{ enabled: false },
	);
	assert.deepEqual(initial.activeTools, ["read", "web_search"]);

	const away = syncWebSearchTool(
		initial.activeTools,
		{ provider: "anthropic", id: "claude-opus-4-6" },
		initial.state,
	);
	assert.deepEqual(away.activeTools, ["read"]);

	const back = syncWebSearchTool(away.activeTools, CODEX_MODEL, away.state);
	assert.deepEqual(back.activeTools, ["read", "web_search"]);

	const manuallyDisabled = syncWebSearchTool(["read"], CODEX_MODEL, back.state);
	assert.deepEqual(manuallyDisabled.activeTools, ["read"]);
	assert.deepEqual(
		syncWebSearchTool(manuallyDisabled.activeTools, CODEX_MODEL, manuallyDisabled.state)
			.activeTools,
		["read"],
	);
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
		codexSearchEndpoint({ ...CODEX_MODEL, baseUrl: "https://example.test/backend-api" }),
		"https://example.test/backend-api/codex/alpha/search",
	);
	assert.equal(
		codexSearchEndpoint({
			...CODEX_MODEL,
			baseUrl: "https://example.test/backend-api/codex/responses/",
		}),
		"https://example.test/backend-api/codex/alpha/search",
	);
});

test("rejects non-Codex models instead of routing to another provider", async () => {
	let called = false;
	await assert.rejects(
		executeWebSearch(
			{ search_query: [{ q: "test" }] },
			undefined,
			mockContext({
				model: {
					provider: "anthropic",
					id: "claude-opus-4-6",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				},
				auth: { ok: true, apiKey: "unused" },
			}),
			{
				async fetchImpl() {
					called = true;
					throw new Error("must not run");
				},
			},
		),
		/web_search requires a ChatGPT Codex model/,
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

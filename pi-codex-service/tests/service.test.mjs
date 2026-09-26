import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { requestService } from "../index.ts";

const model = { provider: "openai-codex", baseUrl: "https://unused.invalid/codex" };
const request = { path: "alpha/search", codex: true, label: "Codex search", body: { id: "session" }, maxResponseBytes: 32 };
const context = auth => ({ modelRegistry: { async getApiKeyAndHeaders() { return auth; } } });

test("resolved base URL and auth headers override service defaults", async () => {
	const controller = new AbortController();
	const ctx = context({ ok: true, apiKey: "unused", baseUrl: "https://proxy.invalid/backend/codex/responses",
		headers: { Authorization: "Bearer proxy-token", "ChatGPT-Account-ID": "proxy-account", originator: null } });
	const text = await requestService(ctx, model, request, controller.signal, async (url, init) => {
		assert.equal(url, "https://proxy.invalid/backend/codex/alpha/search");
		assert.equal(init.headers.get("authorization"), "Bearer proxy-token");
		assert.equal(init.headers.get("chatgpt-account-id"), "proxy-account");
		assert.equal(init.headers.get("originator"), null);
		assert.deepEqual(JSON.parse(init.body), request.body);
		return new Response("ok");
	});
	assert.equal(text, "ok");
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting auth prevents a late service request and removes its listener", async () => {
	const controller = new AbortController();
	let resolveAuth, requests = 0;
	const ctx = { modelRegistry: { getApiKeyAndHeaders: () => new Promise(resolve => resolveAuth = resolve) } };
	const pending = requestService(ctx, model, request, controller.signal, async () => { requests++; return new Response(""); });
	controller.abort(new Error("cancelled fixture"));
	await assert.rejects(pending, /cancelled fixture/);
	resolveAuth({ ok: true, apiKey: "unused" });
	await Promise.resolve();
	assert.equal(requests, 0);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("unknown-length response bodies are bounded and cancelled on overflow", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array(33)); },
		cancel() { cancelled = true; },
	});
	await assert.rejects(requestService(context({ ok: true, apiKey: "test" }), model,
		{ ...request, codex: false }, undefined, async () => new Response(body)), /larger than 32 bytes/);
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});

test("the deadline cancels a stalled response reader", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let started, cancelled = false;
	const reading = new Promise(resolve => started = resolve);
	const body = new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const pending = requestService(context({ ok: true, apiKey: "test" }), model,
		{ ...request, codex: false, timeoutMs: 20 }, undefined, async () => new Response(body));
	await reading;
	t.mock.timers.tick(20);
	await assert.rejects(pending, /timed out/);
	assert.equal(cancelled, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { WireTransport } from "../extensions/transport.ts";
import { normalizeLiteEvent } from "../extensions/model-shape.ts";
import { requestCompact } from "../extensions/compact.ts";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";

const encode = text => new TextEncoder().encode(text);
const packet = event => `data: ${JSON.stringify(event)}\r\n\r\n`;
const completed = output => ({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output,
	usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } });
const checkpoint = { type: "compaction", id: "cmp_fixture", encrypted_content: "PRIVATE opaque 🧪" };
const exchange = { url: "http://fixture.invalid/responses", body: { model: "gpt-6-astra", input: [] }, headers: new Headers(),
	requestId: "fixture", timeoutMs: 1000, normalizeEvent: normalizeLiteEvent };

function fixture(t, source) {
	const rows = [];
	const diagnostics = { request: (_body, row) => rows.push({ kind: "request", ...row }), write: row => rows.push(row) };
	const transport = new WireTransport(diagnostics, { observeHeaders() {}, observeEvent() {} }, "sse", async () => new Response(source), {});
	t.after(() => transport.close());
	return { rows, diagnostics, transport };
}

async function bounded(promise) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture stream hung")), 2000); })]); }
	finally { clearTimeout(timer); }
}

function byteStream(text) {
	const bytes = encode(text); let at = 0;
	return new ReadableStream({ pull(controller) {
		if (at === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(at, ++at));
	} });
}

test("Wire reads a Lite checkpoint split at every byte, including UTF-8 and an EOF-terminated event", async t => {
	const text = ': keepalive\r\n\r\n' + packet({ type: "response.output_item.done", output_index: 0, item: checkpoint })
		+ 'data: {"type":"response.completed",\r\ndata: "response":{"id":"resp_fixture","status":"completed","output":[]}}';
	const f = fixture(t, byteStream(text));
	const result = await bounded(requestCompact(exchange, f.diagnostics, f.transport));
	assert.deepEqual(result.output, [checkpoint]);
	assert.equal(f.rows.find(row => row.kind === "sse-end").terminalSeen, true);
	assert.doesNotMatch(JSON.stringify(f.rows), /PRIVATE|encrypted_content/);
});

test("Pi's ordinary decoder completes a Lite HTTPS response split at every byte", async t => {
	const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", namespace: "functions", arguments: '{"text":"🧪"}', status: "completed" };
	const text = packet({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } })
		+ packet({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments })
		+ packet({ type: "response.output_item.done", output_index: 0, item }) + packet(completed([item]));
	const f = fixture(t, byteStream(text));
	const model = { id: "gpt-6-astra", name: "Fixture", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "http://fixture.invalid", input: ["text"], reasoning: true,
		contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`;
	const result = await bounded(streamSimple(model, { messages: [{ role: "user", content: "Fixture request", timestamp: 1 }] }, {
		apiKey: token, reasoning: "xhigh", transport: "sse", maxRetries: 0,
		fetch: async () => f.transport.request(exchange),
	}).result());
	assert.equal(result.stopReason, "toolUse");
	const call = result.content.find(part => part.type === "toolCall");
	assert.equal(call.name, "lookup"); assert.deepEqual(call.arguments, { text: "🧪" });
	assert.equal(f.rows.filter(row => row.kind === "request").length, 1);
});

for (const normalize of [false, true]) for (const partial of [false, true]) {
	test(`SSE idle timeout reaches the reader despite continuing ${partial ? "partial data" : "comments"} (Lite=${normalize})`, async t => {
		let timer, cancelled = false;
		const source = new ReadableStream({ start(controller) {
			if (partial) controller.enqueue(encode('data: {"type":"'));
			timer = setInterval(() => controller.enqueue(encode(partial ? "x" : ": keepalive\n\n")), 10);
		}, cancel() { cancelled = true; clearInterval(timer); } });
		t.after(() => clearInterval(timer));
		const f = fixture(t, source);
		const response = await f.transport.request({ ...exchange, timeoutMs: 100, normalizeEvent: normalize ? normalizeLiteEvent : undefined });
		await assert.rejects(bounded(response.text()), /Codex SSE stream timed out/);
		assert.equal(cancelled, true);
		const failure = f.rows.filter(row => row.kind === "sse-failure");
		assert.equal(failure.length, 1); assert.equal(failure[0].abortSource, "timeout");
		assert.equal(failure[0].events, 0); assert.ok(failure[0].receivedBytes > 0);
	});
}

for (const queued of [false, true]) test(`caller cancellation releases an SSE ${queued ? "queued event" : "partial frame"} without relying on fetch abort`, async t => {
	let cancelled = false;
	const f = fixture(t, new ReadableStream({ start(controller) {
		controller.enqueue(encode(queued ? packet({ type: "response.created" }) : 'data: {"type":'));
	}, cancel() { cancelled = true; } }));
	const controller = new AbortController(), reason = new Error("Fixture cancelled");
	const response = await f.transport.request({ ...exchange, signal: controller.signal });
	await new Promise(resolve => setImmediate(resolve));
	controller.abort(reason);
	await assert.rejects(bounded(response.text()), error => error === reason);
	assert.equal(cancelled, true);
	assert.equal(f.rows.filter(row => row.kind === "request").length, 1);
	assert.equal(f.rows.find(row => row.kind === "sse-failure").abortSource, "request-signal");
	// The failed attempt releases the routing slot; only the caller starts another.
	await (await f.transport.request({ ...exchange, fetcher: async () => new Response(packet(completed([]))) })).text();
});

test("completed SSE events renew the idle deadline without imposing a total generation limit", async t => {
	let count = 0, timer;
	const source = new ReadableStream({ start(controller) {
		timer = setInterval(() => {
			controller.enqueue(encode(packet(++count === 4 ? completed([]) : { type: "response.in_progress" })));
			if (count === 4) { clearInterval(timer); controller.close(); }
		}, 60);
	}, cancel() { clearInterval(timer); } });
	t.after(() => clearInterval(timer));
	const f = fixture(t, source), start = Date.now();
	await bounded((await f.transport.request({ ...exchange, timeoutMs: 180 })).text());
	assert.ok(Date.now() - start >= 180);
	assert.equal(f.rows.some(row => row.kind === "sse-failure"), false);
});

test("cancelling the response body does not parse a partial frame as EOF or log a protocol failure", async t => {
	let cancelled = false;
	const f = fixture(t, new ReadableStream({ start(controller) { controller.enqueue(encode('data: {"type":')); },
		cancel() { cancelled = true; } }));
	const response = await f.transport.request(exchange);
	await new Promise(resolve => setImmediate(resolve));
	await bounded(response.body.cancel());
	assert.equal(cancelled, true);
	assert.equal(f.rows.some(row => row.kind === "sse-failure"), false);
});

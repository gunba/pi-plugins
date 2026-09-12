import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { compactBody, retainedCompactionInput, requestCompact } from "../extensions/compact.ts";
import { WireTransport } from "../extensions/transport.ts";
import { Protocol } from "../extensions/protocol.ts";
import { retryCompaction } from "../extensions/native-compaction.ts";
import { identity } from "./fixtures.mjs";
const { WebSocketServer } = createRequire(import.meta.url)("ws");
const item = { type: "compaction", id: "cmp_fixture", encrypted_content: "private-opaque-🧪" };
const user = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const done = value => ({ type: "response.output_item.done", output_index: 0, item: value });
const completed = (overrides = {}) => ({ type: "response.completed", response: { id: "resp_compact", status: "completed", output: [], ...overrides } });
const packets = () => [done(item), completed({ usage: { input_tokens: 10, output_tokens: 2 } })];
const data = events => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
const stream = events => new Response(data(events), { headers: { "content-type": "text/event-stream" } });
function fixture() {
	const log = [], protocol = new Protocol("codex", "fixture-thread", "fixture-installation", identity);
	protocol.beginTurn("manual");
	const body = protocol.shapeBody(compactBody({ model: "gpt-6-astra", input: [user("private fixture")], reasoning: { effort: "xhigh" }, parallel_tool_calls: false }));
	return { log, protocol, diagnostics: { request: (_body, fields) => log.push(fields), write: fields => log.push(fields) },
		exchange: { url: "https://chatgpt.test/backend-api/codex/responses", body,
			headers: protocol.compactHeaders(new Headers({ authorization: "Bearer private-key", "chatgpt-account-id": "private-account" }), "manual"), requestId: "fixture-request", timeoutMs: 1000 } };
}

test("native trigger keeps the Responses contract and original source intact", () => {
	const source = { model: "gpt-6-astra", input: [user("fixture")], previous_response_id: "old", generate: false, reasoning: { effort: "xhigh" }, client_metadata: { fixture: "retained" } };
	const original = structuredClone(source), body = compactBody(source);
	assert.deepEqual(source, original);
	assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
	assert.equal(body.previous_response_id, undefined); assert.equal(body.generate, undefined);
	assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(body.tool_choice, "auto");
	assert.deepEqual(body.reasoning, source.reasoning);
	assert.throws(() => compactBody(body), /Invalid/);
});

test("compaction requires a single completed checkpoint and never logs private values", async () => {
	const f = fixture(); let calls = 0;
	const result = await requestCompact(f.exchange, f.diagnostics, { request: async exchange => {
		calls++; assert.equal(exchange.skipPrewarm, true); assert.equal(exchange.url, f.exchange.url);
		return stream(packets());
	} });
	assert.equal(calls, 1); assert.deepEqual(result.output, [user("private fixture"), item]);
	assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
	assert.doesNotMatch(JSON.stringify(f.log), /private|encrypted_content|authorization/);
});

test("split UTF-8, multiline SSE, CRLF and terminal EOF retain exact encrypted bytes", async () => {
	const f = fixture();
	const payload = data([done(item)]) + 'data: {"type":"response.completed",\r\ndata: "response":{"id":"resp_fixture","output":[]}}';
	const bytes = Buffer.from(payload); let at = 0;
	const response = new Response(new ReadableStream({ pull(controller) {
		if (at === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(at, ++at));
	} }));
	const result = await requestCompact(f.exchange, f.diagnostics, { request: async () => response });
	assert.deepEqual(result.output.at(-1), item); assert.equal(result.usage, undefined);
});

test("partial, duplicate, conflicting, incomplete and error responses cannot commit a checkpoint", async () => {
	for (const events of [[done(item)], [done(item), done(item), completed()], [completed()],
		[done(item), completed({ output: [{ ...item, encrypted_content: "different" }] })],
		[done(item), { type: "response.incomplete" }], [done(item), { type: "error", error: { message: "private error" } }],
		[done({ ...item, encrypted_content: "" }), completed()]]) {
		const f = fixture(); let calls = 0;
		await assert.rejects(requestCompact(f.exchange, f.diagnostics, { request: async () => { calls++; return stream(events); } }), /Codex compaction/);
		assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(f.log), /private/);
	}
	for (const response of [new Response("private", { status: 404 }), new Response("private", { status: 503 }),
		Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }), new Response("data: {invalid}\n\n")]) {
		const f = fixture(); await assert.rejects(requestCompact(f.exchange, f.diagnostics, { request: async () => response }), /Codex compaction/);
	}
});

test("retained user text is bounded and independent; stale checkpoints and assistant output are replaced", () => {
	const image = { type: "input_image", image_url: "fixture-image" };
	const input = [user("discarded"), user("🧪".repeat(70_000)), { ...user("assistant secret"), role: "assistant" }, item, user("recent")];
	input[1].content.push(image);
	const before = structuredClone(input), retained = retainedCompactionInput(input);
	assert.equal(retained.length, 2); assert.deepEqual(input, before);
	assert.ok(Buffer.byteLength(retained[0].content[0].text) < 256_050);
	assert.match(retained[0].content[0].text, /tokens truncated/); assert.doesNotMatch(retained[0].content[0].text, /�/);
	assert.deepEqual(retained[0].content.at(-1), image); assert.deepEqual(retained[1], user("recent"));
	assert.deepEqual(retainedCompactionInput([{ role: "user", content: user("implicit Pi message").content }]), [user("implicit Pi message")]);
});

test("premature EOF and transient socket errors use the existing caller budget", async () => {
	for (const failure of [() => stream([done(item)]), () => { throw new Error("Codex WebSocket stream failed"); },
		() => stream([{ type: "error", error: { code: "server_error" } }])]) {
		const f = fixture(); let calls = 0, scheduled = 0;
		const result = await retryCompaction(() => requestCompact(f.exchange, f.diagnostics, { request: async () => {
			calls++; if (calls === 1) return failure(); return stream(packets());
		} }), { enabled: true, maxRetries: 1, baseDelayMs: 1 }, new AbortController().signal, () => { scheduled++; });
		assert.equal(calls, 2); assert.equal(scheduled, 1); assert.deepEqual(result.output.at(-1), item);
	}
	const f = fixture(); let calls = 0;
	await assert.rejects(retryCompaction(() => requestCompact(f.exchange, f.diagnostics, { request: async () => {
		calls++; return stream([done(item)]);
	} }), { enabled: true, maxRetries: 2, baseDelayMs: 1 }, new AbortController().signal, () => {}));
	assert.equal(calls, 3);
});

test("actual WebSocket compaction skips prewarm, carries compaction metadata, and recovers only on the next caller attempt", async () => {
	let httpCalls = 0, wsCalls = 0;
	const server = createServer((req, res) => { httpCalls++; req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(data(packets())); });
	const sockets = new WebSocketServer({ server });
	sockets.on("connection", socket => socket.on("message", value => {
		const body = JSON.parse(value.toString()); wsCalls++;
		assert.equal(body.generate, undefined); assert.equal(body.input.at(-1).type, "compaction_trigger");
		const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
		assert.equal(metadata.request_kind, "compaction"); assert.equal(metadata.compaction.implementation, "responses_compaction_v2");
		socket.send(JSON.stringify(done(item)));
		setTimeout(() => socket.terminate(), 5);
	}));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const f = fixture(); f.exchange.url = `http://127.0.0.1:${server.address().port}/responses`;
	const transport = new WireTransport(f.diagnostics, f.protocol, "auto", fetch, { NO_PROXY: "*" }, () => {}, true);
	try {
		await assert.rejects(requestCompact(f.exchange, f.diagnostics, transport), /closed before completion/);
		assert.equal(wsCalls, 1); assert.equal(httpCalls, 0);
		const result = await requestCompact(f.exchange, f.diagnostics, transport);
		assert.deepEqual(result.output.at(-1), item); assert.equal(wsCalls, 1); assert.equal(httpCalls, 1);
	} finally { transport.close(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("real HTTP idle timeout and cancellation release both header and body waits", async () => {
	const server = createServer((req, res) => { req.resume(); if (req.url.startsWith("/body/")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":'); } });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		for (const phase of ["headers", "body"]) for (const cancel of [false, true]) {
			const f = fixture(), controller = new AbortController();
			Object.assign(f.exchange, { url: `http://127.0.0.1:${server.address().port}/${phase}/responses`, timeoutMs: cancel ? 1000 : 150, signal: controller.signal });
			const transport = new WireTransport(f.diagnostics, f.protocol, "sse");
			const pending = requestCompact(f.exchange, f.diagnostics, transport);
			const timer = cancel ? setTimeout(() => controller.abort(new Error("fixture cancelled")), 100) : undefined;
			try { await assert.rejects(pending); }
			finally { clearTimeout(timer); transport.close(); }
			assert.equal(f.log.at(-1).kind, "compact-failure");
		}
	} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

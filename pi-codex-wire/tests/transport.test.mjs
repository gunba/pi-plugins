import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Diagnostics } from "../extensions/diagnostics.ts";
import { Protocol } from "../extensions/protocol.ts";
import { WireTransport } from "../extensions/transport.ts";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { shapeModelBody, normalizeLiteEvent } from "../extensions/model-shape.ts";
import { identity } from "./fixtures.mjs";
import { zstdDecompressSync } from "node:zlib";

async function fixture(t, mode = "auto", handler) {
  const directory = mkdtempSync(join(tmpdir(), "pi-wire-test-"));
  const log = join(directory, "log.jsonl");
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/codex/responses`;
  const protocol = new Protocol("codex", "thread", "install", identity);
  const transport = new WireTransport(new Diagnostics(log), protocol, mode, fetch, {});
  t.after(() => { transport.close(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, url, protocol, transport, log };
}

const body = { model: "gpt-6-astra", input: [{ role: "user", content: "PRIVATE PROMPT" }], tools: [], store: false, stream: true };
const completed = id => ({ type: "response.completed", response: { id, status: "completed", output: [], service_tier: "default", usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 98 } } } });
function exchange(f, overrides = {}) { return { url: f.url, body: f.protocol.shapeBody(body), headers: f.protocol.headers(new Headers({ authorization: "Bearer SECRET", "chatgpt-account-id": "PRIVATE ACCOUNT" })), requestId: "test", timeoutMs: 3000, ...overrides }; }

test("WebSocket prewarms, sends deltas and captures per-frame sticky token", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server });
  t.after(() => wss.close());
  const frames = [];
  wss.on("connection", (socket, request) => {
    assert.equal(request.headers.originator, "codex_cli_rs");
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()); frames.push(frame);
      socket.send(JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "PRIVATE ROUTING TOKEN" } }));
      socket.send(JSON.stringify(completed(`resp_${frames.length}`)));
    });
  });
  await (await f.transport.request(exchange(f))).text();
  await (await f.transport.request(exchange(f))).text();
  assert.equal(frames.length, 3);
  assert.equal(frames[0].generate, false);
  assert.equal(frames[1].previous_response_id, "resp_1");
  assert.deepEqual(frames[1].input, []);
  assert.equal(frames[1].client_metadata["x-codex-turn-state"], "PRIVATE ROUTING TOKEN");
  assert.equal(frames[2].previous_response_id, "resp_2");
  const log = readFileSync(f.log, "utf8");
  for (const secret of ["PRIVATE PROMPT", "SECRET", "PRIVATE ACCOUNT", "PRIVATE ROUTING TOKEN"]) assert.equal(log.includes(secret), false);
  assert.match(log, /"cached_tokens":98/);
});

test("SSE forwards bytes, captures allowance and replays sticky headers", async t => {
  const seen = [];
  const f = await fixture(t, "sse", (req, res) => {
    seen.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "sse-token", "x-codex-primary-used-percent": "12.34" });
    res.end(`data: ${JSON.stringify(completed("resp_sse"))}\n\n`);
  });
  const first = await (await f.transport.request(exchange(f))).text();
  assert.equal(first, `data: ${JSON.stringify(completed("resp_sse"))}\n\n`);
  await (await f.transport.request(exchange(f))).text();
  assert.equal(seen[1]["x-codex-turn-state"], "sse-token");
  assert.match(readFileSync(f.log, "utf8"), /12\.34/);
});

test("SSE wire compression follows the selected feature and preserves JSON", async t => {
  const seen = [];
  const f = await fixture(t, "sse", (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const encoded = req.headers["content-encoding"];
      seen.push({ encoded, body: JSON.parse((encoded === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(completed("r"))}\n\n`);
    });
  });
  await (await f.transport.request(exchange(f, { compression: "zstd" }))).text();
  await (await f.transport.request(exchange(f, { compression: "none" }))).text();
  assert.equal(seen[0].encoded, "zstd");
  assert.equal(seen[1].encoded, undefined);
  assert.deepEqual(seen[0].body, seen[1].body);
});

test("failed WebSocket upgrade falls back to SSE without an inference WS frame", async t => {
  let posts = 0;
  const f = await fixture(t, "auto", (req, res) => {
    if (req.headers.upgrade) { res.writeHead(400); res.end(); return; }
    posts++; req.resume(); res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(completed("resp_sse"))}\n\n`);
  });
  await (await f.transport.request(exchange(f))).text();
  assert.equal(posts, 1);
  assert.match(readFileSync(f.log, "utf8"), /"kind":"fallback"/);
});

test("missing previous response retries full input once", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const frames = [];
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    socket.send(JSON.stringify(frames.length === 2 ? { type: "error", code: "previous_response_not_found" } : completed(`r${frames.length}`)));
  }));
  await (await f.transport.request(exchange(f))).text();
  assert.equal(frames.length, 3);
  assert.equal(frames[2].previous_response_id, undefined);
  assert.deepEqual(frames[2].input, body.input);
});

test("abort terminates in-flight WebSocket stream", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  wss.on("connection", socket => socket.on("message", data => {
    if (JSON.parse(data.toString()).generate === false) socket.send(JSON.stringify(completed("warm")));
  }));
  const controller = new AbortController();
  const response = await f.transport.request(exchange(f, { signal: controller.signal }));
  const consumed = response.text(); controller.abort();
  await assert.rejects(consumed, { name: "AbortError" });
});

test("closing a pending handshake cannot fall back and send another request", async t => {
  let posts = 0;
  const f = await fixture(t, "auto", (_req, res) => { posts++; res.end(); });
  const upgrade = once(f.server, "upgrade");
  f.server.on("upgrade", (_req, socket) => t.after(() => socket.destroy()));
  const request = f.transport.request(exchange(f));
  await upgrade;
  f.transport.close();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(posts, 0);
});

test("parsed Pi replay preserves deltas despite argument whitespace and server status", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const frames = [];
  const raw = { type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: '{ "path": "a" }', status: "completed" };
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    const event = completed(`r${frames.length}`);
    if (!frame.generate && frames.length === 2) event.response.output = [raw];
    socket.send(JSON.stringify(event));
  }));
  await (await f.transport.request(exchange(f))).text();
  const model = { id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses", reasoning: true, input: ["text"] };
  const parsed = { role: "assistant", model: model.id, provider: model.provider, api: model.api,
    content: [{ type: "toolCall", id: "c1|fc_1", name: "read", arguments: { path: "a" } }], stopReason: "toolUse", timestamp: Date.now() };
  const replay = convertResponsesMessages(model, { messages: [parsed] }, new Set(["openai-codex"]), { includeSystemPrompt: false })
    .filter(item => !["function_call_output", "custom_tool_call_output"].includes(item.type));
  assert.notEqual(JSON.stringify(replay), JSON.stringify([raw]));
  f.transport.setReplayOutput("test", replay);
  const toolResult = { type: "function_call_output", call_id: "c1", output: "tool result" };
  await (await f.transport.request(exchange(f, { body: f.protocol.shapeBody({ ...body, input: [...body.input, ...replay, toolResult] }) }))).text();
  assert.equal(frames[2].previous_response_id, "r2");
  assert.deepEqual(frames[2].input, [toolResult]);
});

test("account changes cannot reuse sockets, routing state or continuation", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const connections = [];
  wss.on("connection", (socket, req) => {
    const frames = []; connections.push({ account: req.headers["chatgpt-account-id"], frames });
    socket.on("message", data => {
      frames.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": `token-${connections.length}` } }));
      socket.send(JSON.stringify(completed("r")));
    });
  });
  await (await f.transport.request(exchange(f))).text();
  const next = exchange(f); next.headers.set("chatgpt-account-id", "different-account"); next.headers.set("authorization", "Bearer different");
  await (await f.transport.request(next)).text();
  assert.equal(connections.length, 2);
  assert.equal(connections[1].frames[0].previous_response_id, undefined);
  assert.equal(connections[1].frames[0].client_metadata["x-codex-turn-state"], undefined);
});

test("SSE header timeout aborts a stalled request", async t => {
  const f = await fixture(t, "sse", req => req.resume());
  await assert.rejects(f.transport.request(exchange(f, { timeoutMs: 50 })), /timed out/);
});

test("SSE body idle timeout aborts a stalled stream", async t => {
  const f = await fixture(t, "sse", (req, res) => {
    req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: {}\n\n");
  });
  const response = await f.transport.request(exchange(f, { timeoutMs: 100 }));
  await assert.rejects(response.text());
});

test("real Pi decoder roundtrips Lite tool calls and encrypted reasoning over WebSocket", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const frames = [];
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "PRIVATE ENCRYPTED REASONING" };
  const tool = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", namespace: "functions", arguments: '{ "path": "a" }', status: "completed" };
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    const event = completed(`resp_${frames.length}`);
    if (!frame.generate) {
      event.response.output = [reasoning, tool];
      for (const [i, item] of event.response.output.entries()) {
        socket.send(JSON.stringify({ type: "response.output_item.added", output_index: i, item: item.type === "function_call" ? { ...item, arguments: "" } : item }));
        if (item.type === "function_call") socket.send(JSON.stringify({ type: "response.function_call_arguments.delta", output_index: i, item_id: item.id, delta: item.arguments }));
        socket.send(JSON.stringify({ type: "response.output_item.done", output_index: i, item }));
      }
    }
    socket.send(JSON.stringify(event));
  }));
  const model = { id: "gpt-6-astra", name: "Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } };
  const metadata = { slug: model.id, use_responses_lite: true, support_verbosity: false };
  const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64url")}.x`;
  const messages = [{ role: "user", content: "Read a", timestamp: Date.now() }];
  const context = { systemPrompt: "Test", messages, tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
  async function call(requestId) {
    let outgoing;
    const response = streamSimple(model, context, { apiKey: jwt, reasoning: "medium", transport: "sse",
      onPayload: value => { outgoing = shapeModelBody(f.protocol.shapeBody(value), metadata); return value; },
      fetch: async () => {
        const request = exchange(f, { body: outgoing, requestId, normalizeEvent: normalizeLiteEvent });
        request.headers.set("x-openai-internal-codex-responses-lite", "true");
        return f.transport.request(request);
      },
    });
    const message = await response.result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const replay = convertResponsesMessages(model, { messages: [message] }, new Set(["openai-codex"]), { includeSystemPrompt: false })
      .filter(item => !["function_call_output", "custom_tool_call_output"].includes(item.type));
    f.transport.setReplayOutput(requestId, shapeModelBody({ model: model.id, tools: [], input: replay }, metadata).input.slice(1));
    return message;
  }
  const message = await call("first");
  assert.match(message.content.find(item => item.type === "thinking").thinkingSignature, /PRIVATE ENCRYPTED REASONING/);
  messages.push(message, { role: "toolResult", toolCallId: message.content.find(item => item.type === "toolCall").id, toolName: "read", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() });
  await call("second");
  assert.equal(frames.length, 3);
  assert.equal(frames[2].previous_response_id, "resp_2");
  assert.equal(frames[2].input.length, 1);
  assert.equal(frames[2].input[0].type, "function_call_output");
  assert.equal(frames[2].client_metadata.ws_request_header_x_openai_internal_codex_responses_lite, "true");
  assert.equal(readFileSync(f.log, "utf8").includes("PRIVATE ENCRYPTED REASONING"), false);
});

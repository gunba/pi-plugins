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
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import requestTracing, { requestTrace } from "../extensions/request-trace.ts";

async function fixture(t, mode = "auto", handler, prewarm = true) {
  const directory = mkdtempSync(join(tmpdir(), "pi-wire-test-"));
  const log = join(directory, "log.jsonl");
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/codex/responses`;
  const protocol = new Protocol("codex", "thread", "install", identity);
  const allowances = [];
  // These legacy recovery fixtures explicitly exercise opt-in prewarming.
  const transport = new WireTransport(new Diagnostics(log), protocol, mode, fetch, {}, headers => allowances.push(headers), prewarm);
  t.after(() => { transport.close(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, url, protocol, transport, log, allowances };
}

const body = { model: "gpt-6-astra", input: [{ role: "user", content: "PRIVATE PROMPT" }], tools: [], store: false, stream: true };
const completed = id => ({ type: "response.completed", response: { id, status: "completed", output: [], service_tier: "default", usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 98 } } } });
function exchange(f, overrides = {}) { return { url: f.url, body: f.protocol.shapeBody(body), headers: f.protocol.headers(new Headers({ authorization: "Bearer SECRET", "chatgpt-account-id": "PRIVATE ACCOUNT" })), requestId: "test", timeoutMs: 3000, ...overrides }; }

const expired = { type: "error", status: 400, error: { code: "websocket_connection_limit_reached" } };
const model = { id: "gpt-6-astra", name: "Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } };
const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64url")}.x`;

for (const partial of [false, true]) for (const failure of ["close", "terminate", "idle"]) {
  test(`broken WebSocket selects SSE only for the caller's next request (${failure}, partial=${partial})`, async t => {
    const posts = [];
    const f = await fixture(t, "auto", (req, res) => {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        posts.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(completed("retry"))}\n\n`);
      });
    }, false);
    const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
    let frames = 0;
    wss.on("connection", socket => socket.on("message", () => {
      frames++;
      if (partial) socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "PRIVATE PARTIAL OUTPUT" }));
      if (failure === "close") socket.close(1011, "PRIVATE CLOSE REASON");
      if (failure === "terminate") socket.terminate();
    }));
    const notifications = [];
    await assert.rejects(async () => (await f.transport.request(exchange(f, {
      timeoutMs: failure === "idle" ? 100 : 3000,
      onFallback: phase => notifications.push(phase),
    }))).text(), /closed before completion|timed out/);
    assert.equal(frames, 1);
    assert.equal(posts.length, 0); // The transport must not replay even a no-output failure.
    assert.deepEqual(notifications, ["stream"]);
    const retryBody = f.protocol.shapeBody({ ...body, reasoning: { effort: "xhigh" } });
    await (await f.transport.request(exchange(f, { body: retryBody, requestId: "caller-retry" }))).text();
    assert.equal(frames, 1);
    assert.deepEqual(posts, [retryBody]);
    const log = readFileSync(f.log, "utf8");
    const diagnostic = log.trim().split("\n").map(JSON.parse).find(row => row.kind === "websocket-failure");
    assert.equal(diagnostic.sawOutput, partial);
    assert.equal(diagnostic.events, partial ? 1 : 0);
    assert.equal(diagnostic.reason, failure === "idle" ? "idle-timeout" : "closed");
    assert.equal(diagnostic.closeCode, failure === "close" ? 1011 : failure === "terminate" ? 1006 : undefined);
    assert.ok(diagnostic.elapsedMs >= diagnostic.idleMs);
    for (const secret of ["PRIVATE", "SECRET"]) assert.equal(log.includes(secret), false);
  });
}

for (const ending of ["abort", "cancel", "local-close", "completed-close", "model-error"]) {
  test(`intentional or terminal WebSocket endings do not select fallback (${ending})`, async t => {
    let posts = 0;
    const f = await fixture(t, "auto", (req, res) => { posts++; req.resume(); res.end(); }, false);
    const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
    let frames = 0;
    let received;
    const firstFrame = new Promise(resolve => { received = resolve; });
    wss.on("connection", socket => socket.on("message", () => {
      frames++;
      if (frames > 1) socket.send(JSON.stringify(completed("next")));
      else {
        received(socket);
        if (ending === "completed-close") socket.send(JSON.stringify(completed("done")), () => socket.close());
        if (ending === "model-error") socket.send(JSON.stringify({ type: "error", error: { code: "invalid_request", message: "PRIVATE ERROR" } }));
      }
    }));
    const controller = new AbortController();
    const response = await f.transport.request(exchange(f, { signal: controller.signal }));
    const socket = await firstFrame;
    if (ending === "cancel") await response.body.cancel();
    else if (ending === "completed-close" || ending === "model-error") {
      await response.text();
      if (ending === "completed-close" && socket.readyState !== socket.CLOSED) await once(socket, "close");
    } else {
      const consumed = response.text();
      if (ending === "abort") controller.abort(); else f.transport.close();
      await assert.rejects(consumed, { name: "AbortError" });
    }
    await (await f.transport.request(exchange(f, { requestId: "next" }))).text();
    assert.equal(frames, 2);
    assert.equal(posts, 0);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /"kind":"fallback"|PRIVATE ERROR/);
  });
}

function summaryEvents() {
  const item = { type: "message", id: "msg_summary", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Checkpoint.", annotations: [] }] };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Checkpoint." },
    { type: "response.output_item.done", output_index: 0, item },
    { ...completed("summary"), response: { ...completed("summary").response, output: [item] } },
  ];
}

for (const outcome of ["success", "failure", "abort"]) {
  test(`native Pi compaction retains its retry budget across WS-to-SSE recovery (${outcome})`, async t => {
    let posts = 0;
    const f = await fixture(t, "auto", (req, res) => {
      posts++; req.resume();
      if (outcome === "failure") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(summaryEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      }
    }, false);
    const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
    let frames = 0;
    wss.on("connection", socket => socket.on("message", () => { frames++; socket.close(1011); }));
    const handlers = new Map();
    requestTracing({ on: (name, handler) => handlers.set(name, handler) });
    const root = `summary-${outcome}`;
    const ctx = { sessionManager: { getSessionId: () => root } };
    const controller = new AbortController();
    handlers.get("session_start")({}, ctx);
    handlers.get("session_before_compact")({ signal: controller.signal }, ctx);
    t.after(() => handlers.get("session_shutdown")({}, ctx));
    const invocations = [];
    const traces = [];
    const stream = (selected, context, options) => {
      invocations.push(options.sessionId);
      assert.notEqual(options.sessionId, root);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.reasoning, "xhigh");
      assert.equal(options.cacheRetention, "none");
      const trace = requestTrace(root, options.sessionId, context, options.signal);
      traces.push(trace);
      let outgoing;
      return streamSimple(selected, context, {
        ...options, transport: "sse", maxRetries: 0,
        onPayload: value => {
          outgoing = shapeModelBody(f.protocol.shapeBody(value), {
            slug: model.id, use_responses_lite: true, support_verbosity: false,
          }, f.protocol.threadId);
          assert.equal(outgoing.model, model.id);
          assert.equal(outgoing.reasoning.effort, "xhigh");
          return value;
        },
        fetch: () => {
          const request = exchange(f, {
            body: outgoing, signal: options.signal, trace, requestId: `attempt-${invocations.length}`,
            normalizeEvent: normalizeLiteEvent,
          });
          request.headers.set("x-openai-internal-codex-responses-lite", "true");
          return f.transport.request(request);
        },
      });
    };
    const result = generateSummaryWithUsage(
      [{ role: "user", content: "A local fixture.", timestamp: 0 }],
      { ...model, thinkingLevelMap: { xhigh: "xhigh" } }, 1000, jwt,
      undefined, controller.signal, undefined, undefined, "xhigh", stream, undefined,
      { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      { onRetryScheduled: () => { if (outcome === "abort") controller.abort(); } },
    );
    if (outcome === "success") assert.equal((await result).text, "Checkpoint.");
    else if (outcome === "abort") {
      // AgentSession checks this signal before saving; the summary helper itself
      // may return an empty result after its retry loop is cancelled.
      await result;
      assert.equal(controller.signal.aborted, true);
    } else await assert.rejects(result, /failed/i);
    assert.equal(frames, 1);
    assert.equal(posts, outcome === "abort" ? 0 : 1);
    assert.equal(invocations.length, outcome === "abort" ? 1 : 2);
    assert.equal(new Set(invocations).size, 1);
    assert.ok(traces.every(trace => trace.callKind === "compaction" && trace.rootSessionId === root));
  });
}

test("default transport sends no prewarm and retains WebSocket continuation", async t => {
  const f = await fixture(t, "auto", undefined, false);
  // Omit the prewarm argument: verify the constructor default, not just false.
  const defaultTransport = new WireTransport(new Diagnostics(f.log), f.protocol, "auto", fetch, {});
  f.transport = defaultTransport;
  t.after(() => defaultTransport.close());
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const frames = [];
  wss.on("connection", socket => socket.on("message", data => {
    frames.push(JSON.parse(data.toString()));
    socket.send(JSON.stringify(completed(`response-${frames.length}`)));
  }));
  await (await f.transport.request(exchange(f))).text();
  await (await f.transport.request(exchange(f, {
    body: f.protocol.shapeBody({ ...body, input: [...body.input, { role: "user", content: "next" }] }),
  }))).text();
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => frame.generate !== false));
  assert.equal(frames[1].previous_response_id, "response-1");
  assert.equal(frames[1].input.length, 1);
});

for (const phase of ["prewarm", "stream"]) test(`expired WebSocket reconnects once in the same request (${phase})`, async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const connections = [];
  wss.on("connection", socket => {
    const frames = [];
    connections.push(frames);
    const number = connections.length;
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()); frames.push(frame);
      socket.send(JSON.stringify(number === 1 && (phase === "prewarm" || frame.generate !== false)
        ? expired : completed(`c${number}-${frames.length}`)));
    });
  });
  const text = await (await f.transport.request(exchange(f))).text();
  assert.match(text, /response.completed/);
  assert.doesNotMatch(text, /websocket_connection_limit_reached/);
  assert.equal(connections.length, 2);
  assert.equal(connections[1][0].generate, false);
  assert.equal(connections[1][0].previous_response_id, undefined);
  assert.deepEqual(connections[1][0].input, body.input);
  assert.match(readFileSync(f.log, "utf8"), /"kind":"websocket-reconnect"/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /"kind":"fallback"/);
});

test("expiry recovery is bounded and never falls back to an extra SSE inference", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  let connections = 0;
  wss.on("connection", socket => {
    connections++;
    socket.on("message", () => socket.send(JSON.stringify(expired)));
  });
  const result = await streamSimple(model, { messages: [] }, {
    apiKey: jwt, transport: "sse", maxRetries: 3,
    fetch: () => f.transport.request(exchange(f)),
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /connection limit reached/);
  assert.equal(connections, 2);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /"kind":"fallback"/);
});

test("expiry after model output stops without replaying the request", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  let connections = 0;
  wss.on("connection", socket => {
    connections++;
    socket.on("message", data => {
      if (JSON.parse(data.toString()).generate === false) socket.send(JSON.stringify(completed("warm")));
      else {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
        socket.send(JSON.stringify(expired));
      }
    });
  });
  await assert.rejects(async () => (await f.transport.request(exchange(f))).text(), /connection limit reached/);
  assert.equal(connections, 1);
});

test("cancelling the response body also cancels an expiry reconnect", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  let connected;
  const secondConnection = new Promise(resolve => { connected = resolve; });
  let count = 0;
  wss.on("connection", socket => {
    if (++count === 2) { connected(socket); return; }
    socket.on("message", data => socket.send(JSON.stringify(JSON.parse(data.toString()).generate === false ? completed("warm") : expired)));
  });
  const response = await f.transport.request(exchange(f));
  const socket = await secondConnection;
  const closed = once(socket, "close");
  await response.body.cancel();
  await closed;
  assert.equal(count, 2);
});

test("allowance updates cross the WS boundary without accepting upgrade routing tokens", async t => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ server: f.server });
  t.after(() => wss.close());
  wss.on("headers", headers => headers.push(
    "x-codex-secondary-used-percent: 91",
    "x-codex-secondary-window-minutes: 10080",
    "x-codex-turn-state: PRIVATE UPGRADE TOKEN",
  ));
  let used = 91;
  wss.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString());
    assert.equal(frame.client_metadata?.["x-codex-turn-state"], undefined);
    socket.send(JSON.stringify({
      type: "codex.rate_limits", plan_type: "pro", active_limit: "premium",
      rate_limits: { primary: { used_percent: ++used, window_minutes: 10080, reset_after_seconds: 3600 } },
      account_id: "PRIVATE ACCOUNT",
    }));
    socket.send(JSON.stringify(completed(`r${used}`)));
  }));
  await (await f.transport.request(exchange(f))).text();
  await (await f.transport.request(exchange(f))).text();
  assert.equal(f.allowances[0]["x-codex-secondary-used-percent"], 91);
  assert.deepEqual(f.allowances.slice(1).map(x => x["x-codex-primary-used-percent"]), [92, 93, 94]);
  assert.equal(f.allowances.at(-1)["x-codex-primary-window-minutes"], 10080);
  assert.equal(f.allowances.at(-1)["x-codex-primary-reset-after-seconds"], 3600);
  assert.equal(JSON.stringify(f.allowances).includes("PRIVATE"), false);
});

for (const lite of [false, true]) test(`allowance events cross SSE observation (Lite=${lite})`, async t => {
  const event = { type: "codex.rate_limits", rate_limits: {
    primary: { used_percent: 10, window_minutes: 300 },
    secondary: { used_percent: 95, window_minutes: 10080 },
  } };
  const f = await fixture(t, "sse", (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-secondary-used-percent": "94" });
    res.end(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(completed("r"))}\n\n`);
  });
  await (await f.transport.request(exchange(f, { normalizeEvent: lite ? normalizeLiteEvent : undefined }))).text();
  assert.equal(f.allowances[0]["x-codex-secondary-used-percent"], 94);
  assert.equal(f.allowances[1]["x-codex-secondary-used-percent"], 95);
  assert.equal(f.allowances[1]["x-codex-primary-used-percent"], 10);
});

test("WebSocket prewarms per connection, continues across turns and renews warmup on reconnect", async t => {
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
  f.protocol.beginTurn();
  await (await f.transport.request(exchange(f))).text();
  assert.equal(frames.length, 3);
  assert.equal(frames[0].generate, false);
  assert.equal(frames[1].previous_response_id, "resp_1");
  assert.deepEqual(frames[1].input, []);
  assert.equal(frames[1].client_metadata["x-codex-turn-state"], "PRIVATE ROUTING TOKEN");
  assert.equal(frames[2].previous_response_id, "resp_2");
  assert.equal(frames[2].client_metadata["x-codex-turn-state"], undefined);
  f.transport.close();
  await (await f.transport.request(exchange(f))).text();
  assert.equal(frames.length, 5);
  assert.equal(frames[3].generate, false);
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
  const f = await fixture(t, "sse");
  // Supply headers immediately so this tests body idleness, not TCP setup latency.
  const fetcher = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.transport.request(exchange(f, { timeoutMs: 100, fetcher }));
  await assert.rejects(response.text(), /timed out/);
});

for (const prewarm of [false, true]) for (const terminalOutput of ["full", "empty", "omitted"]) test(`real Pi decoder roundtrips Lite tool calls and encrypted reasoning over WebSocket (terminal output ${terminalOutput}, prewarm ${prewarm})`, async t => {
  const f = await fixture(t, "auto", undefined, prewarm);
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
    if (terminalOutput === "empty") event.response.output = [];
    if (terminalOutput === "omitted") delete event.response.output;
    socket.send(JSON.stringify(event));
  }));
  const metadata = { slug: model.id, use_responses_lite: true, support_verbosity: false };
  const messages = [{ role: "user", content: "Read a", timestamp: Date.now() }];
  const context = { systemPrompt: "Test", messages, tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
  async function call(requestId) {
    let outgoing;
    const response = streamSimple(model, context, { apiKey: jwt, reasoning: "medium", transport: "sse",
      onPayload: value => { outgoing = shapeModelBody(f.protocol.shapeBody(value), metadata, f.protocol.threadId); return value; },
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
    f.transport.setReplayOutput(requestId, shapeModelBody({ model: model.id, tools: [], input: replay }, metadata, f.protocol.threadId).input.slice(1));
    return message;
  }
  const message = await call("first");
  assert.match(message.content.find(item => item.type === "thinking").thinkingSignature, /PRIVATE ENCRYPTED REASONING/);
  messages.push(message, { role: "toolResult", toolCallId: message.content.find(item => item.type === "toolCall").id, toolName: "read", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() });
  await call("second");
  assert.equal(frames.length, prewarm ? 3 : 2);
  assert.equal(frames.at(-1).previous_response_id, prewarm ? "resp_2" : "resp_1");
  assert.equal(frames.at(-1).input.length, 1);
  assert.equal(frames.at(-1).input[0].type, "function_call_output");
  assert.equal(frames.at(-1).client_metadata.ws_request_header_x_openai_internal_codex_responses_lite, "true");
  assert.equal(readFileSync(f.log, "utf8").includes("PRIVATE ENCRYPTED REASONING"), false);
});

for (const scenario of ["out-of-order", "missing-done", "gap", "conflicting-duplicate", "conflicting-terminal", "malformed-index", "unsupported-item", "replay-count"]) {
  test(`streamed continuation items preserve lossless fallback (${scenario})`, async t => {
    const f = await fixture(t, "auto", undefined, false);
    const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
    const frames = [];
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "PRIVATE REASONING" };
    const tool = { type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: "{}" };
    let replay = [reasoning, tool];
    wss.on("connection", socket => socket.on("message", data => {
      frames.push(JSON.parse(data.toString()));
      const event = completed(`r${frames.length}`);
      const emit = (type, index, item) => socket.send(JSON.stringify({ type, output_index: index, item }));
      const done = (index, item) => emit("response.output_item.done", index, item);
      if (frames.length === 1) {
        if (scenario === "out-of-order") { done(1, tool); done(0, reasoning); }
        if (scenario === "missing-done") { emit("response.output_item.added", 1, tool); done(0, reasoning); }
        if (scenario === "gap") done(1, tool);
        if (scenario === "conflicting-duplicate") { done(0, reasoning); done(0, { ...reasoning, id: "rs_other" }); }
        if (scenario === "conflicting-terminal") { done(0, reasoning); event.response.output = [{ ...reasoning, id: "rs_other" }]; }
        if (scenario === "malformed-index") done("0", reasoning);
        if (scenario === "unsupported-item") { replay = [{ type: "unknown", id: "unsupported" }]; done(0, replay[0]); }
        if (scenario === "replay-count") { replay = []; done(0, reasoning); }
      }
      socket.send(JSON.stringify(event));
    }));
    await (await f.transport.request(exchange(f, { requestId: "first" }))).text();
    f.transport.setReplayOutput("first", replay);
    const next = { role: "user", content: "next" };
    const full = [...body.input, ...replay, next];
    await (await f.transport.request(exchange(f, { requestId: "second", body: f.protocol.shapeBody({ ...body, input: full }) }))).text();
    const delta = scenario === "out-of-order";
    assert.equal(frames[1].previous_response_id, delta ? "r1" : undefined);
    assert.deepEqual(frames[1].input, delta ? [next] : full);
    assert.equal(readFileSync(f.log, "utf8").includes("PRIVATE REASONING"), false);
  });
}

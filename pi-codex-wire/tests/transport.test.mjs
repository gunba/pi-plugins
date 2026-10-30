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
import { CapacityRecovery, capacityRetryAfter } from "../extensions/errors.ts";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { shapeModelBody, normalizeLiteEvent, responseNormalizer } from "../extensions/model-shape.ts";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { identity } from "./fixtures.mjs";
import { zstdDecompressSync } from "node:zlib";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import requestTracing, { requestTrace } from "../extensions/request-trace.ts";

async function fixture(t, mode = "auto", handler, prewarm = true, capacitySchedule) {
  const directory = mkdtempSync(join(tmpdir(), "pi-wire-test-"));
  const log = join(directory, "log.jsonl");
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/codex/responses`;
  const protocol = new Protocol("codex", "thread", "install", identity);
  const allowances = [];
  // These legacy recovery fixtures explicitly exercise opt-in prewarming.
  const diagnostics = new Diagnostics(log);
  const transport = new WireTransport(diagnostics, protocol, mode, fetch, {}, headers => allowances.push(headers), prewarm, capacitySchedule);
  t.after(() => { transport.close(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, url, protocol, transport, log, allowances, diagnostics };
}

const body = { model: "gpt-6-astra", input: [{ role: "user", content: "PRIVATE PROMPT" }], tools: [], store: false, stream: true };
const completed = id => ({ type: "response.completed", response: { id, status: "completed", output: [], service_tier: "default", usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 98 } } } });
function exchange(f, overrides = {}) { return { url: f.url, body: f.protocol.shapeBody(body), headers: f.protocol.headers(new Headers({ authorization: "Bearer SECRET", "chatgpt-account-id": "PRIVATE ACCOUNT" })), requestId: "test", timeoutMs: 3000, ...overrides }; }

const expired = { type: "error", status: 400, error: { code: "websocket_connection_limit_reached" } };
const model = { id: "gpt-6-astra", name: "Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } };
const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64url")}.x`;

const capacityFailure = headers => ({ type: "response.failed", response: { id: "capacity", status: "failed",
  error: { code: "policy_capacity_unavailable", message: "Selected model is at capacity. Please try a different model.", headers } } });

async function capacityFixture(t, mode, events, schedule = [1, 2]) {
  const requests = [];
  const f = await fixture(t, mode, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events(requests.length).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  }, false, schedule);
  if (mode === "auto") {
    const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
    wss.on("connection", socket => socket.on("message", data => {
      requests.push(data.toString());
      for (const event of events(requests.length)) socket.send(JSON.stringify(event));
    }));
  }
  return { ...f, requests };
}

function capacityWait(f) {
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const write = f.diagnostics.write.bind(f.diagnostics);
  f.diagnostics.write = row => { write(row); if (row.kind === "capacity-wait") resolve(row); };
  return waiting;
}

for (const mode of ["auto", "sse"]) {
  test(`capacity recovery hides two failures, replays identical requests, and resets after success (${mode})`, async t => {
    const f = await capacityFixture(t, mode, n => [
      { type: "response.created", response: { id: `attempt-${n}`, status: "in_progress" } },
      ...(n % 3 ? [capacityFailure()] : summaryEvents()),
    ]);
    let fetches = 0;
    for (const requestId of ["first", "tool-follow-up"]) {
      const stream = streamSimple(model, { messages: [] }, { apiKey: jwt, transport: "sse", maxRetries: 0,
        fetch: () => { fetches++; return f.transport.request(exchange(f, { requestId, normalizeEvent: responseNormalizer(false) })); } });
      const events = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      assert.equal(result.stopReason, "stop");
      assert.deepEqual(result.content, [{ type: "text", text: "Checkpoint.", textSignature: '{"v":1,"id":"msg_summary"}' }]);
      assert.equal(events.filter(type => type === "done").length, 1);
      assert.equal(events.includes("error"), false);
    }
    assert.equal(fetches, 2);
    assert.equal(f.requests.length, 6);
    assert.equal(f.requests[1], f.requests[0]); assert.equal(f.requests[2], f.requests[0]);
    assert.equal(f.requests[4], f.requests[3]); assert.equal(f.requests[5], f.requests[3]);
    const rows = readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.filter(row => row.kind === "capacity-wait").map(row => row.delayMs), [1, 2, 1, 2]);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET|try a different model/);
  });

  for (const ending of ["abort", "cancel", "close"]) test(`capacity wait ends on ${ending} without resending (${mode})`, { timeout: 5000 }, async t => {
    const f = await capacityFixture(t, mode, () => [capacityFailure()], [30_000]);
    const waiting = capacityWait(f);
    const controller = new AbortController();
    const response = await f.transport.request(exchange(f, { signal: controller.signal, normalizeEvent: responseNormalizer(false) }));
    const reader = response.body.getReader();
    const read = reader.read();
    const rejected = ending === "cancel" ? read : assert.rejects(read, { name: "AbortError" });
    assert.equal((await waiting).delayMs, 30_000);
    await assert.rejects(f.transport.request(exchange(f)), /Concurrent requests/);
    if (ending === "abort") controller.abort();
    else if (ending === "close") f.transport.close();
    else await reader.cancel();
    await rejected;
    reader.releaseLock();
    assert.equal(f.requests.length, 1);
    assert.equal(readFileSync(f.log, "utf8").includes('"kind":"capacity-wait-end"'), true);
  });

  for (const output of [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc_partial", type: "function_call", name: "exec", arguments: "" } },
    { type: "response.output_text.delta", output_index: 0, delta: "partial" },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "partial reasoning" },
  ]) test(`capacity failure after ${output.type} is never replayed (${mode})`, async t => {
    const f = await capacityFixture(t, mode, () => [output, capacityFailure({ "Retry-After": "0" })]);
    const text = await (await f.transport.request(exchange(f))).text();
    const events = text.trim().split("\n\n").map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(events[0], output);
    assert.equal(events[1].response.error.message, "Policy-restricted capacity is unavailable; waited 0s. Output was already received; this attempt was not resent.");
    assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: events[1].response.error.message }), false);
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /"kind":"capacity-wait"/);
  });

  test(`exhausted capacity recovery is non-retryable to Pi (${mode})`, async t => {
    const f = await capacityFixture(t, mode, () => [capacityFailure({ "Retry-After": "0" })]);
    const result = await streamSimple(model, { messages: [] }, { apiKey: jwt, transport: "sse", maxRetries: 0,
      fetch: () => f.transport.request(exchange(f, { normalizeEvent: responseNormalizer(false) })) }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /^Policy-restricted capacity is unavailable; waited \d+s\. Capacity recovery budget exhausted\.$/);
    assert.equal(isRetryableAssistantError(result), false);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[1], f.requests[0]); assert.equal(f.requests[2], f.requests[0]);
  });
}

test("capacity advice accepts HTTP delays and dates but rejects malformed values", () => {
  const now = Date.UTC(1994, 10, 6, 8, 49, 30);
  for (const [raw, expected] of [["0", 0], [2, 2000], [" 30\t", 30000], ["3600", 600000],
    ["18446744073709551615", 600000], ["Sun, 06 Nov 1994 08:49:37 GMT", 7000],
    ["Sunday, 06-Nov-94 08:49:37 GMT", 7000], ["Sun Nov  6 08:49:37 1994", 7000],
    ["Sun, 06 Nov 1994 08:49:00 GMT", 0], [undefined, undefined], ["", undefined],
    ["-1", undefined], ["0.5", undefined], [["0"], undefined], [true, undefined],
    ["Thu, 31 Feb 2000 12:00:00 GMT", undefined], ["0\r\n", undefined], ["2026-01-01", undefined]]) {
    assert.equal(capacityRetryAfter({ "rEtRy-AfTeR": raw }, now), expected, JSON.stringify(raw));
  }
  assert.equal(capacityRetryAfter({ "retry-after-ms": "0" }, now), undefined);
  assert.equal(capacityRetryAfter({ "Retry-After": "Friday, 01-Jan-66 00:00:00 GMT" }, Date.UTC(2026, 0, 1)), 600000);
});

for (const [advice, expectedWaits, seconds] of [
  [undefined, [30000, 60000, 120000, 240000], 450],
  ["0", [0, 0, 0, 0], 0],
  ["3600", [600000], 600],
  ["503", [503000], 503],
]) test(`capacity budget bounds all waits and advice (${advice ?? "fallback"})`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let waiting = Promise.withResolvers();
  const rows = [];
  const recovery = new CapacityRecovery(undefined, row => {
    rows.push(row);
    if (row.kind === "capacity-wait") waiting.resolve(row);
  });
  let attempts = 0;
  const attempt = () => {
    attempts++;
    return new Response(new ReadableStream({ start(controller) {
      try {
        const event = recovery.event(capacityFailure(advice === undefined ? undefined : { "Retry-After": advice }));
        controller.enqueue(new TextEncoder().encode(JSON.stringify(event))); controller.close();
      } catch (error) { controller.error(error); }
    } }));
  };
  const text = recovery.wrap(attempt(), async () => attempt(), () => {}).text();
  for (const delay of expectedWaits) {
    assert.equal((await waiting.promise).delayMs, delay);
    waiting = Promise.withResolvers();
    now += delay;
    t.mock.timers.tick(delay);
  }
  const result = JSON.parse(await text);
  assert.equal(result.response.error.message, `Policy-restricted capacity is unavailable; waited ${seconds}s. Capacity recovery budget exhausted.`);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: result.response.error.message }), false);
  assert.equal(attempts, expectedWaits.length + 1);
  assert.deepEqual(rows.filter(row => row.kind === "capacity-wait").map(row => row.delayMs), expectedWaits);
});

test("capacity recovery preserves other failures and treats terminal output as non-replayable", () => {
  const recovery = new CapacityRecovery(undefined, () => {});
  for (const event of [
    { type: "error", error: { code: "policy_capacity_unavailable", message: "model is at capacity" } },
    { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "model is at capacity" } } },
    { type: "response.failed", response: { error: { code: "model_not_found", message: "Not found" } } },
  ]) assert.equal(recovery.event(event), event);
  const event = capacityFailure();
  event.response.output = [{ type: "function_call", name: "exec", arguments: "{}" }];
  const normalized = recovery.event(event);
  assert.equal(normalized.response.error.message, "Policy-restricted capacity is unavailable; waited 0s. Output was already received; this attempt was not resent.");
  assert.deepEqual(normalized.response.output, event.response.output);
  assert.equal(event.response.error.message, "Selected model is at capacity. Please try a different model.");
});

test("SSE diagnostics distinguish an uploaded request waiting for headers from a stream failure", async t => {
  let requests = 0;
  const f = await fixture(t, "sse", req => { requests++; req.resume(); });
  await assert.rejects(f.transport.request(exchange(f, { timeoutMs: 200 })), /SSE stream timed out/);
  const rows = readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests, 1);
  assert.equal(rows.some(row => row.kind === "http-network" && row.stage === "body-sent"), true);
  assert.equal(rows.some(row => row.kind === "headers"), false);
  const failure = rows.find(row => row.kind === "sse-failure");
  assert.equal(failure.phase, "headers");
  assert.equal(failure.abortSource, "timeout");
  assert.equal(failure.receivedBytes, 0);
  assert.equal(failure.timeoutMs, 200);
  assert.equal(rows.find(row => row.kind === "request").streamRequested, true);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET/);
});

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
    assert.equal(diagnostic.timeoutMs, failure === "idle" ? 100 : 3000);
    assert.equal(diagnostic.lastEventType, partial ? "response.output_text.delta" : undefined);
    assert.deepEqual(diagnostic.eventCounts, partial ? { "response.output_text.delta": 1 } : {});
    assert.equal(diagnostic.receivedBytes > 0, partial);
    if (failure !== "idle") assert.equal(diagnostic.network.tcpClosed, true);
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
  // As in native Codex 0.164.0, a prewarm carries no conversation; the request after it continues from it.
  assert.deepEqual(connections[1][0].input, []);
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
  assert.deepEqual(frames[0].input, [], "the prewarm carries no conversation");
  assert.deepEqual(frames[1].input, body.input, "the turn continues from the prewarm with the whole input");
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

test("SSE fallback automatically recovers WebSocket with bounded backoff and no stream replay", async t => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  let posts = 0, upgrades = 0, available = false, breakStream = false;
  const f = await fixture(t, "auto", (req, res) => {
    posts++; req.resume(); res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(completed(`sse-${posts}`))}\n\n`);
  }, false);
  const wss = new WebSocketServer({ noServer: true }); t.after(() => wss.close());
  const frames = [], headers = [], notifications = [], initialHeaders = exchange(f).headers;
  f.server.on("upgrade", (req, socket, head) => {
    upgrades++;
    if (!available) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    headers.push(req.headers);
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  });
  wss.on("connection", socket => socket.on("message", data => {
    frames.push(JSON.parse(data.toString()));
    if (breakStream) {
      breakStream = false;
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "PRIVATE PARTIAL" }));
      socket.close(1011); return;
    }
    socket.send(JSON.stringify(completed(`ws-${frames.length}`)));
  }));
  const request = () => f.transport.request(exchange(f, { onFallback: phase => notifications.push(phase) }));
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    const before = upgrades;
    await (await request()).text();
    assert.equal(upgrades, before + 1);
    now += delay - 1;
    await (await request()).text();
    assert.equal(upgrades, before + 1, "no upgrade before its backoff expires");
    now++;
  }
  assert.deepEqual(notifications, ["connect"], "one notification for the fallback episode");
  assert.equal(frames.length, 0);
  const postsBeforeRecovery = posts;
  available = true;
  await (await request()).text();
  assert.equal(frames.length, 1);
  assert.equal(posts, postsBeforeRecovery);
  assert.deepEqual(frames[0].input, body.input);
  assert.equal(frames[0].previous_response_id, undefined);
  assert.equal(frames[0].prompt_cache_key, f.protocol.shapeBody(body).prompt_cache_key);
  await (await request()).text();
  assert.equal(frames[1].previous_response_id, "ws-1");
  assert.deepEqual(frames[1].input, []);
  breakStream = true;
  await assert.rejects(async () => (await request()).text(), /closed before completion/);
  assert.equal(posts, postsBeforeRecovery, "an interrupted WS inference is never replayed over SSE");
  assert.deepEqual(notifications, ["connect", "stream"]);
  now += 29_999;
  await (await request()).text();
  assert.equal(frames.length, 3);
  now++;
  await (await request()).text();
  assert.equal(frames.length, 4, "successful WS completion resets the backoff");
  assert.equal(headers.length, 2);
  for (const header of ["session-id", "thread-id", "x-codex-window-id", "authorization", "chatgpt-account-id"]) {
    assert.ok(initialHeaders.get(header));
    assert.deepEqual(headers.map(value => value[header]), [initialHeaders.get(header), initialHeaders.get(header)]);
  }
  assert.deepEqual(frames[3].input, body.input);
  assert.equal(frames[3].previous_response_id, undefined);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /"kind":"websocket-recovery"/);
  assert.doesNotMatch(log, /PRIVATE|SECRET/);
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

test("a terminated SSE body explains the socket failure and records progress without output text", async t => {
  let requests = 0;
  const f = await fixture(t, "sse", (req, res) => {
    requests++; req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "PRIVATE REASONING" })}\n\n`);
    const timer = setTimeout(() => res.destroy(), 40);
    t.after(() => clearTimeout(timer));
  });
  await assert.rejects(async () => (await f.transport.request(exchange(f))).text(), error => {
    assert.match(error.message, /response stream terminated before completion.*connection closed/i);
    assert.equal(error.cause?.message, "terminated");
    return true;
  });
  const rows = readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
  const failure = rows.find(row => row.kind === "sse-failure");
  assert.equal(failure.phase, "body"); assert.equal(failure.abortSource, "none");
  assert.deepEqual(failure.errorCodes, ["UND_ERR_SOCKET"]);
  assert.equal(failure.terminalSeen, false); assert.equal(failure.events, 1);
  assert.equal(failure.eventCounts["response.reasoning_summary_text.delta"], 1);
  assert.ok(failure.firstEventMs >= 0); assert.ok(failure.lastReasoningMs >= failure.firstEventMs);
  assert.ok(failure.idleMs >= 0); assert.ok(failure.maxGapMs >= 0);
  assert.equal(requests, 1, "a partial response must not be replayed by transport recovery");
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET/);
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
    f.transport.setReplayOutput(requestId, shapeModelBody({ model: model.id, tools: [], input: replay }, metadata, f.protocol.threadId).input);
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
  // Codex 0.164.0's field order: routing fields before the input.
  assert.deepEqual(Object.keys(frames.at(-1)), ["type", "model", "stream", "previous_response_id", "input", "tool_choice",
    "parallel_tool_calls", "reasoning", "store", "include", "prompt_cache_key", "client_metadata"]);
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

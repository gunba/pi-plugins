import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import extension from "../extensions/index.ts";
import { identity } from "./fixtures.mjs";
import { saveDefaultMode } from "../extensions/settings.ts";

const model = { id: "gpt-6-astra", name: "Astra", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 };
const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE ACCOUNT" } })).toString("base64url")}.x`;

function harness(t, mode = "codex", savedDefault) {
  const directory = mkdtempSync(join(tmpdir(), "pi-wire-ext-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(directory, { recursive: true, force: true }); });
  const events = new Map(), commands = new Map(), flags = new Map([["codex-wire", mode], ["codex-wire-transport", "sse"], ["codex-wire-user-agent", identity.userAgent]]);
  if (mode === null) flags.delete("codex-wire");
  if (savedDefault) saveDefaultMode(join(directory, "codex-wire"), savedDefault);
  const original = { id: "openai-codex", name: "OpenAI Codex", stream, streamSimple, getModels: () => [model] };
  let provider = original;
  const entries = [], published = [];
  const api = { events: { emit: (name, data) => published.push({ name, data }) }, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), registerFlag() {}, getFlag: name => flags.get(name), on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command), registerProvider: next => { provider = next; } };
  const notices = [];
  const ctx = { ui: { notify: text => notices.push(text), setStatus() {} }, modelRegistry: { getProvider: () => provider }, sessionManager: { getSessionId: () => "pi-thread", getBranch: () => entries }, isIdle: () => true };
  extension(api);
  events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  return { directory, events, commands, ctx, original, flags, notices, published, provider: () => provider };
}

function decode(init) {
  const encoding = new Headers(init.headers).get("content-encoding");
  if (encoding === "zstd") return JSON.parse(zstdDecompressSync(init.body).toString());
  if (encoding === "gzip") return JSON.parse(gunzipSync(init.body).toString());
  return JSON.parse(init.body);
}

function concurrentFetch(t, expected) {
  const requests = [], releases = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let released = false;
  const release = () => { released = true; releases.splice(0).forEach(fn => fn()); };
  t.after(release);
  const fetcher = async (url, init) => {
    if (String(url).includes("/models?")) return Response.json({ models: [{ slug: model.id, use_responses_lite: false }] });
    const headers = new Headers(init.headers);
    const thread = headers.get("session-id");
    requests.push({ headers, body: decode(init) });
    if (requests.length === expected) ready();
    if (!released) await new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      init.signal.addEventListener("abort", abort, { once: true });
      releases.push(() => { init.signal.removeEventListener("abort", abort); resolve(); });
      if (init.signal.aborted) abort();
    });
    const event = { type: "response.completed", response: {
      id: `resp_${thread}`, status: "completed", output: [],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: {
      "content-type": "text/event-stream", "x-codex-turn-state": `sticky-${thread}`,
    } });
  };
  return { fetcher, requests, started, release };
}

for (const cancelParent of [false, true]) test(`inherited provider isolates parent and concurrent SDK sessions (cancelParent=${cancelParent})`, { timeout: 10000 }, async t => {
  const h = harness(t);
  const f = concurrentFetch(t, 3);
  const ids = ["pi-thread", "child-a", "child-b"];
  const contexts = ids.map(id => ({ messages: [{ role: "user", content: id, timestamp: 1 }] }));
  const streams = ids.map((id, i) => h.provider().streamSimple(model, contexts[i], {
    apiKey: jwt, sessionId: id, fetch: f.fetcher,
  }));
  await f.started;
  if (cancelParent) h.events.get("model_select")({}, h.ctx);
  f.release();
  const results = await Promise.all(streams.map(s => s.result()));
  assert.deepEqual(results.map(r => r.stopReason), [cancelParent ? "aborted" : "stop", "stop", "stop"]);
  assert.deepEqual(new Set(f.requests.map(r => r.body.prompt_cache_key)), new Set(ids));
  assert.equal(new Set(f.requests.map(r => r.headers.get("x-codex-window-id"))).size, 3);
  for (const request of f.requests) {
    assert.equal(request.body.client_metadata.thread_id, request.headers.get("session-id"));
    assert.equal(request.headers.get("x-codex-turn-state"), null);
  }
  // The child's next tool round trip retains only its own routing state.
  await h.provider().streamSimple(model, contexts[1], { apiKey: jwt, sessionId: "child-a", fetch: f.fetcher }).result();
  assert.equal(f.requests.at(-1).headers.get("x-codex-turn-state"), "sticky-child-a");
  // A new user turn resets sticky state even though child extensions are disabled.
  await h.provider().streamSimple(model, { messages: [{ role: "user", content: "next", timestamp: 2 }] },
    { apiKey: jwt, sessionId: "child-a", fetch: f.fetcher }).result();
  assert.equal(f.requests.at(-1).headers.get("x-codex-turn-state"), null);
});

test("retired inherited providers stay aborted; child window identity survives reactivation", async t => {
  const h = harness(t);
  const f = concurrentFetch(t, 1);
  f.release();
  const options = { apiKey: jwt, sessionId: "child-a", fetch: f.fetcher };
  const context = { messages: [{ role: "user", content: "child", timestamp: 1 }] };
  const inherited = h.provider();
  assert.equal((await inherited.streamSimple(model, context, options).result()).stopReason, "stop");
  const window = f.requests[0].headers.get("x-codex-window-id");
  await h.commands.get("codex-wire").handler("off", h.ctx);
  assert.equal((await inherited.streamSimple(model, context, options).result()).stopReason, "aborted");
  assert.equal(f.requests.length, 1);
  await h.commands.get("codex-wire").handler("codex", h.ctx);
  assert.equal((await h.provider().streamSimple(model, context, options).result()).stopReason, "stop");
  assert.equal(f.requests.at(-1).headers.get("x-codex-window-id"), window);
});

test("real Pi serializer/parser integrates with emulated SSE and does not send secrets to logs", async t => {
  const h = harness(t);
  const captured = [];
  let catalogCalls = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).includes("/models?")) {
      catalogCalls++;
      return Response.json({ models: [{ slug: model.id, support_verbosity: true, default_verbosity: "medium", service_tiers: [], use_responses_lite: false }] });
    }
    captured.push({ headers: new Headers(init.headers), body: decode(init) });
    const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"test.txt"}', status: "completed" };
    const events = [
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 95, window_minutes: 10080 } } },
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 90 } } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-codex-turn-state": "PRIVATE TOKEN" } });
  };
  h.events.get("before_agent_start")({}, h.ctx);
  const response = h.provider().streamSimple(model, { systemPrompt: "PRIVATE INSTRUCTIONS", messages: [{ role: "user", content: "PRIVATE QUESTION", timestamp: Date.now() }], tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }, { apiKey: jwt, reasoning: "medium", fetch: fakeFetch });
  const result = await response.result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.equal(result.content[0].type, "toolCall");
  assert.equal(result.content[0].name, "read");
  assert.deepEqual(result.content[0].arguments, { path: "test.txt" });
  assert.equal(result.usage.cacheRead, 90);
  assert.deepEqual(h.published, [{ name: "pi-codex-wire:allowance", data: {
    "x-codex-primary-used-percent": 95, "x-codex-primary-window-minutes": 10080,
  } }]);
  assert.equal(catalogCalls, 1);
  assert.equal(captured[0].headers.get("originator"), "codex_cli_rs");
  assert.equal(captured[0].headers.get("x-codex-routing-hint"), "model=gpt-6-astra");
  assert.equal(captured[0].body.reasoning.effort, "medium");
  assert.equal(captured[0].body.text.verbosity, "medium");
  assert.equal(captured[0].body.tools[0].strict, false);
  const logs = readdirSync(join(h.directory, "codex-wire", "logs")).map(f => readFileSync(join(h.directory, "codex-wire", "logs", f), "utf8")).join("");
  for (const secret of [jwt, "PRIVATE INSTRUCTIONS", "PRIVATE QUESTION", "PRIVATE TOKEN", "FAKE ACCOUNT"]) assert.equal(logs.includes(secret), false);
});

test("loading default off is inert and switching off restores provider", async t => {
  const h = harness(t, "off");
  assert.strictEqual(h.provider(), h.original);
  await h.commands.get("codex-wire").handler("pi", h.ctx);
  assert.notStrictEqual(h.provider(), h.original);
  await h.commands.get("codex-wire").handler("off", h.ctx);
  assert.strictEqual(h.provider(), h.original);
});

test("catalog errors stop before inference, not a silent protocol downgrade", async t => {
  const h = harness(t);
  let calls = 0;
  const response = h.provider().streamSimple(model, { messages: [] }, { apiKey: jwt, fetch: async () => { calls++; return new Response("no", { status: 403 }); } });
  const result = await response.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /catalog unavailable/);
  assert.equal(calls, 1);
});

test("shutdown cancels catalog lookup before inference", async t => {
  const h = harness(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const response = h.provider().streamSimple(model, { messages: [] }, { apiKey: jwt, fetch: (_url, init) => new Promise((resolve, reject) => {
    started(); init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }) });
  await ready;
  h.events.get("session_shutdown")({}, h.ctx);
  assert.equal((await response.result()).stopReason, "aborted");
});

test("context windows persist through mode switches and rotate after compaction", async t => {
  const h = harness(t);
  const entries = h.ctx.sessionManager.getBranch();
  const initial = entries.at(-1).data.id;
  await h.commands.get("codex-wire").handler("pi", h.ctx);
  assert.equal(entries.length, 1);
  h.events.get("session_compact")({}, h.ctx);
  assert.notEqual(entries.at(-1).data.id, initial);
  assert.equal(entries.length, 2);
});

test("invalid identity/compression flags cannot replace an active provider", async t => {
  const h = harness(t);
  const active = h.provider();
  h.flags.set("codex-wire-user-agent", "invalid profile");
  await h.commands.get("codex-wire").handler("pi", h.ctx);
  assert.strictEqual(h.provider(), active);
  h.flags.set("codex-wire-user-agent", identity.userAgent);
  h.flags.set("codex-wire-compression", "invalid");
  await h.commands.get("codex-wire").handler("pi", h.ctx);
  assert.strictEqual(h.provider(), active);
});

test("a saved default is reused on startup, reload, resume, fork and new sessions", async t => {
  const h = harness(t, null);
  assert.strictEqual(h.provider(), h.original);
  await h.commands.get("codex-wire").handler("default codex", h.ctx);
  assert.strictEqual(h.provider(), h.original, "saving alone must not replace the active provider");
  for (const reason of ["startup", "reload", "resume", "fork", "new"]) {
    h.events.get("session_shutdown")({}, h.ctx);
    h.events.get("session_start")({ reason }, h.ctx);
    assert.notStrictEqual(h.provider(), h.original);
  }
  await h.commands.get("codex-wire").handler("default off", h.ctx);
  h.events.get("session_shutdown")({}, h.ctx);
  h.events.get("session_start")({}, h.ctx);
  assert.strictEqual(h.provider(), h.original);
});

test("an explicit off flag overrides a saved codex default", t => {
  const h = harness(t, "off", "codex");
  assert.strictEqual(h.provider(), h.original);
});

test("real Pi streaming accepts an unlisted model with native fallback and truthful status", async t => {
  const h = harness(t);
  const command = h.commands.get("codex-wire");
  await command.handler("status", h.ctx);
  assert.match(h.notices.at(-1), /Last request: not tested/);
  let sent = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).includes("/models?")) return Response.json({ models: [{ slug: "gpt-5.6-sol", use_responses_lite: true }] });
    const body = decode(init); sent++;
    assert.equal(body.model, "gpt-6-astra");
    assert.equal(body.reasoning.effort, "medium");
    assert.equal(body.reasoning.summary, "auto");
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.text, undefined);
    assert.equal(new Headers(init.headers).get("x-openai-internal-codex-responses-lite"), null);
    return new Response('data: {"type":"response.completed","response":{"id":"test","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  for (let i = 0; i < 2; i++) {
    const result = await h.provider().streamSimple(model, { messages: [] }, { apiKey: jwt, reasoning: "medium", fetch: fakeFetch }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
  assert.equal(sent, 2);
  assert.equal(h.notices.filter(text => text.includes("unlisted")).length, 1);
  await command.handler("status", h.ctx);
  assert.match(h.notices.at(-1), /Last request: succeeded \(stop\)/);
});

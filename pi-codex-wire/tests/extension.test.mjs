import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import extension from "../extensions/index.ts";
import { identity } from "./fixtures.mjs";

const model = { id: "gpt-6-astra", name: "Astra", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 };
const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE ACCOUNT" } })).toString("base64url")}.x`;

function harness(t, mode = "codex") {
  const directory = mkdtempSync(join(tmpdir(), "pi-wire-ext-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(directory, { recursive: true, force: true }); });
  const events = new Map(), commands = new Map(), flags = new Map([["codex-wire", mode], ["codex-wire-transport", "sse"], ["codex-wire-user-agent", identity.userAgent]]);
  const original = { id: "openai-codex", name: "OpenAI Codex", stream, streamSimple, getModels: () => [model] };
  let provider = original;
  const entries = [];
  const api = { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), registerFlag() {}, getFlag: name => flags.get(name), on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command), registerProvider: next => { provider = next; } };
  const ctx = { ui: { notify() {}, setStatus() {} }, modelRegistry: { getProvider: () => provider }, sessionManager: { getSessionId: () => "pi-thread", getBranch: () => entries }, isIdle: () => true };
  extension(api);
  events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  return { directory, events, commands, ctx, original, flags, provider: () => provider };
}

function decode(init) {
  const encoding = new Headers(init.headers).get("content-encoding");
  if (encoding === "zstd") return JSON.parse(zstdDecompressSync(init.body).toString());
  if (encoding === "gzip") return JSON.parse(gunzipSync(init.body).toString());
  return JSON.parse(init.body);
}

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
  assert.equal(catalogCalls, 1);
  assert.equal(captured[0].headers.get("originator"), "codex_cli_rs");
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

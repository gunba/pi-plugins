import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import wire from "../../pi-codex-wire/extensions/index.ts";
import { requireCodexWire } from "../../pi-codex-wire/extensions/required.ts";
import { inheritProviderRuntime } from "../extensions/subagents.ts";
import { PiSdkDriverFactory } from "../extensions/pi-sdk-driver.ts";

test("real noExtensions SDK children inherit mandatory Wire, identity and isolated threads", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-wire-sdk-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = root;
  const requests = [];
  const model = {
    id: "gpt-6-astra", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000,
  };
  const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.x`;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://chatgpt.com/"), "no unexpected endpoint");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("originator"), "codex_cli_rs");
    if (String(url).includes("/models?")) return Response.json({ models: [{ slug: model.id }] });
    const encoding = headers.get("content-encoding");
    const body = JSON.parse(encoding === "zstd" ? zstdDecompressSync(init.body).toString()
      : encoding === "gzip" ? gunzipSync(init.body).toString() : init.body);
    requests.push({ headers, body });
    const response = { id: `resp_${requests.length}`, status: "completed", output: [],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  };
  const events = new Map();
  const entries = [];
  const flags = new Map([
    ["codex-wire-transport", "sse"],
    ["codex-wire-user-agent", "codex_cli_rs/0.153.4 (Windows NT 10.0.26100; x86_64)"],
  ]);
  let provider = {
    id: model.provider, name: "Offline Codex",
    auth: { apiKey: { name: "Offline", async resolve() { return { auth: { apiKey: jwt }, source: "stored API key" }; } } },
    getModels: () => [model], stream, streamSimple,
  };
  const ctx = {
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getSessionId: () => "wire-root", getBranch: () => entries },
    modelRegistry: {
      find: () => model, getProvider: () => provider,
      async getApiKeyAndHeaders() { return { ok: true, apiKey: jwt }; },
      async getProviderAuth() { return { auth: { apiKey: jwt }, source: "stored API key" }; },
    },
  };
  wire({
    registerFlag() {}, getFlag: name => flags.get(name), registerCommand() {},
    events: { emit() {} }, on: (name, handler) => events.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    registerProvider: value => { provider = value; },
  });
  const drivers = [];
  t.after(async () => {
    for (const driver of drivers) await driver.dispose();
    events.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => requireCodexWire("wire-root"), /without.*Codex Wire/);
  events.get("session_start")({}, ctx);
  requireCodexWire("wire-root");
  const childRuntimes = [];
  const host = {
    rootSessionId: "wire-root", cwd: root, agentDir: root,
    isProjectTrusted: () => true, resolveModel: () => model,
    async prepareModelRuntime(ref, runtime, signal) {
      requireCodexWire("wire-root");
      await inheritProviderRuntime(ctx, ref, runtime, undefined, signal);
      childRuntimes.push(runtime);
    },
  };
  for (const id of ["child-a", "child-b"]) {
    const manager = SessionManager.create(root, join(root, "sessions"), { id });
    drivers.push(await new PiSdkDriverFactory(host).open({
      signal: new AbortController().signal,
      descriptor: {
        version: 2, projectTrusted: true, childSessionId: id, rootSessionId: "wire-root",
        parentSessionId: "wire-root", mode: "continuable", context: "fresh", provider: "pi-sdk",
        label: id, depth: 1, cwd: root, createdAt: Date.now(),
        model: { provider: model.provider, id: model.id }, thinkingLevel: "off", toolNames: [],
      },
      sessionManager: manager, customTools: [],
      authority: { sessionId: id, rootSessionId: "wire-root", depth: 1, generation: "test", token: Symbol(id) },
    }));
  }
  const results = await Promise.all(drivers.map(driver => driver.prompt("offline fixture")));
  assert.deepEqual(results.map(result => result.stopReason), ["completed", "completed"], JSON.stringify(results));
  assert.equal(requests.length, 2);
  assert.deepEqual(new Set(requests.map(request => request.headers.get("session-id"))), new Set(["child-a", "child-b"]));
  assert.equal(new Set(requests.map(request => request.headers.get("x-codex-window-id"))).size, 2);
  for (const request of requests) {
    assert.equal(request.body.client_metadata.thread_id, request.headers.get("session-id"));
    assert.equal(request.body.prompt_cache_key, request.headers.get("session-id"));
    assert.notEqual(request.body.generate, false);
  }
  // The SDK summarizer uses the session stream function without sessionId.
  // Child binding must supply it rather than selecting Wire's parent fallback.
  for (const runtime of childRuntimes) {
    const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "offline summary fixture", timestamp: 2 }] }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
  assert.deepEqual(requests.slice(2).map(request => request.headers.get("session-id")), ["child-a", "child-b"]);
  const active = provider;
  provider = { ...provider }; // Unverified provider replacement fails closed.
  assert.throws(() => requireCodexWire("wire-root"), /without.*Codex Wire/);
  provider = active;
  events.get("session_shutdown")({}, ctx);
  assert.throws(() => requireCodexWire("wire-root"), /without.*Codex Wire/);
});

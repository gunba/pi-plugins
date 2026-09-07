import assert from "node:assert/strict";
import test from "node:test";
import { Protocol } from "../extensions/protocol.ts";
import { identity } from "./fixtures.mjs";
import { incrementalBody } from "../extensions/transport.ts";

test("identity modes preserve credentials and use native session/header projections", () => {
  const identity = { originator: "codex_cli_rs", userAgent: "codex_cli_rs/0.147.0 (Windows 10.0.26100; x86_64) WezTerm", version: "0.147.0" };
  for (const profile of ["pi", "codex"]) {
    const p = new Protocol(profile, "thread", "install", identity);
    const headers = p.headers(new Headers({ authorization: "Bearer secret", "chatgpt-account-id": "account", originator: "pi", "user-agent": "pi/0.84.3", "OpenAI-Beta": "responses=experimental" }));
    assert.equal(headers.get("authorization"), "Bearer secret");
    assert.equal(headers.get("chatgpt-account-id"), "account");
    assert.equal(headers.get("originator"), profile === "pi" ? "pi" : "codex_cli_rs");
    assert.equal(headers.get("user-agent"), profile === "pi" ? "pi/0.84.3" : identity.userAgent);
    assert.equal(headers.get("session-id"), p.sessionId);
    assert.equal(headers.get("thread-id"), "thread");
    assert.equal(headers.get("x-client-request-id"), "thread");
    assert.equal(headers.has("OpenAI-Beta"), false);
    assert.equal(headers.has("x-codex-installation-id"), false);
    const body = p.shapeBody({ model: "gpt-6-astra", input: [] });
    assert.equal(body.client_metadata["x-codex-installation-id"], "install");
    assert.equal(body.client_metadata.thread_id, "thread");
    assert.equal(body.prompt_cache_key, p.sessionId);
    assert.deepEqual(JSON.parse(body.client_metadata["x-codex-turn-metadata"]), JSON.parse(headers.get("x-codex-turn-metadata")));
  }
});

test("turn state uses first token, crosses tool rounds, never crosses user turns", () => {
  const p = new Protocol("codex", "thread", "install", identity);
  p.beginTurn();
  p.observeEvent({ type: "response.metadata", headers: { "X-Codex-Turn-State": "token1" } });
  p.observeHeaders(new Headers({ "x-codex-turn-state": "token2" }));
  assert.equal(p.headers(new Headers()).get("x-codex-turn-state"), "token1");
  assert.equal(p.websocketBody({}).client_metadata["x-codex-turn-state"], "token1");
  p.beginTurn();
  assert.equal(p.headers(new Headers()).has("x-codex-turn-state"), false);
  assert.equal(p.websocketBody({}).client_metadata["x-codex-turn-state"], undefined);
});

test("prewarm metadata describes setup rather than inference", () => {
  const p = new Protocol("codex", "thread", "install", identity);
  const frame = p.websocketBody({ ...p.shapeBody({ input: [] }), generate: false });
  assert.equal(JSON.parse(frame.client_metadata["x-codex-turn-metadata"]).request_kind, "prewarm");
  assert.equal(typeof frame.client_metadata["x-codex-ws-stream-request-start-ms"], "string");
});

test("root session/cache identity survives reactivation and resume; new or forked threads differ", () => {
  const initial = new Protocol("codex", "thread-1", "install", identity);
  const window = initial.getWindowId();
  for (const profile of ["pi", "codex"]) {
    const resumed = new Protocol(profile, "thread-1", "install", identity, window);
    assert.equal(resumed.sessionId, "thread-1");
    assert.equal(resumed.shapeBody({}).prompt_cache_key, initial.shapeBody({}).prompt_cache_key);
    assert.equal(resumed.headers(new Headers()).get("session-id"), "thread-1");
    assert.equal(resumed.getWindowId(), window);
    resumed.beginTurn(); resumed.rotateWindow();
    assert.equal(resumed.sessionId, "thread-1");
  }
  assert.notEqual(new Protocol("codex", "fork-2", "install", identity).sessionId, initial.sessionId);
  assert.notEqual(new Protocol("codex", "new-3", "install", identity).sessionId, initial.sessionId);
});

test("continuation ignores metadata but rejects changed model, tools or prefix", () => {
  const body = { model: "m", tools: [{ name: "a" }], input: [{ role: "user", content: "hello" }], client_metadata: { turn_id: "1" } };
  const output = [{ type: "function_call", name: "a", arguments: "{}", call_id: "c" }];
  const next = { ...body, client_metadata: { turn_id: "2" }, input: [...body.input, ...output, { type: "function_call_output", call_id: "c", output: "done" }] };
  const previous = { body, output, responseId: "resp_1" };
  assert.deepEqual(incrementalBody(next, previous).input, next.input.slice(2));
  assert.equal(incrementalBody(next, previous).previous_response_id, "resp_1");
  for (const changed of [{ ...next, model: "other" }, { ...next, tools: [] }, { ...next, input: [] }]) {
    assert.strictEqual(incrementalBody(changed, previous), changed);
  }
});

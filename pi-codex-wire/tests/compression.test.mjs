import assert from "node:assert/strict";
import test from "node:test";
import { requestCompression, requestRoutingHint } from "../extensions/compression.ts";

test("compression follows the feature, provider and Codex-auth/backend gates", () => {
  const url = "https://chatgpt.com/backend-api/codex/responses";
  const auth = new Headers({ authorization: "Bearer fake", "chatgpt-account-id": "account" });
  assert.equal(requestCompression(true, "openai-codex", url, auth), "zstd");
  assert.equal(requestCompression(false, "openai-codex", url, auth), "none");
  assert.equal(requestCompression(true, "openai", url, auth), "none");
  assert.equal(requestCompression(true, "openai-codex", "https://api.openai.com/v1/responses", auth), "none");
  assert.equal(requestCompression(true, "openai-codex", url, new Headers({ authorization: "Bearer api-key" })), "none");
  assert.equal(requestCompression(true, "openai-codex", url, new Headers({ "chatgpt-account-id": "account" })), "none");
  auth.set("originator", "pi");
  assert.equal(requestCompression(true, "openai-codex", url, auth), "zstd");
});

test("0.153.4 routing hint uses final model/tier with the Codex auth/backend gate", () => {
  const url = "https://chatgpt.com/backend-api/codex/responses";
  const auth = new Headers({ authorization: "Bearer fake", "chatgpt-account-id": "account" });
  assert.equal(requestRoutingHint("openai-codex", url, auth, "gpt-6-astra"), "model=gpt-6-astra");
  assert.equal(requestRoutingHint("openai-codex", url, auth, "gpt-6-astra", "priority"), "model=gpt-6-astra;tier=priority");
  assert.equal(requestRoutingHint("openai", url, auth, "test"), undefined);
  assert.equal(requestRoutingHint("openai-codex", "https://example.com/responses", auth, "test"), undefined);
  assert.equal(requestRoutingHint("openai-codex", url, new Headers(), "test"), undefined);
  assert.equal(requestRoutingHint("openai-codex", url, auth, "test\r\ninvalid"), undefined);
});

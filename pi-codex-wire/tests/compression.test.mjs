import assert from "node:assert/strict";
import test from "node:test";
import { requestCompression } from "../extensions/compression.ts";

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

import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../report.mjs";
import { allowanceHeaders, eventDiagnostics } from "../extensions/diagnostics.ts";

const rows = [
  { kind: "run", profile: "codex" },
  { kind: "allowance-mark", usedPercent: 10, resetId: "5h:1", time: "a" },
  { kind: "request", requestId: "warm", prewarm: true },
  { kind: "request", requestId: "r", model: "gpt-6-astra", effort: "medium", serviceTier: "omitted", transport: "websocket" },
  { kind: "response", usage: { input_tokens: 1000 } },
  { kind: "usage", requestId: "r", input: 20, cached: 980, output: 30, reasoning: 10, stopReason: "stop" },
  { kind: "allowance-mark", usedPercent: 10.25, resetId: "5h:1", time: "b" },
];
test("report counts model usage once and excludes prewarm", () => {
  const [result] = summarize(rows).intervals;
  assert.equal(result.usable, true);
  assert.equal(result.requests, 1);
  assert.equal(result.uncachedInput, 20);
  assert.equal(result.cachedInput, 980);
  assert.equal(result.allowancePercentagePoints, 0.25);
});
test("report rejects resets and missing coverage", () => {
  const reset = structuredClone(rows); reset.at(-1).resetId = "5h:2";
  assert.equal(summarize(reset).intervals[0].allowancePercentagePoints, null);
  assert.equal(summarize(rows.filter(row => row.kind !== "usage")).intervals[0].usable, false);
});
test("diagnostics allowlist excludes auth, prompt, account and error text", () => {
  assert.deepEqual(allowanceHeaders(new Headers({ authorization: "Bearer secret", "x-codex-primary-used-percent": "12.34", "x-codex-primary-window-minutes": "not-a-number" })), { "x-codex-primary-used-percent": 12.34 });
  const record = eventDiagnostics({ type: "response.failed", response: { error: "PRIVATE", output: ["PRIVATE"], service_tier: "PRIVATE", usage: { input_tokens: 12, secret: "PRIVATE" } } });
  assert.equal(JSON.stringify(record).includes("PRIVATE"), false);
});

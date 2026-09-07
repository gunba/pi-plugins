import assert from "node:assert/strict";
import test from "node:test";
import { allowanceFromEvent } from "../extensions/allowance.ts";

test("metadata and error events expose only allowance headers", () => {
  for (const type of ["response.metadata", "codex.response.metadata", "error"]) {
    assert.deepEqual(allowanceFromEvent({ type, headers: {
      "X-Codex-Secondary-Used-Percent": "95",
      "x-codex-turn-state": "PRIVATE TOKEN",
      authorization: "PRIVATE AUTH",
    } }), { "x-codex-secondary-used-percent": 95 });
  }
  assert.deepEqual(allowanceFromEvent({ type: "response.output_text.delta", delta: "PRIVATE TEXT" }), {});
});

test("malformed telemetry cannot inject headers or interrupt a response", () => {
  assert.deepEqual(allowanceFromEvent({
    type: "codex.rate_limits", plan_type: "pro\r\nsecret: value",
    rate_limits: { primary: { used_percent: "bad\r\nheader: value", reset_at: Infinity, window_minutes: "" } },
  }), {});
});

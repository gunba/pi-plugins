import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLedger } from "../ledger.mjs";
import requestTracing, { requestTrace } from "../extensions/request-trace.ts";
import { continuationReason } from "../extensions/transport.ts";

test("ledger joins child/prewarm usage, deduplicates responses and excludes decoder overlap", () => {
  const request = { kind: "request", requestId: "inference", attemptId: "attempt", sessionId: "child", rootSessionId: "root", callKind: "assistant", origin: "tool-continuation" };
  const response = { kind: "response", attemptId: "attempt", event: "response.completed",
    usage: { input_tokens: 100, cached_tokens: 90, output_tokens: 10, reasoning_tokens: 7 } };
  const result = summarizeLedger([
    request, response, { ...response, event: "response.done" },
    { kind: "usage", requestId: "inference", input: 10, cached: 90, output: 10 },
    { ...request, requestId: "prewarm", attemptId: "warm", prewarm: true, inferenceRequestId: "inference" },
    { ...response, attemptId: "warm", usage: { input_tokens: 100, output_tokens: 0 } },
  ]);
  assert.equal(result.attempts, 2);
  assert.equal(result.measuredAttempts, 2);
  assert.equal(result.groups.find(group => group.kind === "assistant").output, 10);
  assert.equal(result.groups.find(group => group.kind === "prewarm").uncachedInput, 100);
});

test("lifecycle trace distinguishes tool loops, custom wake-ups and compaction without prompt inspection", () => {
  const handlers = new Map();
  requestTracing({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = { sessionManager: { getSessionId: () => "trace-child" } };
  handlers.get("session_start")({}, ctx);
  handlers.get("input")({ source: "extension" }, ctx);
  const context = { messages: [{ role: "toolResult" }] };
  assert.equal(requestTrace("root", "trace-child", context).origin, "tool-continuation");
  handlers.get("message_start")({ message: { role: "custom", customType: "pi-subagents/notice" } }, ctx);
  const signal = new AbortController().signal;
  handlers.get("session_before_compact")({ signal }, ctx);
  assert.deepEqual(requestTrace("root", "trace-child", context, signal), {
    rootSessionId: "root", sessionId: "trace-child", callKind: "compaction", origin: "child-notice", triggerOrigin: "child-notice",
  });
  handlers.get("session_compact")({}, ctx);
  assert.equal(requestTrace("root", "trace-child", context).callKind, "assistant");
  handlers.get("session_shutdown")({}, ctx);
  assert.equal(requestTrace("root", "trace-child", { messages: [] }).origin, "unknown");
});

test("fresh summary routing IDs are matched by lifecycle signal, not the parent's active phase", () => {
  const handlers = new Map();
  requestTracing({ on: (name, fn) => handlers.set(name, fn) });
  const root = "trace-summary-root";
  const ctx = { sessionManager: { getSessionId: () => root } };
  const context = { messages: [{ role: "user", content: "Not inspected for classification." }] };
  const summary = new AbortController();
  const unrelated = new AbortController();
  handlers.get("session_start")({}, ctx);
  handlers.get("input")({ source: "interactive" }, ctx);
  handlers.get("session_before_compact")({ signal: summary.signal }, ctx);
  handlers.get("input")({ source: "extension" }, ctx);
  assert.deepEqual(requestTrace(root, "fresh-summary-id", context, summary.signal), {
    rootSessionId: root, sessionId: "fresh-summary-id", callKind: "compaction",
    origin: "interactive-input", triggerOrigin: "interactive-input",
  });
  assert.equal(requestTrace(root, root, context, unrelated.signal).callKind, "assistant");
  assert.equal(requestTrace(root, "child", context, unrelated.signal).callKind, "assistant");
  assert.equal(requestTrace("other-root", "child", context, summary.signal).callKind, "assistant");
  handlers.get("session_compact_failed")({}, ctx);
  assert.equal(requestTrace(root, "fresh-summary-id", context, summary.signal).callKind, "assistant");
  handlers.get("session_before_tree")({ signal: summary.signal, preparation: { userWantsSummary: true } }, ctx);
  assert.equal(requestTrace(root, "fresh-tree-id", context, summary.signal).callKind, "branch-summary");
  handlers.get("session_tree")({}, ctx);
  assert.equal(requestTrace(root, "fresh-tree-id", context, summary.signal).callKind, "assistant");
  handlers.get("session_before_tree")({ signal: summary.signal, preparation: { userWantsSummary: false } }, ctx);
  assert.equal(requestTrace(root, "fresh-tree-id", context, summary.signal).callKind, "assistant");
  handlers.get("session_before_compact")({ signal: summary.signal }, ctx);
  summary.abort();
  assert.equal(requestTrace(root, "fresh-summary-id", context, summary.signal).callKind, "assistant");
  handlers.get("session_shutdown")({}, ctx);
});

test("continuation diagnostics identify shape and history changes without logging payloads", () => {
  const body = { model: "fixture", input: [{ role: "user", content: "private" }] };
  const previous = { body, responseId: "r", output: [] };
  assert.equal(continuationReason(body), "no-previous-response");
  assert.equal(continuationReason(body, previous), "continuation");
  assert.equal(continuationReason({ ...body, model: "other" }, previous), "request-shape-changed");
  assert.equal(continuationReason({ ...body, input: [] }, previous), "history-changed");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseSession } = await createJiti(import.meta.url).import("../sources.ts");
const timestamp = "2026-10-05T00:00:00.000Z";
const header = { type: "session", version: 3, id: "synthetic-session", timestamp, cwd: "/synthetic/workspace" };
const message = (id, parentId, content, metadata = {}) => ({
  type: "message", id, parentId, timestamp,
  message: { role: "user", content, timestamp: Date.parse(timestamp), ...metadata },
});
const edit = (id, parentId, targetId, replacement) => ({ type: "context_edit", id, parentId, targetId, timestamp, replacement });
const parse = (...entries) => parseSession([header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n", "/synthetic/session.jsonl");

test("native context edits unwrap replacement.content strings", () => {
  const [trace] = parse(
    message("message1", null, "Original outcome."),
    edit("edit1", "message1", "message1", { content: "Verified outcome." }),
  );
  assert.deepEqual(trace.entries, [{ id: "message1", role: "user", content: "Verified outcome." }]);
});

test("native context edits unwrap replacement.content blocks without changing metadata", () => {
  const content = [{ type: "text", text: "Evaluator passed." }];
  const metadata = { role: "toolResult", toolName: "bash", toolCallId: "call1", isError: false };
  const [trace] = parse(
    message("message1", null, [{ type: "text", text: "Original result." }], metadata),
    edit("edit1", "message1", "message1", { content }),
  );
  assert.deepEqual(trace.entries, [{ id: "message1", ...metadata, content }]);
});

test("null context edits remove the target only on their branch, even after replacement", () => {
  const traces = parse(
    message("root", null, "Task."),
    message("target", "root", "Original outcome."),
    edit("replace", "target", "target", { content: "Revised outcome." }),
    edit("remove", "replace", "target", null),
    message("sibling", "target", "Alternative continuation."),
  );
  assert.deepEqual(traces.find(trace => trace.leafId === "remove").entries.map(entry => entry.id), ["root"]);
  assert.equal(traces.find(trace => trace.leafId === "sibling").entries.find(entry => entry.id === "target").content, "Original outcome.");
});

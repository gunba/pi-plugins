import assert from "node:assert/strict";
import test from "node:test";
import { NoticeBatcher, noticeBatch } from "../extensions/notice-batcher.ts";
import { NOTICE_ENTRY, undispatchedNotices } from "../extensions/subagent-runtime.ts";
const notice = (id, priority = "routine") => ({ messageId: id, kind: "report", childId: "child", content: `report ${id}`, priority });
test("nearby routine reports coalesce, urgent errors and action requests bypass delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = []; const batcher = new NoticeBatcher((batch) => sent.push(batch));
  batcher.add(notice("a")); batcher.add(notice("b")); batcher.add(notice("a"));
  assert.equal(sent.length, 0); t.mock.timers.tick(50);
  assert.deepEqual(sent[0].map((item) => item.messageId), ["a", "b"]);
  batcher.add(notice("c")); batcher.add(notice("d", "urgent"));
  assert.equal(sent.length, 2); assert.equal(sent[1].length, 2);
  batcher.add(notice("e", "action-required")); assert.equal(sent.length, 3);
  batcher.close(); t.mock.timers.tick(100); assert.equal(sent.length, 3);
});
test("dispatch failure retains pending notices without a polling retry loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let fail = true, calls = 0;
  const batcher = new NoticeBatcher(() => { calls++; if (fail) throw Error("failed"); });
  batcher.add(notice("a")); t.mock.timers.tick(5000); assert.equal(calls, 1); assert.equal(batcher.size, 1);
  fail = false; batcher.flush(); assert.equal(batcher.size, 0); assert.equal(calls, 2);
});
test("durable individual receipts recover through batching, compacted delivery IDs and selected branches", () => {
  const a = notice("a"), b = notice("b");
  const receipts = [a, b].map((data) => ({ type: "custom", customType: NOTICE_ENTRY, data }));
  assert.deepEqual(undispatchedNotices(receipts), [a, b]);
  const dispatched = { type: "custom_message", customType: "pi-subagents/notice", details: noticeBatch([a, b]) };
  assert.deepEqual(undispatchedNotices([...receipts, dispatched]), []);
  assert.deepEqual(undispatchedNotices([...receipts, { ...dispatched, details: { messageIds: ["a", "b"] } }]), []);
  assert.deepEqual(undispatchedNotices(receipts), [a, b], "delivery on another branch is not an ACK");
});

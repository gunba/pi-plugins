import assert from "node:assert/strict";
import test from "node:test";
import { WorkCoordinator } from "../core.ts";

const completed = { message: "Wait completed.", timed_out: false };
const interrupted = { message: "Wait interrupted by new input.", timed_out: false };

test("any admitted agent message releases a pending wait without starting work", async () => {
  const c = new WorkCoordinator("s");
  assert.equal(c.blocked, false);
  const waiting = c.wait(1000);
  assert.equal(c.waiting, true);
  c.notify(["interim-report"]);
  assert.deepEqual(await waiting, completed);
  assert.equal(c.blocked, false);
  assert.equal(c.hasUnread, true, "returning from wait does not consume the actual message");
});
test("mail arriving before wait admission is retained until its context is consumed", async () => {
  const c = new WorkCoordinator("s");
  c.notify(["report", "report", "result"]);
  assert.deepEqual(await c.wait(1000), completed);
  c.consume(["report"]);
  assert.equal(c.hasUnread, true);
  assert.deepEqual(await c.wait(1000), completed);
  c.consume(["result"]);
  const waiting = c.wait(1000);
  assert.equal(c.waiting, true);
  c.notify(["new"]);
  assert.deepEqual(await waiting, completed);
});
test("a context does not consume a message that arrived after its snapshot", async () => {
  const c = new WorkCoordinator("s");
  c.notify(["before-context"]);
  c.notify(["after-context"]);
  c.consume(["before-context"]);
  assert.deepEqual(await c.wait(1000), completed);
  c.consume(["after-context"]);
  assert.equal(c.hasUnread, false);
});
test("timeout returns without a cancellation or a later automatic wake", async () => {
  const c = new WorkCoordinator("s");
  assert.deepEqual(await c.wait(5), { message: "Wait timed out.", timed_out: true });
  assert.equal(c.blocked, false);
  c.notify(["later"]);
  assert.deepEqual(await c.wait(1000), completed);
});
test("abort, user input and shutdown release a pending tool", async () => {
  for (const reason of ["abort", "user-input", "shutdown"]) {
    const c = new WorkCoordinator("s"), abort = new AbortController();
    const waiting = c.wait(1000, abort.signal);
    if (reason === "abort") { abort.abort(); await assert.rejects(waiting, /abort/i); }
    else { if (reason === "shutdown") c.close(); else c.cancel(reason);
      assert.deepEqual(await waiting, interrupted); }
    assert.equal(c.blocked, false);
    if (reason === "shutdown") { c.notify(["late"]); assert.equal(c.hasUnread, false); await assert.rejects(c.wait(1), /closed/); }
  }
});
test("invalid or overlapping waits cannot replace the active waiter", async () => {
  const c = new WorkCoordinator("s");
  for (const timeout of [0, -1, 1.5, Infinity, 3_600_001]) await assert.rejects(c.wait(timeout), /timeout/i);
  const waiting = c.wait(1000);
  await assert.rejects(c.wait(1000), /already in progress/);
  c.notify(["result"]);
  assert.deepEqual(await waiting, completed);
});

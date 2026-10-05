import assert from "node:assert/strict";
import test from "node:test";
import { WorkCoordinator } from "../core.ts";

const child = { kind: "child", id: "a" };
const processTarget = { kind: "process", id: "p" };
function fixture() {
  const entries = [];
  return { entries, coordinator: new WorkCoordinator("s", entry => entries.push(entry)) };
}
test("a pending wait returns a selected completion without a separate wake", async () => {
  const { coordinator: c, entries } = fixture(); c.register(child); c.register(processTarget);
  assert.equal(c.blocked, false);
  await assert.rejects(c.wait([{ kind: "child", id: "foreign" }], "any", 1000), /session-owned/);
  assert.equal(entries.length, 0);
  const waiting = c.wait([child], "any", 1000);
  const original = JSON.stringify(entries[0]);
  assert.equal(c.complete(processTarget, "unrelated"), false); assert.equal(c.waiting, true);
  assert.equal(c.complete(child, "finished"), true); assert.equal(c.complete(child, "duplicate"), false);
  assert.deepEqual(await waiting, { completed: ["finished"], timed_out: false });
  assert.equal(c.blocked, false); assert.equal(JSON.stringify(entries[0]), original);
});
test("completed work returns immediately and all waits retain partial completion", async () => {
  const { coordinator: c } = fixture(); c.register(child); c.register(processTarget); c.complete(child, "done");
  assert.deepEqual(await c.wait([child], "any", 1000), { completed: ["done"], timed_out: false });
  const waiting = c.wait([child, processTarget], "all", 1000); assert.equal(c.waiting, true);
  c.complete(processTarget, "process done");
  assert.deepEqual(await waiting, { completed: ["done", "process done"], timed_out: false });
});
test("timeout returns without cancelling the underlying resource", async () => {
  const { coordinator: c } = fixture(); c.register(child);
  assert.deepEqual(await c.wait([child], "any", 5), { completed: [], timed_out: true });
  assert.equal(c.blocked, false); c.complete(child, "later");
  assert.deepEqual(await c.wait([child], "any", 1000), { completed: ["later"], timed_out: false });
});
test("abort, user input and shutdown release a pending tool", async () => {
  for (const reason of ["abort", "user-input", "shutdown"]) {
    const { coordinator: c } = fixture(), abort = new AbortController(); c.register(child);
    const waiting = c.wait([child], "any", 1000, abort.signal);
    if (reason === "abort") { abort.abort(); await assert.rejects(waiting, /abort/i); }
    else { if (reason === "shutdown") c.close(); else c.cancel(reason);
      assert.deepEqual(await waiting, { completed: [], timed_out: false, interrupted: true }); }
    assert.equal(c.blocked, false); assert.equal(c.complete(child, "late"), false);
  }
});
test("resource generation rejects stale completion of reused IDs", async () => {
  const { coordinator: c } = fixture(); c.register(child, true, "old"); c.complete(child, "old", { generation: "old" });
  c.register(child, true, "new"); const waiting = c.wait([child], "any", 1000);
  c.complete(child, "stale", { generation: "old" }); assert.equal(c.waiting, true);
  c.complete(child, "new", { generation: "new" }); assert.deepEqual((await waiting).completed, ["new"]);
});
test("an existing wait keeps its generation when later work starts", async () => {
  const { coordinator: c } = fixture(); c.register(child, true, "old"); const waiting = c.wait([child], "any", 1000);
  c.register(child, true, "new"); c.complete(child, "old", { generation: "old" });
  assert.deepEqual((await waiting).completed, ["old"]);
  assert.equal(c.begin([child]).waiting, true); c.cancel("fixture");
});
test("failed durable admission does not publish a wait or lose completion", () => {
  let fail = true; const c = new WorkCoordinator("s", () => { if (fail) throw Error("disk"); });
  c.register(child); assert.throws(() => c.begin([child]), /disk/); assert.equal(c.blocked, false);
  fail = false; c.begin([child]); fail = true;
  assert.throws(() => c.complete(child, "done"), /disk/); assert.equal(c.waiting, true);
  fail = false; assert.equal(c.complete(child, "done"), true); c.cancel("fixture");
});
test("external notice retries can detect a ready wait without dispatching another wake", () => {
  const { coordinator: c } = fixture(); c.register(child); c.begin([child]);
  assert.equal(c.complete(child, "done", { notify: false }), true);
  assert.equal(c.complete(child, "retry", { notify: false }), true);
  assert.equal(c.complete(child, "duplicate"), false); c.cancel("fixture");
});

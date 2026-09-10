import assert from "node:assert/strict";
import test from "node:test";
import { WorkCoordinator } from "../core.ts";

const child = { kind: "child", id: "a" };
const processTarget = { kind: "process", id: "p" };
function fixture() {
  const entries = [], wakes = [];
  return { entries, wakes, coordinator: new WorkCoordinator("s", (entry) => entries.push(structuredClone(entry)), (...event) => wakes.push(event)) };
}
test("registering resources does not wait; explicit any wait wakes once on a selected completion", async () => {
  const { coordinator: c, entries, wakes } = fixture();
  c.register(child); c.register(processTarget);
  assert.equal(c.blocked, false);
  assert.throws(() => c.begin([{ kind: "child", id: "foreign" }]), /session-owned/);
  assert.equal(entries.length, 0);
  c.begin([child]);
  assert.equal(c.complete(processTarget, "unrelated"), false);
  assert.equal(c.waiting, true);
  const resumed = c.untilReady();
  assert.equal(c.complete(child, "finished"), true);
  assert.equal(c.complete(child, "finished"), false);
  await resumed;
  assert.equal(wakes.length, 1);
  assert.equal(c.blocked, true, "goal remains blocked until wake reaches context");
  c.consume(); assert.equal(c.blocked, false);
});
test("completion before yield is immediate and all waits require every selected resource", () => {
  const { coordinator: c, wakes } = fixture();
  c.register(child); c.register(processTarget); c.complete(child, "done");
  assert.equal(c.begin([child]).waiting, false);
  assert.equal(c.begin([child, processTarget], "all").waiting, true);
  c.complete(processTarget, "process done");
  assert.equal(wakes.length, 1);
});
test("abort, cancellation, mixed-batch continuation and shutdown release listeners without a wake", async () => {
  for (const reason of ["abort", "cancel", "mixed", "shutdown"]) {
    const { coordinator: c, wakes } = fixture(); const abort = new AbortController();
    c.register(child); c.begin([child], "any", abort.signal); const released = c.untilReady();
    if (reason === "abort") abort.abort();
    else if (reason === "mixed") c.consume();
    else if (reason === "shutdown") c.close();
    else c.cancel("user-input");
    await released; c.complete(child, "late");
    assert.equal(wakes.length, 0, reason); assert.equal(c.blocked, false);
  }
});
test("resource generation rejects stale completion of reused IDs", () => {
  const { coordinator: c, wakes } = fixture();
  c.register(child, true, "old"); c.complete(child, "old", { generation: "old" });
  c.register(child, true, "new"); c.begin([child]);
  c.complete(child, "stale", { generation: "old" }); assert.equal(c.waiting, true);
  c.complete(child, "new", { generation: "new" }); assert.equal(wakes.length, 1);
});
test("an existing wait keeps its generation if a resource owner starts later work", () => {
  const { coordinator: c } = fixture();
  c.register(child, true, "old"); c.begin([child]); c.register(child, true, "new");
  c.complete(child, "old", { generation: "old" }); assert.equal(c.waiting, false);
  c.consume(); assert.equal(c.begin([child]).waiting, true);
});
test("failed durable admission does not publish a wait or lose completion", () => {
  let fail = true; const c = new WorkCoordinator("s", () => { if (fail) throw Error("disk"); }, () => {});
  c.register(child); assert.throws(() => c.begin([child]), /disk/); assert.equal(c.blocked, false);
  fail = false; c.begin([child]); fail = true;
  assert.throws(() => c.complete(child, "done"), /disk/); assert.equal(c.waiting, true);
  fail = false; assert.equal(c.complete(child, "done"), true);
});

test("failed wake delivery cannot resume a child or mark the event consumed", async () => {
  let fail = true, resumed = false;
  const c = new WorkCoordinator("s", () => {}, () => { if (fail) throw Error("delivery"); });
  c.register(child); c.begin([child]);
  const waiting = c.untilReady().then(() => { resumed = true; });
  assert.throws(() => c.complete(child, "done"), /delivery/);
  assert.throws(() => c.consume(), /delivery/);
  await Promise.resolve();
  assert.equal(resumed, false);
  assert.equal(c.blocked, true);
  let lateResumed = false;
  const late = c.untilReady().then(() => { lateResumed = true; });
  await Promise.resolve();
  assert.equal(lateResumed, false);
  fail = false; c.retryWake();
  await Promise.all([waiting, late]);
  assert.equal(resumed, true);
  assert.equal(lateResumed, true);
  c.consume(); assert.equal(c.blocked, false);
});

test("shutdown releases a child suspended by failed wake delivery", async () => {
  const c = new WorkCoordinator("s", () => {}, () => { throw Error("delivery"); });
  c.register(child); c.begin([child]);
  assert.throws(() => c.complete(child, "done"), /delivery/);
  const waiting = c.untilReady();
  c.close(false);
  await waiting;
  assert.equal(c.blocked, false);
});
test("external wake retries retain the ready gate without duplicate internally generated wakes", () => {
  const { coordinator: c, wakes } = fixture(); c.register(child); c.begin([child]);
  assert.equal(c.complete(child, "done", { notify: false }), true);
  assert.equal(c.complete(child, "retry", { notify: false }), true);
  assert.equal(c.complete(child, "duplicate"), false); assert.equal(wakes.length, 0);
});
test("persisted wait snapshots are immutable and failed wake dispatch retries at a checkpoint", () => {
  const entries = []; let fail = true, calls = 0;
  const c = new WorkCoordinator("s", (value) => entries.push(value), () => { calls++; if (fail) throw Error("queue unavailable"); });
  c.register(child); c.begin([child]); const original = JSON.stringify(entries[0]);
  assert.throws(() => c.complete(child, "done"), /queue unavailable/);
  assert.equal(JSON.stringify(entries[0]), original, "historic resident entries must not mutate after append");
  assert.equal(c.waiting, false); assert.equal(c.blocked, true);
  fail = false; c.retryWake(); c.retryWake(); assert.equal(calls, 2);
  c.consume(); assert.equal(c.blocked, false);
});

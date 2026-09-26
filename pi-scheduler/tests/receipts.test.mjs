import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryReceipts, SCHEDULED_MESSAGE_TYPE } from "../extensions/receipts.ts";
import { ScheduleStore } from "../extensions/store.ts";
import { DatabaseSync } from "node:sqlite";

const receipt = id => JSON.stringify({ type: "custom_message", customType: SCHEDULED_MESSAGE_TYPE, details: { id } }) + "\n";

test("new receipt scans read only appended bytes and wait for complete Unicode records", t => {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-receipts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "session.jsonl");
  fs.writeFileSync(file, (JSON.stringify({ type: "message", text: "x".repeat(4096) }) + "\n").repeat(256));
  const index = new DeliveryReceipts();
  assert.equal(index.read(file).size, 0);
  const originalRead = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args) => { const count = originalRead(...args); bytes += count; return count; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(index.read(file).size, 0);
  assert.equal(bytes, 0);
  const line = Buffer.from(receipt("timer-😀"));
  fs.appendFileSync(file, line.subarray(0, line.length - 1));
  assert.equal(index.read(file).size, 0);
  fs.appendFileSync(file, "\n");
  assert.deepEqual([...index.read(file)], ["timer-😀"]);
  assert.ok(bytes < 2048, `reread ${bytes} bytes instead of just the tail`);
  fs.appendFileSync(file, "{bad\n");
  assert.throws(() => index.read(file), SyntaxError);
  assert.throws(() => index.read(file), SyntaxError, "failed scans cannot cache a partial acknowledgement");
});

test("receipt indexes reset on replacement, truncation, and lifecycle rewrites", t => {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-receipts-rewrite-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "session.jsonl"), other = join(directory, "new.jsonl");
  const index = new DeliveryReceipts();
  fs.writeFileSync(file, receipt("first"));
  assert.deepEqual([...index.read(file)], ["first"]);
  fs.writeFileSync(other, receipt("replacement"));
  fs.renameSync(other, file);
  assert.deepEqual([...index.read(file)], ["replacement"]);
  fs.writeFileSync(file, "\n");
  assert.equal(index.read(file).size, 0);
  fs.writeFileSync(file, receipt("after-rewrite"));
  index.reset();
  assert.deepEqual([...index.read(file)], ["after-rewrite"]);
});

test("idle stores stay absent; repeated reads do not take a write lock", t => {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-scheduler-lazy-"));
  const data = join(directory, "data");
  const store = new ScheduleStore(data, "session");
  let blocker;
  t.after(() => { blocker?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.claimDue(0, new Set()), []);
  assert.equal(fs.existsSync(data), false);
  const message = { id: "timer", sessionId: "session", cwd: "/", createdAt: 0, dueAt: 0, message: "test", delivery: "steer" };
  store.add(message);
  blocker = new DatabaseSync(join(data, fs.readdirSync(data).find(name => name.endsWith(".sqlite"))));
  blocker.exec("BEGIN IMMEDIATE");
  assert.deepEqual(store.list(), [message]);
  blocker.exec("ROLLBACK");
  assert.equal(store.claimDue(1, new Set()).length, 1);
  store.close();
  assert.throws(() => store.list(), /closed/);
  const next = new ScheduleStore(data, "session");
  try { assert.equal(next.claimDue(1, new Set()).length, 1, "closing releases this owner's claims"); }
  finally { next.close(); }
});

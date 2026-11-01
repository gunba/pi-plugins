import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressComplete, progressParser } from "../../pi-ui/agent-progress.ts";
import { ProgressPipe } from "../src/host/progress-pipe.ts";

test("producer-owned text and JSONL fields drive progress without a library", () => {
	const parse = progressParser({ file: "pipe", pattern: "{done}/{total} {item}" });
	assert.deepEqual(parse("12/340 report.pdf\r"), { done: 12, total: 340, item: "report.pdf" });
	assert.equal(parse("noise"), undefined);
	assert.equal(parse("-1/340 report.pdf"), undefined);
	const json = progressParser({ file: "pipe", format: "jsonl", fields: { done: "processed", total: "count", item: "file", rate: "speed", eta: "left" } });
	assert.deepEqual(json('{"processed":12,"count":340,"file":"a","speed":4,"left":82}'), { done: 12, total: 340, item: "a", rate: 4, eta: 82 });
	assert.equal(json('{"processed":"12","count":340}'), undefined);
	assert.equal(json('{"processed":1e999,"count":340}'), undefined);
	assert.equal(json('{"processed":12'), undefined);
	assert.throws(() => progressParser({ file: "pipe", pattern: "{done}/{done}" }), /repeated/);
	assert.throws(() => progressParser({ file: "pipe", pattern: "{item}" }), /done/);
	assert.throws(() => progressParser({ file: "pipe", format: "jsonl", fields: { done: "__proto__", total: "count" } }), /safe/);
});

test("progress tailer waits for complete lines, preserves valid samples, follows rotation and closes", { timeout: 10000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-progress-")), file = join(root, "progress.txt"), updates = [];
	let next;
	const initial = new Promise(resolve => { next = resolve; });
	const pipe = new ProgressPipe({ file, pattern: "{done}/{total} {item}" }, (sample, status) => { updates.push({ sample, status }); next?.(); next = undefined; });
	t.after(async () => { pipe.close(); await rm(root, { recursive: true, force: true }); });
	await initial;
	assert.equal(updates.at(-1).status.state, "waiting");
	await writeFile(file, "1/3 first"); await pipe.poll();
	assert.equal(updates.at(-1).sample, undefined);
	await appendFile(file, "\n2/3 second\n"); await pipe.poll();
	assert.deepEqual(updates.at(-1).sample, { done: 2, total: 3, item: "second" });
	await appendFile(file, "invalid\n"); await pipe.poll();
	assert.equal(updates.at(-1).status.state, "invalid");
	assert.equal(updates.at(-1).sample.done, 2);
	await rename(file, `${file}.old`); await writeFile(file, "3/3 final\n"); await pipe.poll();
	assert.deepEqual(updates.at(-1).sample, { done: 3, total: 3, item: "final" });
	const count = updates.length;
	await appendFile(file, "4/4 stopped\n"); await pipe.poll();
	assert.equal(updates.length, count);
	assert.equal(pipe.stopped, true);
	assert.equal(updates.at(-1).status.state, "complete");
});

test("completion requires finite counts and includes overshoot and empty jobs", () => {
	assert.equal(progressComplete({ done: 3, total: 2 }), true);
	assert.equal(progressComplete({ done: 0, total: 0 }), true);
	assert.equal(progressComplete({ done: 1, total: 2 }), false);
	assert.equal(progressComplete({ done: "3", total: 2 }), false);
	assert.equal(progressComplete({ done: Infinity, total: 2 }), false);
	assert.equal(progressComplete({ done: 1, total: -1 }), false);
	assert.equal(progressComplete(undefined), false);
});

test("a completion line stops the pipe before a later run in the same read", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-progress-complete-")), file = join(root, "progress.txt"), updates = [];
	await writeFile(file, "3/2 finished\n0/5 next\n");
	const pipe = new ProgressPipe({ file, pattern: "{done}/{total} {item}" }, (sample, status) => updates.push({ sample, status }));
	t.after(async () => { pipe.close(); await rm(root, { recursive: true, force: true }); });
	await pipe.poll();
	assert.deepEqual(updates.at(-1).sample, { done: 3, total: 2, item: "finished" });
	assert.equal(updates.at(-1).status.state, "complete");
	assert.equal(pipe.stopped, true);
});

test("unchanged files back off, changes restore fast polling, and inactivity expires the pipe", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-progress-stale-")), file = join(root, "progress.txt"), updates = [];
	await writeFile(file, "1/5 first\n");
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const schedule = t.mock.method(globalThis, "setTimeout");
	const pipe = new ProgressPipe({ file, pattern: "{done}/{total} {item}" }, (sample, status) => updates.push({ sample, status }));
	t.after(async () => { pipe.close(); await rm(root, { recursive: true, force: true }); });
	await pipe.poll();
	assert.equal(schedule.mock.calls.at(-1).arguments[1], 500);
	t.mock.timers.tick(120_000); await pipe.poll();
	assert.equal(schedule.mock.calls.at(-1).arguments[1], 10_000);
	assert.equal(updates.at(-1).status.state, "stale");
	await appendFile(file, "2/5 second\n");
	t.mock.timers.tick(10_000); await pipe.poll();
	assert.deepEqual(updates.at(-1).sample, { done: 2, total: 5, item: "second" });
	assert.equal(schedule.mock.calls.at(-1).arguments[1], 500);
	t.mock.timers.tick(120_000); await pipe.poll();
	assert.equal(schedule.mock.calls.at(-1).arguments[1], 10_000);
	t.mock.timers.tick(1_680_000); await pipe.poll();
	assert.equal(pipe.stopped, true);
	assert.equal(updates.at(-1).sample.done, 2);
	assert.match(updates.at(-1).status.detail, /stopped after 30 minutes/);
	const calls = schedule.mock.callCount(), count = updates.length;
	await appendFile(file, "3/5 not polled\n");
	t.mock.timers.tick(60_000); await pipe.poll();
	assert.equal(schedule.mock.callCount(), calls);
	assert.equal(updates.length, count);
});

test("a file change at the expiry deadline keeps the watcher alive", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-progress-deadline-")), file = join(root, "progress"), updates = [];
	await writeFile(file, "1/3 first\n");
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const pipe = new ProgressPipe({ file, pattern: "{done}/{total} {item}" }, (sample, status) => updates.push({ sample, status }));
	t.after(async () => { pipe.close(); await rm(root, { recursive: true, force: true }); });
	await pipe.poll();
	t.mock.timers.tick(1_799_500); await pipe.poll();
	await appendFile(file, "2/3 resumed\n");
	t.mock.timers.tick(500); await pipe.poll();
	assert.equal(pipe.stopped, false);
	assert.deepEqual(updates.at(-1).sample, { done: 2, total: 3, item: "resumed" });
	assert.equal(updates.at(-1).status.state, "live");
});

test("a source that never appears also backs off and expires", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-progress-missing-")), updates = [];
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const schedule = t.mock.method(globalThis, "setTimeout");
	const pipe = new ProgressPipe({ file: join(root, "missing"), pattern: "{done}/{total}" }, (sample, status) => updates.push({ sample, status }));
	t.after(async () => { pipe.close(); await rm(root, { recursive: true, force: true }); });
	await pipe.poll();
	assert.equal(updates.at(-1).status.state, "waiting");
	t.mock.timers.tick(120_000); await pipe.poll();
	assert.equal(schedule.mock.calls.at(-1).arguments[1], 10_000);
	t.mock.timers.tick(1_680_000); await pipe.poll();
	assert.equal(pipe.stopped, true);
	assert.equal(updates.at(-1).sample, undefined);
	assert.match(updates.at(-1).status.detail, /stopped after 30 minutes/);
});

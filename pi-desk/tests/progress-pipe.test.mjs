import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressParser } from "../../pi-ui/agent-progress.ts";
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
	pipe.close(); const count = updates.length;
	await appendFile(file, "4/4 stopped\n"); await pipe.poll();
	assert.equal(updates.length, count);
});

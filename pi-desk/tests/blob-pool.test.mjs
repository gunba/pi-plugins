import assert from "node:assert/strict";
import test from "node:test";
import { BlobPool } from "../src/client/blob-pool.ts";

test("repeated opens share one blob and release it only after the last consumer leaves", async () => {
	const pool = new BlobPool();
	let requests = 0;
	const load = async () => { requests++; return new Blob(["output"]); };
	const first = pool.acquire("output", load), second = pool.acquire("output", load);
	const [one, two] = await Promise.all([first.loaded, second.loaded]);
	assert.equal(requests, 1); assert.equal(one, two);
	first.release(); first.release();
	assert.equal(await (await fetch(two)).text(), "output");
	second.release();
	await assert.rejects(fetch(two));
});

test("closed queued previews do not start and simultaneous blob transfers stay bounded", async () => {
	const pool = new BlobPool(1);
	let finish;
	const first = pool.acquire("first", () => new Promise(resolve => { finish = resolve; }));
	const closed = pool.acquire("closed", () => { throw Error("Closed preview started"); });
	const rejected = assert.rejects(closed.loaded, /Preview closed/);
	closed.release();
	let nextStarted = false;
	const next = pool.acquire("next", async () => { nextStarted = true; return new Blob(["next"]); });
	assert.equal(nextStarted, false);
	finish(new Blob(["first"]));
	await Promise.all([first.loaded, next.loaded, rejected]);
	first.release(); next.release();
});

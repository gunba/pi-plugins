import assert from "node:assert/strict";
import test from "node:test";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { createHarness, FakeDriverFactory, blockingPrompt, deferred, waitUntil } from "./helpers.mjs";

test("child files reject another owner while active, settled and recovered", async () => {
	const first = createHarness({ factory: new FakeDriverFactory(blockingPrompt) });
	let second;
	try {
		const started = await first.runtime.start({ description: "Lease", prompt: "hold", context: "fresh", runInBackground: true, parent: first.parent() });
		const file = first.runtime.getSessionFile(started.subagentId);
		assert.throws(() => new SessionLease(file), /already open/);
		await waitUntil(() => first.factory.opens[0]?.isRunning);
		first.runtime.interrupt(first.runtime.rootAuthority, started.subagentId);
		await waitUntil(() => first.factory.opens[0]?.disposed);
		assert.throws(() => new SessionLease(file), /already open/);
		await first.runtime.shutdown();
		new SessionLease(file).close();
		second = createHarness({ root: first.root, rootManager: first.rootManager });
		assert.ok(second.runtime.getSessionFile(started.subagentId));
		assert.throws(() => new SessionLease(file), /already open/);
		await second.runtime.shutdown();
		new SessionLease(file).close();
	} finally { await second?.cleanup(); await first.cleanup(); }
});

test("shutdown retains ownership until a cancelled late driver finishes disposal", async () => {
	const opened = deferred();
	let entered = false, disposed = false;
	const harness = createHarness({ factory: { open: () => { entered = true; return opened.promise; } } });
	try {
		const started = await harness.runtime.start({ description: "Late", prompt: "hold", context: "fresh", runInBackground: true, parent: harness.parent() });
		const file = harness.runtime.getSessionFile(started.subagentId);
		await waitUntil(() => entered);
		await harness.runtime.shutdown();
		assert.throws(() => new SessionLease(file), /already open/);
		opened.resolve({ dispose: async () => { disposed = true; } });
		await waitUntil(() => {
			if (!disposed) return false;
			try { new SessionLease(file).close(); return true; } catch { return false; }
		});
	} finally { await harness.cleanup(); }
});

test("a follow-up waits for late opening cleanup and that opening retains admission capacity", async () => {
	const opened = deferred(), cleanup = deferred();
	const completed = new FakeDriverFactory();
	let calls = 0, disposing = false;
	const harness = createHarness({ openTimeoutMs: 15, maxActive: 1, factory: { open(input) {
		calls++;
		return calls === 1 ? opened.promise : completed.open(input);
	} } });
	try {
		const first = await harness.runtime.start({ description: "Late", prompt: "first", context: "fresh", runInBackground: true, parent: harness.parent() });
		await waitUntil(() => harness.runtime.snapshot().some(child => child.state === "error"));
		harness.runtime.followupTask(harness.runtime.rootAuthority, first.subagentId, "follow-up");
		await assert.rejects(harness.runtime.start({ description: "Other", prompt: "other", context: "fresh", runInBackground: true, parent: harness.parent() }), /root-wide subagent limit/);
		assert.equal(calls, 1);
		opened.resolve({ dispose: async () => { disposing = true; await cleanup.promise; } });
		await waitUntil(() => disposing);
		assert.equal(calls, 1);
		cleanup.resolve();
		await waitUntil(() => completed.promptLog.some(item => item.message === "follow-up"));
		assert.equal(calls, 2);
	} finally { cleanup.resolve(); await harness.cleanup(); }
});

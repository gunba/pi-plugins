import assert from "node:assert/strict";
import test from "node:test";
import {
	blockingPrompt,
	childParent,
	completedOutcome,
	createHarness,
	deferred,
	FakeDriverFactory,
	waitUntil,
} from "./helpers.mjs";

test("background continuable start returns at acceptance and does not block parent work", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const harness = createHarness({ factory });
	try {
		const started = await harness.runtime.start({
			description: "inspect runtime state",
			prompt: "work independently",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		assert.equal(started.kind, "continuable");
		assert.equal(typeof started.subagentId, "string");
		assert.equal(typeof started.messageId, "string");
		const visible = harness.runtime.listAgents(harness.runtime.rootAuthority);
		assert.equal(visible[0].id, started.subagentId);
		assert.equal(visible[0].label, "inspect runtime state");
		assert.ok(
			["ready", "idle", "running"].includes(visible[0].status),
			"the parent can continue while activation starts",
		);
		await waitUntil(() => factory.opens[0]?.prompts.length === 1, "child prompt");
		assert.equal(harness.runtime.snapshot()[0].state, "running");
		factory.opens[0].pending.resolve(completedOutcome("result"));
		await waitUntil(() => harness.notices.some((notice) => notice.kind === "settlement"), "settlement notice");
		assert.match(harness.notices.at(-1).content, /Final assistant message:\nresult/);
		assert.equal(harness.runtime.listAgents(harness.runtime.rootAuthority)[0].status, "ready");
	} finally {
		await harness.cleanup();
	}
});

test("send_message queues strict FIFO later turns and returns no child answer", async () => {
	let first = true;
	const factory = new FakeDriverFactory((driver, message) => {
		if (first) {
			first = false;
			return blockingPrompt(driver);
		}
		return Promise.resolve(completedOutcome(`answer: ${message}`));
	});
	const harness = createHarness({ factory });
	try {
		const started = await harness.runtime.start({
			description: "process queued turns",
			prompt: "first",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => factory.promptLog.length === 1, "first prompt");
		const second = harness.runtime.sendMessage(
			harness.runtime.rootAuthority,
			started.subagentId,
			"second",
		);
		const third = harness.runtime.sendMessage(
			harness.runtime.rootAuthority,
			started.subagentId,
			"third",
		);
		assert.equal(typeof second, "string");
		assert.equal(typeof third, "string");
		assert.deepEqual(factory.promptLog.map((entry) => entry.message), ["first"]);
		factory.opens[0].pending.resolve(completedOutcome("first answer"));
		await waitUntil(() => factory.promptLog.length === 3, "queued turns");
		assert.deepEqual(factory.promptLog.map((entry) => entry.message), [
			"first",
			"second",
			"third",
		]);
	} finally {
		await harness.cleanup();
	}
});

test("interrupt affects only the current turn and parks queued work until a later send", async () => {
	let first = true;
	const factory = new FakeDriverFactory((driver, message) => {
		if (first) {
			first = false;
			return blockingPrompt(driver);
		}
		return Promise.resolve(completedOutcome(message));
	});
	const harness = createHarness({ factory });
	try {
		const started = await harness.runtime.start({
			description: "interrupt current work",
			prompt: "current",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => factory.promptLog.length === 1, "current prompt");
		harness.runtime.sendMessage(harness.runtime.rootAuthority, started.subagentId, "parked");
		assert.equal(
			harness.runtime.interrupt(harness.runtime.rootAuthority, started.subagentId),
			true,
		);
		await waitUntil(() => harness.runtime.snapshot()[0]?.state === "aborted", "aborted turn");
		assert.deepEqual(factory.promptLog.map((entry) => entry.message), ["current"]);
		assert.equal(factory.opens[0].interruptions, 1);
		harness.runtime.sendMessage(harness.runtime.rootAuthority, started.subagentId, "wake");
		await waitUntil(() => factory.promptLog.length === 3, "parked queue wake");
		assert.deepEqual(factory.promptLog.map((entry) => entry.message), [
			"current",
			"parked",
			"wake",
		]);
	} finally {
		await harness.cleanup();
	}
});

test("foreground delegation returns the selected result and is not continuable", async () => {
	const harness = createHarness();
	try {
		const result = await harness.runtime.start({
			description: "return required result",
			prompt: "foreground",
			context: "fresh",
			runInBackground: false,
			parent: harness.parent(),
		});
		assert.deepEqual(result, {
			kind: "foreground",
			runId: result.runId,
			outcome: completedOutcome("done: foreground"),
		});
		assert.deepEqual(harness.runtime.listAgents(harness.runtime.rootAuthority), []);
		assert.throws(
			() => harness.runtime.sendMessage(harness.runtime.rootAuthority, result.runId, "again"),
			/not resumable/,
		);
		assert.deepEqual(harness.notices, [], "foreground result is not duplicated as a notice");
	} finally {
		await harness.cleanup();
	}
});

test("direct-parent follow-up, ancestor interrupt, exact handles, and child-scoped report are enforced", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const harness = createHarness({ factory });
	try {
		const child = await harness.runtime.start({
			description: "own nested worker",
			prompt: "hold",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => factory.opens.length === 1, "child activation");
		const childAuthority = factory.opens[0].input.authority;
		const grandchild = await harness.runtime.start({
			description: "nested durable worker",
			prompt: "nested hold",
			context: "fresh",
			runInBackground: true,
			parent: childParent(harness, child.subagentId, childAuthority),
		});
		await waitUntil(() => factory.opens.length === 2, "grandchild activation");
		assert.deepEqual(
			harness.runtime
				.listAgents(harness.runtime.rootAuthority, "descendants")
				.map((entry) =>
					entry.kind === "child"
						? [entry.id, entry.parent, entry.depth]
						: [entry.id, entry.parent, entry.depth],
				),
			[
				[child.subagentId, harness.runtime.rootAuthority.sessionId, 1],
				[grandchild.subagentId, child.subagentId, 2],
			],
		);

		assert.throws(
			() => harness.runtime.sendMessage(harness.runtime.rootAuthority, grandchild.subagentId, "wrong owner"),
			/direct parent/,
		);
		assert.equal(
			typeof harness.runtime.sendMessage(childAuthority, grandchild.subagentId, "right owner"),
			"string",
		);
		assert.equal(
			harness.runtime.interrupt(harness.runtime.rootAuthority, grandchild.subagentId),
			true,
			"a live ancestor may interrupt a deeper descendant",
		);
		assert.throws(
			() => harness.runtime.interrupt(childAuthority, child.subagentId),
			/cannot interrupt itself/,
		);
		assert.throws(
			() => harness.runtime.listAgents({ ...harness.runtime.rootAuthority }),
			/exact live agent authority/,
		);

		const reportId = harness.runtime.report(childAuthority, "use the shared result");
		assert.equal(typeof reportId, "string");
		assert.match(harness.notices.at(-1).content, /use the shared result/);
		assert.equal(factory.opens[0].isRunning, true, "report does not end the child turn");
		assert.throws(
			() => harness.runtime.report(harness.runtime.rootAuthority, "not a child"),
			/live continuable child/,
		);
	} finally {
		await harness.cleanup();
	}
});

test("default bounded depth permits depth 3 and rejects depth 4", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const harness = createHarness({ factory });
	try {
		assert.equal(harness.runtime.maxDepth, 3);
		let parent = harness.parent();
		let latest;
		for (let depth = 1; depth <= 3; depth++) {
			latest = await harness.runtime.start({
				description: `depth ${depth} worker`,
				prompt: `hold ${depth}`,
				context: "fresh",
				runInBackground: true,
				parent,
			});
			await waitUntil(() => factory.opens.length === depth, `depth ${depth} activation`);
			parent = childParent(
				harness,
				latest.subagentId,
				factory.opens[depth - 1].input.authority,
			);
		}
		await assert.rejects(
			harness.runtime.start({
				description: "depth four worker",
				prompt: "must fail",
				context: "fresh",
				runInBackground: true,
				parent,
			}),
			/depth limit 3/,
		);
	} finally {
		await harness.cleanup();
	}
});

test("pre-aborted foreground starts create no durable child or launch", async () => {
	const harness = createHarness();
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			harness.runtime.start({
				description: "must not start",
				prompt: "never admitted",
				context: "fresh",
				runInBackground: false,
				parent: harness.parent(),
				signal: controller.signal,
			}),
			(error) => error?.name === "AbortError",
		);
		assert.deepEqual(harness.runtime.snapshot(), []);
		assert.deepEqual(harness.launches, new Set());
	} finally {
		await harness.cleanup();
	}
});

test("shutdown disposes a driver that finishes opening after shutdown begins", async () => {
	const opening = deferred();
	const driver = {
		isRunning: false,
		prompts: [],
		async prompt(message) {
			this.prompts.push(message);
			return completedOutcome(message);
		},
		interrupt() {},
		dispose() {
			this.disposed = true;
		},
	};
	const factory = {
		opens: 0,
		async open() {
			this.opens++;
			await opening.promise;
			return driver;
		},
	};
	const harness = createHarness({ factory });
	try {
		await harness.runtime.start({
			description: "open during shutdown",
			prompt: "do not leak",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => factory.opens === 1, "driver opening");
		const shutdown = harness.runtime.shutdown();
		opening.resolve();
		await shutdown;
		assert.equal(driver.disposed, true);
		assert.deepEqual(driver.prompts, []);
	} finally {
		await harness.cleanup();
	}
});

test("one activation failure terminates every already-accepted message without stranding the queue", async () => {
	const opening = deferred();
	const factory = {
		opens: 0,
		async open() {
			this.opens++;
			return opening.promise;
		},
	};
	const harness = createHarness({ factory });
	try {
		const started = await harness.runtime.start({
			description: "fail activation",
			prompt: "first",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		harness.runtime.sendMessage(harness.runtime.rootAuthority, started.subagentId, "second");
		opening.reject(new Error("model unavailable"));
		await waitUntil(
			() => harness.notices.some((notice) => notice.kind === "settlement"),
			"failed settlement",
		);
		assert.equal(factory.opens, 1);
		assert.equal(harness.runtime.snapshot()[0].state, "error");
		assert.match(harness.notices.at(-1).content, /model unavailable|settled with error/);
	} finally {
		await harness.cleanup();
	}
});

test("a one-shot parent activation is released after its background child settles", async () => {
	let harness;
	const factory = new FakeDriverFactory(async (driver, message) => {
		if (driver.input.descriptor.depth === 1 && message === "parent") {
			await harness.runtime.start({
				description: "nested background work",
				prompt: "nested",
				context: "fresh",
				runInBackground: true,
				parent: childParent(
					harness,
					driver.input.descriptor.childSessionId,
					driver.input.authority,
				),
			});
			return completedOutcome(`parent: ${message}`);
		}
		if (driver.input.descriptor.depth === 1)
			return completedOutcome(`parent received: ${message}`);
		return blockingPrompt(driver);
	});
	harness = createHarness({ factory });
	try {
		const result = await harness.runtime.start({
			description: "foreground parent",
			prompt: "parent",
			context: "fresh",
			runInBackground: false,
			parent: harness.parent(),
		});
		assert.equal(result.kind, "foreground");
		await waitUntil(() => factory.opens.length === 2, "nested child activation");
		assert.equal(factory.opens[0].disposed, undefined, "parent waits for its descendant");
		harness.runtime.report(factory.opens[1].input.authority, "nested accepted report");
		await waitUntil(
			() => factory.opens[0].prompts.some((prompt) => /nested accepted report/.test(prompt)),
			"nested report delivery to one-shot parent",
		);
		factory.opens[1].pending.resolve(completedOutcome("nested done"));
		await waitUntil(
			() => factory.opens[0].prompts.some((prompt) => /nested done/.test(prompt)),
			"nested settlement delivery to one-shot parent",
		);
		await waitUntil(() => factory.opens[0].disposed === true, "one-shot parent release");
	} finally {
		await harness.cleanup();
	}
});

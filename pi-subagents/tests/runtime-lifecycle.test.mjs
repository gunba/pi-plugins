import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { undispatchedNotices } from "../extensions/subagent-runtime.ts";
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
			taskName: "runtime_check",
			description: "inspect runtime state",
			prompt: "work independently",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		assert.equal(started.kind, "continuable");
		assert.equal(typeof started.subagentId, "string");
		assert.equal(typeof started.messageId, "string");
		assert.equal(harness.runtime.agentPath(started.subagentId), "/root/runtime_check");
		for (const target of ["runtime_check", "/root/runtime_check", started.subagentId])
			assert.equal(harness.runtime.resolveTarget(harness.runtime.rootAuthority, target), started.subagentId);
		assert.equal(harness.runtime.resolveTarget(harness.runtime.rootAuthority, "/root"), harness.rootManager.getSessionId());
		assert.throws(() => harness.runtime.resolveTarget(harness.runtime.rootAuthority, "../outside"), /task_name/);
		assert.throws(() => harness.runtime.resolveTarget(harness.runtime.rootAuthority, "unknown"), /Unknown/);
		await assert.rejects(harness.runtime.start({ taskName: "runtime_check", description: "duplicate", prompt: "unused", context: "fresh", runInBackground: true, parent: harness.parent() }), /already exists/);
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

test("follow-up during shutdown waits for disposal without replacing the previous turn result", async () => {
	const gate = deferred(); let disposing = false;
	const factory = new FakeDriverFactory();
	const open = factory.open.bind(factory);
	factory.open = async (input) => {
		const driver = await open(input);
		if (factory.opens.length === 1) driver.dispose = async () => { disposing = true; await gate.promise; driver.disposed = true; };
		return driver;
	};
	const h = createHarness({ factory });
	try {
		const child = await h.runtime.start({ description: "first", prompt: "first", context: "fresh", runInBackground: true, parent: h.parent() });
		await waitUntil(() => disposing);
		h.runtime.followupTask(h.runtime.rootAuthority, child.subagentId, "second");
		assert.equal(factory.opens.length, 1); assert.equal(h.notices.length, 0);
		gate.resolve();
		await waitUntil(() => factory.promptLog.length === 2 && h.notices.length === 2);
		assert.equal(factory.opens[0].disposed, true);
		assert.deepEqual(factory.opens[0].prompts, ["first"]);
		assert.deepEqual(factory.opens[1].prompts, ["second"]);
		assert.equal(h.notices.filter((notice) => notice.kind === "settlement").length, 2);
		assert.match(h.notices[0].content, /done: first/);
		assert.match(h.notices[1].content, /done: second/);
		assert.notEqual(h.notices[0].workId, h.notices[1].workId);
	} finally { gate.resolve(); await h.cleanup(); }
});

test("follow-ups not consumed at a driver boundary remain FIFO and return no child answer", async () => {
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
		const second = harness.runtime.followupTask(
			harness.runtime.rootAuthority,
			started.subagentId,
			"second",
		);
		const third = harness.runtime.followupTask(
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
		harness.runtime.followupTask(harness.runtime.rootAuthority, started.subagentId, "parked");
		assert.equal(
			harness.runtime.interrupt(harness.runtime.rootAuthority, started.subagentId),
			true,
		);
		await waitUntil(() => harness.runtime.snapshot()[0]?.state === "aborted", "aborted turn");
		assert.deepEqual(factory.promptLog.map((entry) => entry.message), ["current"]);
		assert.equal(factory.opens[0].interruptions, 1);
		harness.runtime.followupTask(harness.runtime.rootAuthority, started.subagentId, "wake");
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
			() => harness.runtime.followupTask(harness.runtime.rootAuthority, result.runId, "again"),
			/not resumable/,
		);
		assert.deepEqual(harness.notices, [], "foreground result is not duplicated as a notice");
	} finally {
		await harness.cleanup();
	}
});

test("tree follow-up, messaging and interruption use exact live handles", async () => {
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
		await waitUntil(() => factory.opens[0]?.isRunning, "child activation");
		const childAuthority = factory.opens[0].input.authority;
		const grandchild = await harness.runtime.start({
			description: "nested durable worker",
			prompt: "nested hold",
			context: "fresh",
			runInBackground: true,
			parent: childParent(harness, child.subagentId, childAuthority),
		});
		await waitUntil(() => factory.opens[1]?.isRunning, "grandchild activation");
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

		assert.equal(typeof harness.runtime.followupTask(harness.runtime.rootAuthority, grandchild.subagentId, "tree follow-up"), "string");
		assert.throws(() => harness.runtime.followupTask(childAuthority, "/root", "unsupported root turn"), /cannot target the root/);
		assert.equal(
			typeof harness.runtime.followupTask(childAuthority, grandchild.subagentId, "right owner"),
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

		const reportId = harness.runtime.sendMessage(childAuthority, "/root", "use the shared result");
		assert.equal(typeof reportId, "string");
		assert.match(harness.notices.at(-1).content, /use the shared result/);
		assert.equal(factory.opens[0].isRunning, true, "a message does not end the child turn");
		assert.throws(() => harness.runtime.interrupt(childAuthority, harness.rootManager.getSessionId()), /cannot interrupt the root/);
		assert.throws(() => harness.runtime.interrupt(childAuthority, "missing-agent"), /Unknown/);
		assert.deepEqual(harness.runtime.listNamedAgents(childAuthority).map(agent => agent.agent_id),
			[harness.rootManager.getSessionId(), child.subagentId, grandchild.subagentId]);
		assert.deepEqual(harness.runtime.listNamedAgents(childAuthority, harness.runtime.agentPath(grandchild.subagentId)).map(agent => agent.agent_id), [grandchild.subagentId]);
		const sibling = await harness.runtime.start({ taskName: "sibling", description: "sibling", prompt: "hold", context: "fresh", runInBackground: true, parent: harness.parent() });
		await waitUntil(() => factory.opens[2]?.isRunning, "sibling activation");
		harness.runtime.sendMessage(childAuthority, "/root/sibling", "lateral update");
		assert.match(factory.opens[2].notices[0].content, /lateral update/);
		assert.equal(factory.opens[2].prompts.length, 1);
		assert.equal(harness.runtime.interrupt(childAuthority, sibling.subagentId), true, "registered siblings can interrupt one another");
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
		harness.runtime.followupTask(harness.runtime.rootAuthority, started.subagentId, "second");
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

for (const background of [true, false]) test(`${background ? "continuable" : "one-shot"} parent finishes independently of its background child`, async () => {
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
			description: "parent",
			prompt: "parent",
			context: "fresh",
			runInBackground: background,
			parent: harness.parent(),
		});
		assert.equal(result.kind, background ? "continuable" : "foreground");
		await waitUntil(() => factory.opens.length === 2, "nested child activation");
		await waitUntil(() => factory.opens[0].disposed === true, "parent release before descendant completion");
		assert.equal(factory.opens[1].isRunning, true);
		assert.equal(harness.runtime.hasLiveDescendants(harness.runtime.rootAuthority), true);
		if (background) assert.match(harness.notices[0].content, /parent: parent/);
		const parentId = factory.opens[0].input.descriptor.childSessionId;
		const inbox = () => undispatchedNotices(SessionManager.open(harness.runtime.getSessionFile(parentId)).getBranch());
		harness.runtime.sendMessage(factory.opens[1].input.authority, parentId, "nested accepted report");
		assert.ok(inbox().some(notice => /nested accepted report/.test(notice.content)));
		factory.opens[1].pending.resolve(completedOutcome("nested done"));
		await waitUntil(() => inbox().some(notice => /nested done/.test(notice.content)), "cold parent result receipt");
		assert.equal(factory.opens.length, 2, "child results do not reopen the parent");
		assert.deepEqual(factory.opens[0].prompts, ["parent"], "notices must not manufacture parent tasks");
	} finally {
		await harness.cleanup();
	}
});

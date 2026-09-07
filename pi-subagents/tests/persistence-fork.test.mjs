import { usageFor } from "./helpers.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	DESCRIPTOR_ENTRY,
	DELIVERY_ENTRY,
	INBOX_ENTRY,
	LAUNCH_ENTRY,
	SETTLEMENT_ENTRY,
	copyCompletedParentTurns,
	createDurableChildSession,
} from "../extensions/subagent-runtime.ts";
import {
	blockingPrompt,
	completedOutcome,
	createHarness,
	FakeDriverFactory,
	waitUntil,
} from "./helpers.mjs";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text) {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "model",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

test("fork copies only completed parent turns and captures the seed once", async () => {
	const factory = new FakeDriverFactory(async () => completedOutcome("fork done"));
	const harness = createHarness({ factory });
	try {
		harness.rootManager.appendMessage(user("completed question"));
		const completedId = harness.rootManager.appendMessage(
			assistant([{ type: "text", text: "completed answer" }]),
		);
		harness.rootManager.appendMessage(user("current question"));
		harness.rootManager.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "fork-call",
						name: "subagent_fork",
						arguments: { description: "review completed context", prompt: "review" },
					},
				],
				"toolUse",
			),
		);

		const started = await harness.runtime.start({
			description: "review completed context",
			prompt: "review",
			context: "fork",
			runInBackground: true,
			parent: harness.parent({ toolCallId: "fork-call" }),
		});
		await waitUntil(() => factory.opens.length === 1, "fork activation");
		const childManager = SessionManager.open(
			harness.runtime.getSessionFile(started.subagentId),
			harness.childSessions,
		);
		const copiedMessages = childManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		assert.deepEqual(copiedMessages.map((message) => message.role), ["user", "assistant"]);
		assert.equal(copiedMessages[0].content, "completed question");
		assert.equal(copiedMessages[1].content[0].text, "completed answer");
		const descriptor = childManager
			.getEntries()
			.find(
				(entry) => entry.type === "custom" && entry.customType === DESCRIPTOR_ENTRY,
			).data;
		assert.equal(descriptor.forkBoundaryEntryId, completedId);

		harness.rootManager.appendMessage(user("newer parent turn"));
		harness.rootManager.appendMessage(assistant([{ type: "text", text: "newer answer" }]));
		assert.equal(
			childManager.getBranch().filter((entry) => entry.type === "message").length,
			2,
			"later parent history is never reforked",
		);
	} finally {
		await harness.cleanup();
	}
});

test("fork excludes the complete current user and tool-call loop", async () => {
	const harness = createHarness();
	try {
		harness.rootManager.appendMessage(user("completed question"));
		harness.rootManager.appendMessage(assistant([{ type: "text", text: "completed answer" }]));
		harness.rootManager.appendMessage(user("current private request"));
		harness.rootManager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "secret" } }],
				"toolUse",
			),
		);
		harness.rootManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "current private tool output" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
		harness.rootManager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "delegate-call", name: "subagent_fork", arguments: {} }],
				"toolUse",
			),
		);

		const started = await harness.runtime.start({
			description: "exclude current loop",
			prompt: "review completed work",
			context: "fork",
			runInBackground: true,
			parent: harness.parent({ toolCallId: "delegate-call" }),
		});
		await waitUntil(() => harness.factory.opens.length === 1, "fork activation");
		const child = SessionManager.open(
			harness.runtime.getSessionFile(started.subagentId),
			harness.childSessions,
		);
		const rendered = JSON.stringify(child.buildSessionContext().messages);
		assert.match(rendered, /completed question/);
		assert.match(rendered, /completed answer/);
		assert.doesNotMatch(rendered, /current private request|current private tool output|read-call/);
	} finally {
		await harness.cleanup();
	}
});

test("fork seeds from the parent's effective compacted context", async () => {
	const factory = new FakeDriverFactory(async () => completedOutcome("fork done"));
	const harness = createHarness({ factory });
	try {
		harness.rootManager.appendMessage(user("obsolete detail"));
		harness.rootManager.appendMessage(assistant([{ type: "text", text: "obsolete answer" }]));
		const firstKeptId = harness.rootManager.appendMessage(user("kept question"));
		harness.rootManager.appendMessage(assistant([{ type: "text", text: "kept answer" }]));
		harness.rootManager.appendCompaction(
			"The obsolete exchange was compacted; keep the retained decision.",
			firstKeptId,
			100,
		);
		harness.rootManager.appendMessage(user("current question"));
		harness.rootManager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "compact-fork", name: "subagent_fork", arguments: {} }],
				"toolUse",
			),
		);

		const started = await harness.runtime.start({
			description: "inherit compacted context",
			prompt: "review",
			context: "fork",
			runInBackground: true,
			parent: harness.parent({ toolCallId: "compact-fork" }),
		});
		await waitUntil(() => factory.opens.length === 1, "compacted fork activation");
		const child = SessionManager.open(
			harness.runtime.getSessionFile(started.subagentId),
			harness.childSessions,
		);
		const context = child.buildSessionContext().messages;
		const rendered = JSON.stringify(context);
		assert.match(rendered, /obsolete exchange was compacted/);
		assert.match(rendered, /kept question/);
		assert.match(rendered, /kept answer/);
		assert.doesNotMatch(rendered, /obsolete detail|obsolete answer|current question/);
	} finally {
		await harness.cleanup();
	}
});

test("fresh spawn never copies completed parent history", async () => {
	const harness = createHarness();
	try {
		harness.rootManager.appendMessage(user("parent question"));
		harness.rootManager.appendMessage(
			assistant([{ type: "text", text: "parent answer" }]),
		);
		const started = await harness.runtime.start({
			description: "fresh isolated context",
			prompt: "standalone child task",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => harness.factory.opens.length === 1, "fresh activation");
		const child = SessionManager.open(
			harness.runtime.getSessionFile(started.subagentId),
			harness.childSessions,
		);
		assert.deepEqual(
			child.getEntries().filter((entry) => entry.type === "message"),
			[],
		);
	} finally {
		await harness.cleanup();
	}
});

test("fork before any completed assistant turn is fresh", async () => {
	const harness = createHarness();
	try {
		harness.rootManager.appendMessage(user("in flight"));
		harness.rootManager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "call", name: "subagent_fork", arguments: {} }],
				"toolUse",
			),
		);
		const target = SessionManager.create(harness.cwd, harness.childSessions, {
			id: randomUUID(),
		});
		assert.equal(
			copyCompletedParentTurns(harness.rootManager, target, "call"),
			undefined,
		);
		assert.deepEqual(target.getEntries(), []);
	} finally {
		await harness.cleanup();
	}
});

test("descriptor, model, thinking, tool scope, identity, and cold resume survive runtime replacement", async () => {
	const firstFactory = new FakeDriverFactory(async () => completedOutcome("initial result"));
	const first = createHarness({ factory: firstFactory });
	const rootPath = first.root;
	try {
		const started = await first.runtime.start({
			description: "persist child identity",
			prompt: "initial",
			context: "fresh",
			runInBackground: true,
			parent: first.parent(),
		});
		await waitUntil(
			() => first.runtime.listAgents(first.runtime.rootAuthority)[0]?.status === "ready",
			"initial settlement",
		);
		const childFile = first.runtime.getSessionFile(started.subagentId);
		assert.ok(childFile && existsSync(childFile));
		const staleAuthority = first.runtime.rootAuthority;
		await first.runtime.shutdown();

		const secondFactory = new FakeDriverFactory(blockingPrompt);
		const second = createHarness({
			root: rootPath,
			rootManager: first.rootManager,
			factory: secondFactory,
		});
		try {
			assert.equal(secondFactory.opens.length, 0, "catalog discovery does not activate cold children");
			assert.deepEqual(second.runtime.listAgents(second.runtime.rootAuthority), [
				{
					kind: "child",
					id: started.subagentId,
					label: "persist child identity",
					status: "ready",
				},
			]);
			assert.throws(
				() => second.runtime.listAgents(staleAuthority),
				/exact live agent authority/,
			);
			second.runtime.followupTask(second.runtime.rootAuthority, started.subagentId, "resume cold");
			await waitUntil(() => secondFactory.opens.length === 1, "cold activation");
			const restored = secondFactory.opens[0].input.descriptor;
			assert.deepEqual(restored.model, { provider: "test", id: "model" });
			assert.equal(restored.thinkingLevel, "high");
			assert.deepEqual(restored.toolNames, ["bash", "read"]);
			assert.equal(secondFactory.opens[0].input.customTools.at(-1).name, "report");
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("catalog reconstruction excludes children launched only on an abandoned root branch", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		const checkpoint = first.rootManager.appendCustomEntry("test/checkpoint", {});
		const started = await first.runtime.start({
			description: "branch local child",
			prompt: "finish",
			context: "fresh",
			runInBackground: true,
			parent: first.parent(),
		});
		await waitUntil(
			() => first.runtime.listAgents(first.runtime.rootAuthority)[0]?.status === "ready",
			"branch child settlement",
		);
		assert.equal(first.runtime.listAgents(first.runtime.rootAuthority)[0].id, started.subagentId);
		await first.runtime.shutdown();
		first.rootManager.branch(checkpoint);

		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			assert.deepEqual(second.runtime.listAgents(second.runtime.rootAuthority), []);
			assert.deepEqual(second.runtime.snapshot(), []);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("restart replays started-but-unterminated inbox work in durable append order", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		await first.runtime.shutdown();
		const childId = randomUUID();
		const manager = createDurableChildSession(
			first.cwd,
			first.childSessions,
			childId,
			first.rootManager.getSessionFile(),
		);
		manager.appendCustomEntry(DESCRIPTOR_ENTRY, {
			version: 2,
			projectTrusted: true,
			childSessionId: childId,
			rootSessionId: first.rootManager.getSessionId(),
			parentSessionId: first.rootManager.getSessionId(),
			parentSessionFile: first.rootManager.getSessionFile(),
			mode: "continuable",
			context: "fresh",
			provider: "pi-sdk",
			label: "recover accepted work",
			depth: 1,
			cwd: first.cwd,
			createdAt: 1,
			model: { provider: "test", id: "model" },
			thinkingLevel: "high",
			toolNames: ["read"],
		});
		for (const [messageId, content] of [
			["z-first", "first accepted"],
			["a-second", "second accepted"],
		]) {
			manager.appendCustomEntry(INBOX_ENTRY, {
				action: "accepted",
				messageId,
				content,
				source: "followup",
				acceptedAt: 10,
			});
		}
		manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "started",
			messageId: "z-first",
			startedAt: 11,
		});
		first.rootManager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: first.rootManager.getSessionId(),
			childId,
			createdAt: 1,
		});

		const factory = new FakeDriverFactory(async (_driver, message) => completedOutcome(message));
		const second = createHarness({
			root: rootPath,
			rootManager: first.rootManager,
			factory,
		});
		try {
			await waitUntil(() => factory.promptLog.length === 2, "recovered inbox delivery");
			assert.deepEqual(factory.promptLog.map((entry) => entry.message), [
				"first accepted",
				"second accepted",
			]);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("restart restores terminal outcomes and retries an unacknowledged settlement outbox", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		await first.runtime.shutdown();
		const childId = randomUUID();
		const manager = createDurableChildSession(
			first.cwd,
			first.childSessions,
			childId,
			first.rootManager.getSessionFile(),
		);
		manager.appendCustomEntry(DESCRIPTOR_ENTRY, {
			version: 2,
			projectTrusted: true,
			childSessionId: childId,
			rootSessionId: first.rootManager.getSessionId(),
			parentSessionId: first.rootManager.getSessionId(),
			parentSessionFile: first.rootManager.getSessionFile(),
			mode: "continuable",
			context: "fresh",
			provider: "pi-sdk",
			label: "recover outcome",
			depth: 1,
			cwd: first.cwd,
			createdAt: 1,
			model: { provider: "test", id: "model" },
			thinkingLevel: "high",
			toolNames: ["read"],
		});
		manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "finished",
			messageId: "done-message",
			finishedAt: 20,
			stopReason: "error",
			output: "partial recovered output",
			errorMessage: "recovered failure",
			usage: usageFor(2, 3, 5, 0.25),
		});
		const notice = {
			messageId: "settlement-outbox",
			kind: "settlement",
			childId,
			content: "durable settlement",
		};
		manager.appendCustomEntry(SETTLEMENT_ENTRY, {
			action: "pending",
			notice,
			createdAt: 21,
		});
		first.rootManager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: first.rootManager.getSessionId(),
			childId,
			createdAt: 1,
		});

		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			assert.equal(second.factory.opens.length, 0);
			assert.deepEqual(second.runtime.snapshot()[0], {
				id: childId,
				parentId: first.rootManager.getSessionId(),
				label: "recover outcome",
				depth: 1,
				mode: "continuable",
				context: "fresh",
				state: "error",
				createdAt: 1,
				updatedAt: 20,
				finishedAt: 20,
				model: "test/model",
				thinkingLevel: "high",
				sessionFile: manager.getSessionFile(),
				lastOutput: "partial recovered output",
				usage: usageFor(2, 3, 5, 0.25),
				activeDurationMs: 0,
				errorMessage: "recovered failure",
			});
			assert.deepEqual(second.notices, [notice]);
			const delivered = SessionManager.open(manager.getSessionFile(), first.childSessions)
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === SETTLEMENT_ENTRY &&
						entry.data?.action === "delivered" &&
						entry.data?.messageId === notice.messageId,
				);
			assert.equal(delivered, true);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("unsupported durable descriptors become contained diagnostics", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		await first.runtime.shutdown();
		const childId = randomUUID();
		const manager = createDurableChildSession(
			first.cwd,
			first.childSessions,
			childId,
			first.rootManager.getSessionFile(),
		);
		manager.appendCustomEntry(DESCRIPTOR_ENTRY, {
			version: 99,
			childSessionId: childId,
			rootSessionId: first.rootManager.getSessionId(),
			parentSessionId: first.rootManager.getSessionId(),
		});
		first.rootManager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: first.rootManager.getSessionId(),
			childId,
			createdAt: Date.now(),
		});
		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			assert.deepEqual(second.runtime.listAgents(second.runtime.rootAuthority), [
				{ kind: "diagnostic", id: childId, reason: "unsupported" },
			]);
			assert.equal(second.factory.opens.length, 0);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("clean shutdown aborts active turns child-first but retains durable sessions", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const harness = createHarness({ factory });
	const rootPath = harness.root;
	try {
		const started = await harness.runtime.start({
			description: "retain durable session",
			prompt: "hold",
			context: "fresh",
			runInBackground: true,
			parent: harness.parent(),
		});
		await waitUntil(() => factory.opens[0]?.isRunning, "active child");
		const file = harness.runtime.getSessionFile(started.subagentId);
		await harness.runtime.shutdown();
		assert.equal(factory.opens[0].interruptions, 1);
		assert.equal(factory.opens[0].disposed, true);
		assert.ok(file && existsSync(file), "shutdown must retain the child session");
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

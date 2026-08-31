import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { childSystemContext, outcomeFrom } from "../extensions/pi-sdk-driver.ts";
import {
	captureProviderAuth,
	inheritProviderRuntime,
	rootNoticeDelivery,
} from "../extensions/subagents.ts";
import {
	CONTROL_ENTRY,
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
	childParent,
	completedOutcome,
	createHarness,
	FakeDriverFactory,
	waitUntil,
} from "./helpers.mjs";

const modelUsage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
};

function assistant(stopReason) {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "model",
		usage: modelUsage,
		stopReason,
		timestamp: Date.now(),
	};
}

function appendDescriptor(harness, childId, manager, overrides = {}) {
	manager.appendCustomEntry(DESCRIPTOR_ENTRY, {
		version: 1,
		childSessionId: childId,
		rootSessionId: harness.rootManager.getSessionId(),
		parentSessionId: harness.rootManager.getSessionId(),
		parentSessionFile: harness.rootManager.getSessionFile(),
		mode: "continuable",
		context: "fresh",
		provider: "pi-sdk",
		label: "recovered child",
		depth: 1,
		cwd: harness.cwd,
		createdAt: 1,
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		toolNames: ["read"],
		...overrides,
	});
	harness.rootManager.appendCustomEntry(LAUNCH_ENTRY, {
		parentSessionId: harness.rootManager.getSessionId(),
		childId,
		createdAt: 1,
	});
}

test("SDK terminal folding fails closed and child report guidance matches tool scope", () => {
	for (const reason of ["deferred", "pending", "toolUse", "unexpected"]) {
		const result = outcomeFrom([assistant(reason)], "");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /non-final reason/);
	}
	assert.match(childSystemContext("continuable"), /Use report/);
	assert.doesNotMatch(childSystemContext("one-shot"), /Use report/);
	assert.equal(rootNoticeDelivery({ kind: "settlement" }, false), "steer");
	assert.equal(rootNoticeDelivery({ kind: "settlement" }, true), "followUp");
	assert.equal(rootNoticeDelivery({ kind: "report" }, false), "followUp");
});

test("parent request auth is inherited when a long-lived resolver has no current key", async () => {
	const fallback = captureProviderAuth(
		{
			"chatgpt-account-id": "account-1",
			"content-type": "application/json",
		},
		"live-parent-token",
	);
	assert.deepEqual(fallback, {
		apiKey: "live-parent-token",
		headers: {
			"chatgpt-account-id": "account-1",
		},
	});

	let inheritedProvider;
	let runtimeKey;
	const provider = {
		id: "openai-codex",
		name: "Codex",
		baseUrl: "https://example.invalid",
		headers: {},
		auth: {},
		getModels: () => [],
		stream() {},
		streamSimple() {},
	};
	const registry = {
		find: () => ({ provider: "openai-codex", id: "gpt-test" }),
		getProvider: () => provider,
		getApiKeyAndHeaders: async () => ({ ok: false, error: "stored OAuth is stale" }),
		getProviderAuth: async () => undefined,
	};
	const runtime = {
		registerNativeProvider(value) { inheritedProvider = value; },
		async setRuntimeApiKey(providerId, apiKey) { runtimeKey = [providerId, apiKey]; },
		getModel: () => ({ provider: "openai-codex", id: "gpt-test" }),
		async getAuth() {
			if (!runtimeKey) return undefined;
			return inheritedProvider.auth.apiKey.resolve({
				ctx: { env: async () => undefined, fileExists: async () => false },
				credential: { type: "api_key", key: runtimeKey[1] },
				signal: new AbortController().signal,
			});
		},
	};
	await inheritProviderRuntime(
		{ modelRegistry: registry },
		{ provider: "openai-codex", id: "gpt-test" },
		runtime,
		fallback,
	);
	assert.deepEqual(runtimeKey, ["openai-codex", "live-parent-token"]);
	const inheritedAuth = await runtime.getAuth();
	assert.equal(inheritedAuth.auth.apiKey, "live-parent-token");
	assert.equal(inheritedAuth.auth.headers["chatgpt-account-id"], "account-1");
});

test("fresh child OAuth is not replaced with an API-key credential", async () => {
	const providerId = "pi-subagent-oauth-test";
	const modelId = "oauth-model";
	const model = {
		id: modelId,
		name: "OAuth model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 2_048,
	};
	const provider = {
		id: providerId,
		name: "OAuth test provider",
		baseUrl: model.baseUrl,
		headers: {},
		auth: {
			oauth: {
				name: "OAuth test",
				async login() { throw new Error("not used"); },
				async refresh(credential) { return credential; },
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
		getModels: () => [model],
		stream() {},
		streamSimple() {},
	};
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		refresh: "refresh-token",
		access: "fresh-oauth-token",
		expires: Date.now() + 3_600_000,
	}));
	const parentRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	const childRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	parentRuntime.registerNativeProvider(provider);
	await inheritProviderRuntime(
		{ modelRegistry: new ModelRegistry(parentRuntime) },
		{ provider: providerId, id: modelId },
		childRuntime,
	);
	const childModel = childRuntime.getModel(providerId, modelId);
	assert.ok(childModel);
	const childAuth = await childRuntime.getAuth(childModel);
	assert.equal(childAuth.source, "OAuth");
	assert.equal(childAuth.auth.apiKey, "fresh-oauth-token");
	assert.equal((await credentials.read(providerId)).type, "oauth");
});

test("missing parent auth fails at activation with the resolver error", async () => {
	const provider = {
		id: "openai-codex",
		name: "Codex",
		baseUrl: "https://example.invalid",
		headers: {},
		auth: {},
		getModels: () => [],
		stream() {},
		streamSimple() {},
	};
	await assert.rejects(
		inheritProviderRuntime(
			{
				modelRegistry: {
					find: () => ({ provider: "openai-codex", id: "gpt-test" }),
					getProvider: () => provider,
					getApiKeyAndHeaders: async () => ({ ok: false, error: "No OAuth credential" }),
					getProviderAuth: async () => undefined,
				},
			},
			{ provider: "openai-codex", id: "gpt-test" },
			{
				registerNativeProvider() {},
				getModel: () => ({ provider: "openai-codex", id: "gpt-test" }),
				getAuth: async () => undefined,
				async setRuntimeApiKey() {},
			},
		),
		/cannot inherit authentication for openai-codex: No OAuth credential/,
	);
});

test("explicitly interrupted queued work remains parked across runtime replacement", async () => {
	const firstFactory = new FakeDriverFactory(blockingPrompt);
	const first = createHarness({ factory: firstFactory });
	const rootPath = first.root;
	try {
		const started = await first.runtime.start({
			description: "park across restart",
			prompt: "current",
			context: "fresh",
			runInBackground: true,
			parent: first.parent(),
		});
		await waitUntil(() => firstFactory.promptLog.length === 1, "first prompt");
		first.runtime.sendMessage(first.runtime.rootAuthority, started.subagentId, "parked");
		first.runtime.interrupt(first.runtime.rootAuthority, started.subagentId);
		await waitUntil(() => first.runtime.snapshot()[0]?.state === "aborted", "abort");
		await first.runtime.shutdown();

		const secondFactory = new FakeDriverFactory(async (_driver, message) => completedOutcome(message));
		const second = createHarness({ root: rootPath, rootManager: first.rootManager, factory: secondFactory });
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(secondFactory.promptLog, []);
			second.runtime.sendMessage(second.runtime.rootAuthority, started.subagentId, "wake");
			await waitUntil(() => secondFactory.promptLog.length === 2, "woken queue");
			assert.deepEqual(secondFactory.promptLog.map((item) => item.message), ["parked", "wake"]);
			const branch = SessionManager.open(second.runtime.getSessionFile(started.subagentId), second.childSessions).getBranch();
			assert.ok(branch.some((entry) => entry.type === "custom" && entry.customType === CONTROL_ENTRY && entry.data?.action === "parked"));
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("recovery synthesizes a missing settlement after a terminal delivery", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		await first.runtime.shutdown();
		const childId = randomUUID();
		const manager = createDurableChildSession(first.cwd, first.childSessions, childId, first.rootManager.getSessionFile());
		appendDescriptor(first, childId, manager);
		manager.appendCustomEntry(INBOX_ENTRY, {
			action: "accepted", messageId: "accepted", content: "work", source: "initial", acceptedAt: 2,
		});
		manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "started", messageId: "accepted", startedAt: 3,
		});
		manager.appendCustomEntry(CONTROL_ENTRY, { action: "parked", at: 4 });
		manager.appendCustomEntry(DELIVERY_ENTRY, {
			action: "finished", messageId: "accepted", finishedAt: 13,
			stopReason: "completed", output: "accepted result",
			usage: { input: 2, output: 3, contextTokens: 5, cost: 0.2 },
		});
		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			await waitUntil(() => second.notices.some((notice) => notice.kind === "settlement"), "synthesized settlement");
			assert.match(second.notices.at(-1).content, /accepted result/);
			assert.equal(second.runtime.snapshot()[0].activeDurationMs, 10);
			const restored = SessionManager.open(
				second.runtime.getSessionFile(childId),
				second.childSessions,
			).getBranch();
			const controls = restored.filter((entry) =>
				entry.type === "custom" && entry.customType === CONTROL_ENTRY);
			assert.equal(controls.at(-1).data.action, "unparked");
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("reports are durable until root delivery accepts them", async () => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const first = createHarness({ factory });
	const rootPath = first.root;
	try {
		first.host.deliverRootNotice = () => false;
		const started = await first.runtime.start({
			description: "durable report", prompt: "hold", context: "fresh", runInBackground: true, parent: first.parent(),
		});
		await waitUntil(() => factory.opens.length === 1, "activation");
		const reportId = first.runtime.report(factory.opens[0].input.authority, "persist this report");
		const branch = SessionManager.open(first.runtime.getSessionFile(started.subagentId), first.childSessions).getBranch();
		assert.ok(branch.some((entry) => entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && entry.data?.action === "pending" && entry.data.notice?.messageId === reportId));
		await first.runtime.shutdown();
		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			await waitUntil(() => second.notices.some((notice) => notice.messageId === reportId), "retried report");
			assert.match(second.notices.find((notice) => notice.messageId === reportId).content, /persist this report/);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("cleanup failure settles as error without retaining an activation", async () => {
	const factory = new FakeDriverFactory(async () => completedOutcome("useful output"));
	const originalOpen = factory.open.bind(factory);
	factory.open = async (input) => {
		const driver = await originalOpen(input);
		driver.dispose = () => { throw new Error("reap failed"); };
		return driver;
	};
	const harness = createHarness({ factory });
	try {
		await harness.runtime.start({
			description: "cleanup failure", prompt: "finish", context: "fresh", runInBackground: true, parent: harness.parent(),
		});
		await waitUntil(() => harness.notices.some((notice) => /reap failed|settled with error/.test(notice.content)), "error settlement");
		assert.equal(harness.runtime.snapshot()[0].state, "error");
		assert.equal(harness.runtime.listAgents(harness.runtime.rootAuthority)[0].status, "ready");
		assert.match(harness.notices.at(-1).content, /useful output/);
		assert.match(harness.notices.at(-1).content, /Error: reap failed/);
	} finally {
		await harness.cleanup();
	}
});

test("terminal persistence failure rejects foreground work and releases the activation", async () => {
	const factory = new FakeDriverFactory(async (driver) => {
		const manager = driver.input.sessionManager;
		const append = manager.appendCustomEntry.bind(manager);
		manager.appendCustomEntry = (type, data) => {
			if (type === DELIVERY_ENTRY && data?.action === "finished")
				throw new Error("terminal append failed");
			return append(type, data);
		};
		return completedOutcome("must not publish success");
	});
	const harness = createHarness({ factory });
	try {
		await assert.rejects(
			harness.runtime.start({
				description: "persistence failure", prompt: "finish", context: "fresh",
				runInBackground: false, parent: harness.parent(),
			}),
			/terminal append failed/,
		);
		await waitUntil(() => factory.opens[0]?.disposed === true, "activation release");
		assert.equal(harness.notices.length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("the first descriptor is authoritative during cold resume", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		const started = await first.runtime.start({
			description: "immutable composition", prompt: "finish", context: "fresh", runInBackground: true, parent: first.parent(),
		});
		await waitUntil(() => first.runtime.listAgents(first.runtime.rootAuthority)[0]?.status === "ready", "settled");
		const file = first.runtime.getSessionFile(started.subagentId);
		await first.runtime.shutdown();
		const manager = SessionManager.open(file, first.childSessions);
		const original = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === DESCRIPTOR_ENTRY).data;
		manager.appendCustomEntry(DESCRIPTOR_ENTRY, {
			...original,
			model: { provider: "forged", id: "wider" },
			toolNames: ["read", "bash", "edit", "write"],
		});
		const factory = new FakeDriverFactory(blockingPrompt);
		const second = createHarness({ root: rootPath, rootManager: first.rootManager, factory });
		try {
			second.runtime.sendMessage(second.runtime.rootAuthority, started.subagentId, "resume");
			await waitUntil(() => factory.opens.length === 1, "cold open");
			assert.deepEqual(factory.opens[0].input.descriptor.model, { provider: "test", id: "model" });
			assert.deepEqual(factory.opens[0].input.descriptor.toolNames, ["bash", "read"]);
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("settlement preserves earlier non-empty output and aggregates usage across FIFO turns", async () => {
	let firstPrompt = true;
	const factory = new FakeDriverFactory((driver) => {
		if (firstPrompt) { firstPrompt = false; return blockingPrompt(driver); }
		return Promise.resolve({
			output: "", stopReason: "completed",
			usage: { input: 7, output: 1, contextTokens: 9, cost: 0.7 },
		});
	});
	const harness = createHarness({ factory });
	try {
		const started = await harness.runtime.start({
			description: "aggregate activation", prompt: "first", context: "fresh", runInBackground: true, parent: harness.parent(),
		});
		await waitUntil(() => factory.opens[0]?.pending, "first prompt");
		harness.runtime.sendMessage(harness.runtime.rootAuthority, started.subagentId, "second");
		factory.opens[0].pending.resolve({
			output: "useful accepted result", stopReason: "completed",
			usage: { input: 3, output: 4, contextTokens: 6, cost: 0.3 },
		});
		await waitUntil(() => harness.notices.some((notice) => notice.kind === "settlement"), "settlement");
		assert.match(harness.notices.at(-1).content, /useful accepted result/);
		assert.deepEqual(harness.runtime.snapshot()[0].usage, {
			input: 10, output: 5, contextTokens: 9, cost: 1,
		});
	} finally {
		await harness.cleanup();
	}
});

test("fork copies bash execution messages from completed context", async () => {
	const harness = createHarness();
	try {
		harness.rootManager.appendMessage({
			role: "bashExecution", command: "echo seeded", output: "seeded", exitCode: 0,
			cancelled: false, truncated: false, timestamp: Date.now(),
		});
		harness.rootManager.appendMessage({ role: "user", content: "done", timestamp: Date.now() });
		harness.rootManager.appendMessage({
			role: "assistant", content: [{ type: "text", text: "complete" }], api: "test",
			provider: "test", model: "model", usage: modelUsage, stopReason: "stop", timestamp: Date.now(),
		});
		const target = SessionManager.create(harness.cwd, harness.childSessions, { id: randomUUID() });
		copyCompletedParentTurns(harness.rootManager.getBranch(), target, "not-present");
		assert.equal(target.getBranch().find((entry) => entry.type === "message")?.message.role, "bashExecution");
	} finally {
		await harness.cleanup();
	}
});

test("missing launched children appear in list and dashboard snapshots as diagnostics", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		await first.runtime.shutdown();
		const missingId = randomUUID();
		first.rootManager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: first.rootManager.getSessionId(), childId: missingId, createdAt: Date.now(),
		});
		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			assert.deepEqual(second.runtime.listAgents(second.runtime.rootAuthority), [
				{ kind: "diagnostic", id: missingId, reason: "unavailable" },
			]);
			const diagnostic = second.runtime.snapshot().find((entry) => entry.id === missingId);
			assert.equal(diagnostic.diagnosticReason, "unavailable");
			assert.equal(diagnostic.state, "error");
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

test("missing nested launches remain visible under their durable parent", async () => {
	const first = createHarness();
	const rootPath = first.root;
	try {
		const started = await first.runtime.start({
			description: "durable parent",
			prompt: "finish parent",
			context: "fresh",
			runInBackground: true,
			parent: first.parent(),
		});
		await waitUntil(
			() => first.runtime.listAgents(first.runtime.rootAuthority)[0]?.status === "ready",
			"parent settlement",
		);
		const parentManager = SessionManager.open(
			first.runtime.getSessionFile(started.subagentId),
			first.childSessions,
		);
		const missingId = randomUUID();
		parentManager.appendCustomEntry(LAUNCH_ENTRY, {
			parentSessionId: started.subagentId,
			childId: missingId,
			createdAt: Date.now(),
		});
		await first.runtime.shutdown();

		const second = createHarness({ root: rootPath, rootManager: first.rootManager });
		try {
			assert.deepEqual(
				second.runtime.listAgents(second.runtime.rootAuthority, "descendants"),
				[
					{
						kind: "child",
						id: started.subagentId,
						label: "durable parent",
						status: "ready",
						parent: second.rootManager.getSessionId(),
						depth: 1,
					},
					{
						kind: "diagnostic",
						id: missingId,
						reason: "unavailable",
						parent: started.subagentId,
						depth: 2,
					},
				],
			);
			const diagnostic = second.runtime.snapshot().find((entry) => entry.id === missingId);
			assert.equal(diagnostic.parentId, started.subagentId);
			assert.equal(diagnostic.diagnosticReason, "unavailable");
		} finally {
			await second.runtime.shutdown();
		}
	} finally {
		rmSync(rootPath, { recursive: true, force: true });
	}
});

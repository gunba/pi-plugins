import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeSessionStats } from "../../pi-codex-compat/extensions/usage.ts";
import subagents, { inheritProviderRuntime } from "../extensions/subagents.ts";
import { PiSdkDriverFactory } from "../extensions/pi-sdk-driver.ts";
import { createSubagentToolDefinitions } from "../extensions/subagent-tools.ts";
import { copyCompletedParentTurns, NOTICE_ENTRY, SETTLEMENT_ENTRY, undispatchedNotices } from "../extensions/subagent-runtime.ts";
import { blockingPrompt, childParent, completedOutcome, createHarness, deferred, FakeDriverFactory, usageFor, waitUntil } from "./helpers.mjs";

const model = {
	id: "offline", name: "Offline", api: "openai-completions", provider: "pi-improvements-test",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048,
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api,
	provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() });
const toolCall = (name, args, id = name) => ({ ...assistant(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] });
const stream = (respond) => (_model, context) => {
	const events = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = respond(context);
		events.push({ type: "done", reason: message.stopReason, message });
	});
	return events;
};
const provider = (respond = () => assistant("done")) => ({
	id: model.provider, name: model.name, baseUrl: model.baseUrl, headers: {},
	auth: { apiKey: { name: "Test", async resolve({ credential }) {
		return credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined;
	} } },
	getModels: () => [model], stream: stream(respond), streamSimple: stream(respond),
});

async function sdkDriver(t, { respond, projectTrusted = false, rootTrusted = true, seed, setup } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-fix-"));
	const cwd = join(root, "work");
	mkdirSync(cwd);
	setup?.(cwd);
	const manager = SessionManager.create(cwd, join(root, "sessions"));
	seed?.(manager);
	const host = { agentDir: root, cwd, isProjectTrusted: () => rootTrusted, resolveModel: () => model,
		async prepareModelRuntime(_ref, runtime, signal) {
			runtime.registerNativeProvider(provider(respond));
			await runtime.setRuntimeApiKey(model.provider, "test", { signal });
		} };
	const driver = await new PiSdkDriverFactory(host).open({
		signal: new AbortController().signal,
		descriptor: { version: 2, projectTrusted, childSessionId: manager.getSessionId(), rootSessionId: "root",
			parentSessionId: "root", mode: "continuable", context: "fork", provider: "pi-sdk", label: "test", depth: 1,
			cwd, createdAt: 1, model: { provider: model.provider, id: model.id }, thinkingLevel: "off", toolNames: ["bash", "read"] },
		sessionManager: manager, authority: {}, customTools: [],
	});
	t.after(() => { driver.dispose(); rmSync(root, { recursive: true, force: true }); });
	return { driver, manager };
}

for (const steeringMode of ["all", "one-at-a-time"]) test(`real SDK root preserves notice order with ${steeringMode} steering`, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-steering-fix-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let session;
	t.after(async () => {
		await session?.extensionRunner?.emit({ type: "session_shutdown" });
		session?.dispose();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(root, { recursive: true, force: true });
	});
	const manager = SessionManager.create(root, join(root, "root-sessions"));
	let rootCalls = 0;
	let childCalls = 0;
	const contexts = [];
	const durableAdmissions = [];
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
	runtime.registerNativeProvider(provider((context) => {
		const isChild = context.messages.some((message) => message.role === "user" &&
			(typeof message.content === "string" ? message.content === "child work" : message.content.some((block) => block.type === "text" && block.text === "child work")));
		if (isChild) return ++childCalls === 1 ? toolCall("report", { output: "EARLY FINDING" }) : assistant("FINAL RESULT");
		contexts.push(context.messages);
		if (++rootCalls === 1) return toolCall("subagent", { description: "offline child", prompt: "child work" });
		if (rootCalls === 2) return toolCall("hold", {});
		return assistant("parent done");
	}));
	await runtime.setRuntimeApiKey(model.provider, "test");
	const settings = SettingsManager.inMemory({ steeringMode, compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noThemes: true, extensionFactories: [subagents, (pi) => {
			pi.on("message_end", (event, ctx) => {
				if (event.message.role !== "custom" || event.message.customType !== "pi-subagents/notice") return;
				const id = event.message.details.messageId;
				durableAdmissions.push(SessionManager.open(ctx.sessionManager.getSessionFile()).getEntries().some((entry) =>
					entry.type === "custom" && entry.customType === NOTICE_ENTRY && entry.data.messageId === id));
			});
		}] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const hold = defineTool({ name: "hold", label: "Hold", description: "Wait for this offline fixture", parameters: Type.Object({}),
		async execute() {
			await waitUntil(() => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === NOTICE_ENTRY).length === 2, "both root receipts");
			return { content: [{ type: "text", text: "done" }], details: {} };
		} });
	({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
		sessionManager: manager, settingsManager: settings, resourceLoader: loader, customTools: [hold], tools: ["hold", "subagent"] }));
	await session.bindExtensions({ mode: "rpc" });
	await session.prompt("parent work");
	assert.equal(rootCalls, steeringMode === "all" ? 3 : 4);
	assert.match(JSON.stringify(contexts[2]), /EARLY FINDING/);
	assert.equal(childCalls, 2, JSON.stringify(contexts));
	const last = JSON.stringify(contexts.at(-1));
	assert.ok(last.indexOf("EARLY FINDING") >= 0);
	assert.ok(last.indexOf("FINAL RESULT") > last.indexOf("EARLY FINDING"));
	assert.deepEqual(undispatchedNotices(SessionManager.open(manager.getSessionFile()).getBranch()), []);
	assert.equal(session.getFollowUpMessages().length, 0);
	assert.deepEqual(durableAdmissions, [true, true], "receipts are on disk before Pi's pre-append message_end hooks");
	const charge = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "pi-subagents/usage-v1");
	assert.equal(charge.data.usage.output, childCalls);
	manager.appendCustomEntry(charge.customType, charge.data);
	assert.equal(computeSessionStats(manager.getEntries()).totalOutput, session.getSessionStats().tokens.output + childCalls, "durable child invocation is charged once, including after replay");
});

test("busy nested parents receive steering without another queued child prompt", async (t) => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const h = createHarness({ factory });
	t.after(h.cleanup);
	const parent = await h.runtime.start({ description: "parent", prompt: "hold", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => factory.opens[0]?.isRunning);
	await h.runtime.start({ description: "child", prompt: "hold", context: "fresh", runInBackground: true,
		parent: childParent(h, parent.subagentId, factory.opens[0].input.authority) });
	await waitUntil(() => factory.opens[1]?.isRunning);
	h.runtime.report(factory.opens[1].input.authority, "EARLY");
	factory.opens[1].pending.resolve(completedOutcome("FINAL"));
	await waitUntil(() => factory.opens[0].notices?.length === 2);
	assert.deepEqual(factory.opens[0].notices.map((notice) => notice.kind), ["report", "settlement"]);
	assert.deepEqual(factory.opens[0].prompts, ["hold"]);
});

test("a running one-shot child accepts updates without becoming resumable", async (t) => {
	const factory = new FakeDriverFactory(blockingPrompt);
	const h = createHarness({ factory });
	t.after(h.cleanup);
	const result = h.runtime.start({ description: "child", prompt: "work", context: "fresh", runInBackground: false, parent: h.parent() });
	await waitUntil(() => factory.opens[0]?.isRunning);
	const child = factory.opens[0];
	const id = child.input.descriptor.childSessionId;
	const update = "update: " + "x".repeat(40_000);
	h.runtime.sendMessage(h.runtime.rootAuthority, id, update);
	assert.ok(child.notices[0].content.endsWith(update), "parent instructions are not truncated as child output");
	child.pending.resolve({ output: "done", stopReason: "completed" });
	await result;
	assert.throws(() => h.runtime.followupTask(h.runtime.rootAuthority, id, "another task"), /not resumable/);
});

test("durable receipt recovers a crash before message append and deduplicates after append", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notice-recovery-"));
	try {
		const sm = SessionManager.create(root, join(root, "sessions"));
		sm.appendMessage(assistant("started"));
		const notice = { kind: "report", childId: "child", messageId: "notice", content: "finding" };
		sm.appendCustomEntry(NOTICE_ENTRY, notice);
		const restored = SessionManager.open(sm.getSessionFile());
		assert.deepEqual(undispatchedNotices(restored.getBranch()), [notice]);
		restored.appendCustomMessageEntry("pi-subagents/notice", notice.content, true, notice);
		assert.deepEqual(undispatchedNotices(SessionManager.open(sm.getSessionFile()).getBranch()), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed admission retains ordered sender outbox until a successful retry", async (t) => {
	const h = createHarness({ factory: new FakeDriverFactory(blockingPrompt) });
	t.after(h.cleanup);
	const started = await h.runtime.start({ description: "child", prompt: "hold", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => h.factory.opens[0]?.isRunning);
	const driver = h.factory.opens[0];
	h.host.deliverRootNotice = () => { throw new Error("disk write failed"); };
	const id = h.runtime.report(driver.input.authority, "EARLY");
	assert.equal(driver.input.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && entry.data.action === "delivered" && entry.data.messageId === id), false);
	const delivered = [];
	h.host.deliverRootNotice = (notice) => { delivered.push(notice); return true; };
	driver.pending.resolve(completedOutcome("FINAL"));
	await waitUntil(() => delivered.length === 2);
	assert.deepEqual(delivered.map((notice) => notice.kind), ["report", "settlement"]);
	assert.ok(readFileSync(h.runtime.getSessionFile(started.subagentId), "utf8").includes('"action":"delivered"'));
});

for (const trust of [false, true]) test(`SDK respects effective project trust ${trust}`, async (t) => {
	let calls = 0;
	const requests = [];
	const { driver } = await sdkDriver(t, {
		projectTrusted: trust,
		setup(cwd) {
			mkdirSync(join(cwd, ".pi", "skills", "unsafe-project-skill"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "printf injected;" }));
			writeFileSync(join(cwd, ".pi", "skills", "unsafe-project-skill", "SKILL.md"), "---\nname: unsafe-project-skill\ndescription: test skill\n---\nProject skill");
		},
		respond(context) { requests.push(context); return ++calls === 1 ? toolCall("bash", { command: "printf requested" }) : assistant("done"); },
	});
	assert.equal((await driver.prompt("work")).stopReason, "completed");
	const context = JSON.stringify(requests.at(-1));
	assert.equal(context.includes("injectedrequested"), trust);
	assert.equal(context.includes("unsafe-project-skill"), trust);
});

test("compaction cannot erase this invocation's assistant output or usage", async (t) => {
	let calls = 0;
	const { driver, manager } = await sdkDriver(t, {
		respond: () => assistant(`response ${++calls}`),
		seed(sm) {
			for (let i = 0; i < 20; i++) {
				sm.appendMessage({ role: "user", content: "seed ".repeat(3000), timestamp: i });
				sm.appendMessage({ ...assistant(`done ${i}`), usage: { ...usage, input: 22000, totalTokens: 22000 } });
			}
		},
	});
	const outcome = await driver.prompt("new task");
	assert.ok(manager.getBranch().some((entry) => entry.type === "compaction"));
	assert.equal(outcome.stopReason, "completed");
	assert.equal(outcome.output, `response ${calls}`);
	assert.equal(outcome.usage.output, calls, "includes this invocation's compaction, not its seeded history");
});

test("fork preserves a compacted seed when no completed assistant remains", () => {
	const parent = SessionManager.inMemory();
	parent.appendMessage({ role: "user", content: "completed constraint", timestamp: 1 });
	parent.appendMessage(assistant("completed answer"));
	const current = parent.appendMessage({ role: "user", content: "in-flight user", timestamp: 2 });
	parent.appendMessage(toolCall("read", {}, "old"));
	const summary = parent.appendCompaction("Completed constraint summary", current, 30000);
	parent.appendMessage(toolCall("subagent_fork", {}, "fork-now"));
	const child = SessionManager.inMemory();
	assert.equal(copyCompletedParentTurns(parent, child, "fork-now"), summary);
	const content = JSON.stringify(child.buildSessionContext().messages);
	assert.match(content, /Completed constraint summary/);
	assert.doesNotMatch(content, /in-flight user|fork-now/);
	child.appendMessage({ role: "user", content: "nested current work", timestamp: 3 });
	child.appendMessage(toolCall("subagent_fork", {}, "nested-fork"));
	const grandchild = SessionManager.inMemory();
	copyCompletedParentTurns(child, grandchild, "nested-fork");
	assert.match(JSON.stringify(grandchild.buildSessionContext().messages), /Completed constraint summary/);
	assert.doesNotMatch(JSON.stringify(grandchild.buildSessionContext().messages), /nested current work/);
	const retained = parent.appendMessage({ role: "toolResult", toolCallId: "fork-now", toolName: "subagent_fork", content: [], isError: false, timestamp: 4 });
	parent.appendCompaction("Summary containing unsafe current work", retained, 30000);
	parent.appendMessage(toolCall("subagent_fork", {}, "later-fork"));
	const later = SessionManager.inMemory();
	copyCompletedParentTurns(parent, later, "later-fork");
	const historical = JSON.stringify(later.buildSessionContext().messages);
	assert.match(historical, /completed constraint/);
	assert.doesNotMatch(historical, /unsafe current work|in-flight user/);
});

test("parent runtime key takes priority over a valid stored child key", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "stored" }));
	const parent = await ModelRuntime.create({ credentials, modelsPath: null });
	const child = await ModelRuntime.create({ credentials, modelsPath: null });
	parent.registerNativeProvider(provider());
	await parent.setRuntimeApiKey(model.provider, "parent-runtime");
	await inheritProviderRuntime({ modelRegistry: new ModelRegistry(parent) }, { provider: model.provider, id: model.id }, child);
	assert.equal((await child.getAuth(model)).auth.apiKey, "parent-runtime");
	assert.equal((await credentials.read(model.provider)).key, "stored");
});

test("interrupt immediately followed by new work cannot strand the accepted turn", async (t) => {
	const h = createHarness({ factory: new FakeDriverFactory((driver, message) => message === "first" ? blockingPrompt(driver) : completedOutcome("resumed")) });
	t.after(h.cleanup);
	const child = await h.runtime.start({ description: "child", prompt: "first", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => h.factory.opens[0]?.pending);
	h.runtime.interrupt(h.runtime.rootAuthority, child.subagentId);
	h.runtime.followupTask(h.runtime.rootAuthority, child.subagentId, "next");
	await waitUntil(() => h.factory.promptLog.length === 2);
	assert.deepEqual(h.factory.promptLog.map((item) => item.message), ["first", "next"]);
});

test("send_message steers current work while followup_task owns new turns", async (t) => {
	const h = createHarness({ factory: new FakeDriverFactory(blockingPrompt) });
	t.after(h.cleanup);
	const child = await h.runtime.start({ description: "child", prompt: "current", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => h.factory.opens[0]?.pending);
	h.runtime.sendMessage(h.runtime.rootAuthority, child.subagentId, "changed assumption");
	assert.match(h.factory.opens[0].notices[0].content, /changed assumption/);
	assert.deepEqual(h.factory.opens[0].prompts, ["current"]);
	h.factory.opens[0].pending.resolve(completedOutcome("done"));
	await waitUntil(() => h.runtime.listAgents(h.runtime.rootAuthority)[0].status === "ready");
	assert.throws(() => h.runtime.sendMessage(h.runtime.rootAuthority, child.subagentId, "another task"), /followup_task/);
});

for (const stopReason of ["completed", "error"]) test(`foreground ${stopReason} billing is recorded exactly once`, async (t) => {
	const billed = [];
	const cost = usageFor(3, 2, 5, 0.3);
	const h = createHarness({ factory: new FakeDriverFactory(async () => ({ output: "result", stopReason, usage: cost })) });
	t.after(h.cleanup);
	h.host.recordBackgroundUsage = (...charge) => billed.push(charge);
	const tool = createSubagentToolDefinitions(h.runtime, { getAuthority: () => h.runtime.rootAuthority }, "root")[0];
	const result = tool.execute("call", { description: "child", prompt: "work", run_in_background: false }, undefined, undefined,
		{ ...h.parent(), isProjectTrusted: () => true });
	if (stopReason === "completed") {
		assert.deepEqual((await result).usage, cost);
		assert.equal(billed.length, 0, "native tool result carries successful foreground usage");
	} else {
		await assert.rejects(result, /ended error/);
		assert.deepEqual(billed[0][2], cost, "failed wrapper cannot return usage, so the durable charge carries it");
		assert.equal(billed.length, 1);
	}
});

test("shutdown cancels a stuck opening and disposes a late driver", async (t) => {
	const opening = deferred();
	let input;
	let disposed = false;
	const h = createHarness({ factory: { async open(value) { input = value; return opening.promise; } } });
	t.after(h.cleanup);
	await h.runtime.start({ description: "stuck", prompt: "work", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => input);
	await Promise.race([h.runtime.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown hung")), 500))]);
	assert.equal(input.signal.aborted, true);
	opening.resolve({ dispose() { disposed = true; } });
	await waitUntil(() => disposed);
});

test("root-wide admission counts opening children before allocating another session", async (t) => {
	const opening = deferred();
	const h = createHarness({ maxActive: 1, factory: { open: () => opening.promise } });
	t.after(h.cleanup);
	const request = { description: "child", prompt: "work", context: "fresh", runInBackground: true, parent: h.parent() };
	await h.runtime.start(request);
	await assert.rejects(h.runtime.start(request), /root-wide subagent limit 1/);
	assert.equal(h.runtime.listAgents(h.runtime.rootAuthority).length, 1);
});

test("interrupting initialization preserves an immediately accepted follow-up task", async (t) => {
	const pending = deferred();
	const normal = new FakeDriverFactory();
	let opening;
	const h = createHarness({ factory: { open(input) {
		if (!opening) { opening = input; return pending.promise; }
		return normal.open(input);
	} } });
	t.after(h.cleanup);
	const child = await h.runtime.start({ description: "child", prompt: "first", context: "fresh", runInBackground: true, parent: h.parent() });
	await waitUntil(() => opening);
	h.runtime.interrupt(h.runtime.rootAuthority, child.subagentId);
	h.runtime.followupTask(h.runtime.rootAuthority, child.subagentId, "next");
	await waitUntil(() => normal.promptLog.length === 1);
	assert.equal(opening.signal.aborted, true);
	assert.equal(normal.promptLog[0].message, "next");
});

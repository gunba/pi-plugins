import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DeskEngine } from "../src/host/engine.ts";
import { NativeQueueGuard } from "../../pi-work-coordination/native-queue.ts";

const initial = { provider: "fixture", id: "initial" }, writing = { provider: "fixture", id: "writing" };

test("selected Codex account routes credentials and survives native reload and reopening", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-account-route-")), agent = join(root, "agent"), id = randomUUID();
	const profiles = join(agent, "desk", "provider-accounts"), profile = join(profiles, id);
	mkdirSync(profile, { recursive: true });
	const credential = identity => ({ type: "oauth", refresh: "fixture", expires: Date.now() + 3600000,
		access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.fixture` });
	const original = credential("original"), selected = credential("selected");
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ "openai-codex": original }));
	writeFileSync(join(profile, "auth.json"), JSON.stringify({ "openai-codex": selected }));
	writeFileSync(join(profile, "account.json"), JSON.stringify({ id, provider: "openai-codex", name: "Selected" }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4" }));
	const engine = new DeskEngine(() => {}), resumed = new DeskEngine(() => {}), fetch = globalThis.fetch;
	globalThis.fetch = () => { throw Error("Account routing fixture must stay offline"); };
	const token = async value => (await value.runtime.services.modelRuntime.getAuth("openai-codex")).auth.apiKey;
	try {
		await engine.start({ cwd: root, agentDir: agent, sessionDir: join(root, "sessions") });
		assert.equal(await token(engine), original.access);
		const models = engine.runtime.services.modelRuntime, calls = [];
		models.registerNativeProvider({ ...models.getProvider("openai-codex"), streamSimple(model, _context, options) {
			calls.push(options?.auth?.apiKey ?? options?.apiKey);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Fixture" }],
					provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
				stream.end();
			});
			return stream;
		} });
		await engine.runtime.session.prompt("Initial fixture");
		assert.deepEqual(calls, [original.access]);
		await engine.command(engine.presentation.generation, { kind: "account", provider: "openai-codex", id });
		assert.deepEqual(engine.snapshot().accounts, { "openai-codex": id });
		assert.equal(await token(engine), selected.access);
		await engine.runtime.session.prompt("Fixture");
		assert.deepEqual(calls, [original.access, selected.access], "native requests must use the selected store, not the initial credential");
		assert.deepEqual(engine.snapshot().accounts, { "openai-codex": id });
		const file = engine.snapshot().file;
		await engine.reload();
		assert.deepEqual(engine.snapshot().accounts, { "openai-codex": id });
		assert.equal(await token(engine), selected.access);
		await engine.close();
		await resumed.start({ cwd: root, agentDir: agent, sessionFile: file });
		assert.deepEqual(resumed.snapshot().accounts, { "openai-codex": id });
		assert.equal(await token(resumed), selected.access);
	} finally {
		await Promise.all([engine.close(), resumed.close()]); globalThis.fetch = fetch;
		rmSync(root, { recursive: true, force: true });
	}
});

test("native extension package warnings reach Desk presentation", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-loader-warning-")), agent = join(root, "agent"), pkg = join(root, "fixture");
	mkdirSync(agent); mkdirSync(pkg);
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "warning-fixture", type: "module",
		pi: { extensions: ["./index.ts"] }, dependencies: { typebox: "1.3.27" } }));
	writeFileSync(join(pkg, "index.ts"), "export default function () {}\n");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [pkg], defaultProjectTrust: "always" }));
	const old = process.env.PI_CODING_AGENT_DIR, engine = new DeskEngine(() => {});
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		await engine.start({ cwd: root, agentDir: agent, ephemeral: true });
		assert.ok(engine.runtime.services.resourceLoader.getExtensions().warnings.some(item => /Host-provided.*typebox/.test(item.warning)));
		assert.ok(engine.presentation.snapshot().notifications.some(item => item.level === "warning" && /Host-provided.*typebox/.test(item.text)),
			"native loader warning must not be lost between resource discovery and the Desk UI");
	} finally {
		await engine.close();
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(root, { recursive: true, force: true });
	}
});

test("next-turn custom context remains pending through handled commands and queued steering", async () => {
	let result = "handled", suspended = false;
	const session = { sessionManager: {}, sendCustomMessage: async () => {}, prompt: async (_text, options) => options.preflightResult(result) };
	const guard = new NativeQueueGuard(session, () => suspended);
	await session.sendCustomMessage({ customType: "aside", content: "Context", display: true }, { deliverAs: "nextTurn" });
	assert.equal(guard.pending, true);
	await session.prompt("/command"); assert.equal(guard.pending, true);
	result = "queued"; await session.prompt("Steering"); assert.equal(guard.pending, true);
	result = "started";
	let forwarded;
	await session.prompt("Start", { preflightResult: value => { forwarded = value; } });
	assert.equal(forwarded, "started"); assert.equal(guard.pending, false);
	suspended = true;
	await assert.rejects(session.prompt("Unexpected start"), /held for an update/);
	assert.equal(guard.pending, false);
});

test("literal paths and unregistered slash text reach native Pi without Desk command errors", async () => {
	const engine = new DeskEngine(() => {}), sent = [];
	engine.snapshot = () => ({});
	engine.runtime = { session: {
		model: { ...initial, input: ["text"] }, sessionId: "fixture", promptTemplates: [],
		extensionRunner: { getCommand: () => undefined },
		prompt: async (text, options) => { sent.push(text); options.preflightResult(true); },
		abortCompaction() {}, abortBranchSummary() {}, abort: async () => {},
	}, services: { resourceLoader: { getExtensions: () => ({ errors: [] }) } }, dispose: async () => {} };
	try {
		for (const text of ["/home/project/file.md is the input", "\\home\\project\\file.md", "/unregistered this is literal text"]) {
			await engine.command(engine.presentation.generation, { kind: "prompt", text });
			assert.equal(sent.at(-1), text);
		}
	} finally { await engine.close(); }
});
test("default changes write preferences without selecting a model in any live conversation", async () => {
	const settings = SettingsManager.inMemory({ defaultProvider: initial.provider, defaultModel: initial.id });
	const engines = [new DeskEngine(() => {}), new DeskEngine(() => {})], selected = [];
	for (const engine of engines) {
		engine.snapshot = () => ({});
		const session = { model: initial, isIdle: true, settingsManager: settings, abortCompaction() {}, abortBranchSummary() {}, abort: async () => {},
			setModel: async (model, options) => {
				selected.push({ engine, model, options }); session.model = model;
				if (options.persist) settings.setDefaultModelAndProvider(model.provider, model.id);
			} };
		engine.runtime = { session, services: { modelRuntime: { checkAuth: async () => ({}), getModel: (_provider, id) => id === writing.id ? writing : initial } }, dispose: async () => {} };
	}
	try {
		await engines[0].command(engines[0].presentation.generation, { kind: "model", ...writing });
		assert.equal(engines[0].runtime.session.model, writing);
		assert.equal(engines[1].runtime.session.model, initial);
		assert.equal(settings.getDefaultModel(), initial.id);
		assert.equal(selected[0].options.persist, false);
		selected.length = 0;
		await engines[0].command(engines[0].presentation.generation, { kind: "model", ...writing, makeDefault: true });
		assert.equal(selected.length, 0, "setting a default is not a session model selection or reasoning reset");
		assert.equal(settings.getDefaultModel(), writing.id);
		assert.equal(engines[0].runtime.session.model, writing);
		assert.equal(engines[1].runtime.session.model, initial);
	} finally { await Promise.all(engines.map(engine => engine.close())); }
});

test("resuming a conversation without user messages keeps its saved model after the default changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-model-")), agent = join(root, "agent");
	mkdirSync(agent);
	const model = "claude-haiku-4-5", next = "claude-sonnet-4-5";
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: model, defaultThinkingLevel: "high" }));
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture" } }));
	const first = new DeskEngine(() => {}), other = new DeskEngine(() => {}), resumed = new DeskEngine(() => {});
	try {
		await first.start({ cwd: root, agentDir: agent, sessionDir: join(root, "sessions") });
		await other.start({ cwd: root, agentDir: agent, sessionDir: join(root, "sessions") });
		const file = other.snapshot().file;
		assert.equal(other.snapshot().model.id, model);
		await first.command(first.presentation.generation, { kind: "model", provider: "anthropic", id: next, makeDefault: true });
		assert.equal(other.snapshot().model.id, model);
		await other.close();
		await resumed.start({ cwd: root, agentDir: agent, sessionFile: file });
		assert.equal(resumed.snapshot().model.id, model, "the current default cannot replace a saved conversation model");
	} finally {
		await Promise.all([first.close(), other.close(), resumed.close()]);
		rmSync(root, { recursive: true, force: true });
	}
});

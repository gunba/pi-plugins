import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DeskEngine } from "../src/host/engine.ts";
import { NativeQueueGuard } from "../../pi-work-coordination/native-queue.ts";

const initial = { provider: "fixture", id: "initial" }, writing = { provider: "fixture", id: "writing" };

test("next-turn custom context remains pending through handled commands and queued steering", async () => {
	let result = "handled", suspended = false;
	const session = { sendCustomMessage: async () => {}, prompt: async (_text, options) => options.preflightResult(result) };
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

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DeskEngine } from "../src/host/engine.ts";

const initial = { provider: "fixture", id: "initial" }, writing = { provider: "fixture", id: "writing" };
test("default changes write preferences without selecting a model in any live conversation", async () => {
	const settings = SettingsManager.inMemory({ defaultProvider: initial.provider, defaultModel: initial.id });
	const engines = [new DeskEngine(() => {}), new DeskEngine(() => {})], selected = [];
	for (const engine of engines) {
		engine.snapshot = () => ({});
		const session = { model: initial, settingsManager: settings, abortCompaction() {}, abortBranchSummary() {}, abort: async () => {},
			setModel: async (model, options) => {
				selected.push({ engine, model, options }); session.model = model;
				if (options.persist) settings.setDefaultModelAndProvider(model.provider, model.id);
			} };
		engine.runtime = { session, services: { modelRuntime: { getModel: (_provider, id) => id === writing.id ? writing : initial } }, dispose: async () => {} };
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

import assert from "node:assert/strict";
import test from "node:test";
import { modelCapacity, recordCodexCapacity } from "../config.ts";

test("a Codex model's capacity is its catalog limit, not a larger saved budget", () => {
	// WoW Addons saved 922,000 for gpt-6-astra; Codex accepts 872,000, so requests failed before Pi compacted.
	assert.equal(modelCapacity({ provider: "openai-codex", id: "gpt-6-astra", contextWindow: 922_000 }), 872_000);
	recordCodexCapacity("gpt-6-astra", 900_000);
	assert.equal(modelCapacity({ provider: "openai-codex", id: "gpt-6-astra", contextWindow: 922_000 }), 900_000, "the live catalog value wins");
});

test("a budget saved from another conversation applies to a running one when it settles", async () => {
	// Four conversations kept their 1M windows after a 500k budget was saved: 3,600 Opus requests above 500k in a week.
	const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
	const directory = mkdtempSync(join(tmpdir(), "context-window-")), previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { anthropic: { modelOverrides: { "claude-opus-5-5": { contextWindow: 500_000 } } } } }));
	try {
		const { default: contextWindow } = await import("../index.ts");
		const handlers = new Map(), selected = [];
		const pi = { on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]), registerCommand() {}, appendEntry() {},
			getThinkingLevel: () => "high", events: { emit() {}, on: () => () => {} }, setModel: async model => { selected.push(model); return true; } };
		contextWindow(pi);
		const running = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 }, saved = { ...running, contextWindow: 500_000 };
		const ctx = { model: running, isIdle: () => true, ui: { notify() {} }, getContextUsage: () => undefined,
			modelRegistry: { refresh: async () => {}, find: () => saved } };
		for (const handler of handlers.get("agent_settled")) handler({}, ctx);
		for (let tick = 0; tick < 50 && !selected.length; tick++) await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(selected, [saved]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

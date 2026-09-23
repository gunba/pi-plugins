import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import fastFooter from "../extensions/fast-footer.ts";

const usage = (input, output, cacheRead, cost) => ({
	input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function harness(mode = "tui") {
	const handlers = new Map();
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage(100, 20, 50, 1) } },
		{ type: "message", message: { role: "toolResult", usage: usage(5, 0, 0, 0.1) } },
		{ type: "compaction", usage: usage(10, 0, 0, 0.3) },
		{ type: "usage", usage: usage(2, 0, 0, 0.2) },
		{ type: "session_info", name: "Working session" },
	];
	const statuses = new Map([["z", "last"], ["a", "first"]]);
	let sessionId = "session-1", leafId = "leaf-1", branch = "main";
	let entryReads = 0, contextReads = 0, renders = 0, disposed = 0;
	let footer, branchChanged;
	const model = { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 200_000, reasoning: true };
	const ctx = {
		mode,
		model,
		thinkingLevel: "high",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => sessionId,
			getLeafId: () => leafId,
			getEntries: () => { entryReads++; return entries.slice(); },
		},
		getContextUsage: () => {
			contextReads++;
			return { tokens: 20_000, contextWindow: 200_000, percent: 10 };
		},
		ui: {
			setFooter(factory) {
				footer?.dispose();
				footer = factory?.({ requestRender: () => { renders++; } },
					{ fg: (_color, text) => text },
					{
						getGitBranch: () => branch,
						getExtensionStatuses: () => statuses,
						getAvailableProviderCount: () => 1,
						onBranchChange(callback) {
							branchChanged = callback;
							return () => { disposed++; };
						},
					});
			},
		},
	};
	fastFooter({ on(name, fn) { handlers.set(name, fn); } });
	return {
		ctx, entries, statuses,
		start() { handlers.get("session_start")({}, ctx); },
		render(width = 120) { return footer.render(width).join("\n"); },
		get footer() { return footer; },
		setLeaf(id) { leafId = id; },
		setSession(id) { sessionId = id; },
		setBranch(name) { branch = name; },
		branchChanged() { branchChanged(); },
		counts() { return { entryReads, contextReads, renders, disposed }; },
	};
}

test("preserves lifetime usage and context while caching long-session scans across redraws", () => {
	const h = harness();
	h.start();
	const first = h.render();
	assert.match(first, /Working session/);
	assert.match(first, /\(main\)/);
	assert.match(first, /↑117 ↓20 R50 CH33\.3% \$1\.600/);
	assert.match(first, /10\.0%\/200k/);
	assert.match(first, /gpt-6-sol • high/);
	assert.match(first, /first last/);
	for (let i = 0; i < 500; i++) h.render();
	assert.deepEqual(h.counts(), { entryReads: 1, contextReads: 1, renders: 0, disposed: 0 });

	h.entries.push({ type: "message", message: { role: "assistant", usage: usage(3, 2, 0, 0.4) } });
	h.setLeaf("leaf-2");
	assert.match(h.render(), /↑120 ↓22 R50 CH0\.0% \$2\.000/);
	assert.deepEqual(h.counts(), { entryReads: 2, contextReads: 2, renders: 0, disposed: 0 });
});

test("branch, status, model, and session changes update without stale footer data", () => {
	const h = harness();
	h.start();
	h.render();
	h.setBranch("feature");
	h.branchChanged();
	h.statuses.set("a", "changed\nstatus");
	assert.match(h.render(), /\(feature\)/);
	assert.match(h.render(), /changed status last/);
	assert.equal(h.counts().entryReads, 1);
	assert.equal(h.counts().renders, 1);

	h.ctx.model = { ...h.ctx.model, id: "other-model" };
	assert.match(h.render(), /other-model/);
	assert.equal(h.counts().entryReads, 2);
	h.ctx.thinkingLevel = "off";
	assert.match(h.render(), /thinking off/);
	assert.equal(h.counts().entryReads, 2);
	h.setSession("session-2");
	h.render();
	assert.equal(h.counts().entryReads, 3);

	h.start();
	h.render();
	assert.equal(h.counts().disposed, 1);
	assert.equal(h.counts().entryReads, 4);
	h.footer.dispose();
	assert.equal(h.counts().disposed, 2);
});

test("short terminals keep each footer line within the available width", () => {
	const h = harness();
	h.start();
	for (const width of [12, 32, 80]) {
		const lines = h.render(width).split("\n");
		assert.ok(lines.every(line => visibleWidth(line) <= width), `${width} columns`);
	}
});

test("does not replace a footer outside interactive mode", () => {
	const h = harness("rpc");
	h.start();
	assert.equal(h.footer, undefined);
	assert.equal(h.counts().entryReads, 0);
});

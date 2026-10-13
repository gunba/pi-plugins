import assert from "node:assert/strict";
import test from "node:test";
import { compactionHeld, compactionKey, recordCompactionFailure, summaryReserve } from "../compaction.ts";
import { measuredContextTokens } from "../compaction-state.ts";

test("a 1M-token conversation's prose summary gets room beyond 80% of the default reserve", () => {
	// Opus 1M summaries needed 13,265 and 20,880 tokens; Pi allowed 13,107.
	const reserve = summaryReserve({ contextWindow: 1_000_000, maxTokens: 128_000 }, { reserveTokens: 16_384, keepRecentTokens: 20_000 });
	assert.equal(Math.floor(0.8 * reserve), 36_384);
	assert.equal(summaryReserve({ contextWindow: 200_000, maxTokens: 64_000 }, { reserveTokens: 16_384, keepRecentTokens: 20_000 }), 16_384, "small windows are unchanged");
});

test("a failed compaction is not repeated automatically until something it depends on changes", () => {
	const model = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 };
	const key = compactionKey(model, { reserveTokens: 16_384, keepRecentTokens: 20_000 }, "xhigh");
	recordCompactionFailure("held", key, "Summarization failed: generation hit the token cap and the summary is incomplete", 0);
	assert.equal(compactionHeld("held", key, 10 ** 12), true);
	assert.equal(compactionHeld("held", compactionKey(model, { reserveTokens: 65_536, keepRecentTokens: 20_000 }, "xhigh"), 0), false);
	recordCompactionFailure("transient", key, "Codex WebSocket closed before completion", 0);
	assert.equal(compactionHeld("transient", key, 60_000), true);
	assert.equal(compactionHeld("transient", key, 16 * 60_000), false, "a transient failure is retried after a pause");
});

test("omitting a failed reply keeps the usage reported before it", () => {
	// Pi fell back to a character estimate: 615,034 for a 920,000-token conversation.
	const usage = { input: 5, output: 1, cacheRead: 919_000, cacheWrite: 0, totalTokens: 919_006, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const user = { role: "user", content: "x".repeat(400), timestamp: 1 };
	const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop", timestamp: 2 };
	const branch = [
		{ type: "message", id: "a", message: user }, { type: "message", id: "b", message: answer },
		{ type: "message", id: "c", message: user }, { type: "message", id: "d", message: { ...answer, stopReason: "error" } },
		{ type: "context_edit", id: "e", targetId: "d", replacement: null },
	];
	const projection = { entries: branch.slice(0, 3).map(entry => ({ sourceEntry: entry, messages: [entry.message] })), messages: [user, answer, user] };
	assert.equal(measuredContextTokens(projection, branch), 919_006 + 100);
	assert.equal(measuredContextTokens(projection, [...branch, { type: "context_edit", id: "f", targetId: "a", replacement: { content: "" } }]), undefined,
		"an edit to earlier context discards the usage");
});

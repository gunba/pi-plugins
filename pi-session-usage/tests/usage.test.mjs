import assert from "node:assert/strict";
import test from "node:test";
import { computeSessionStats, reduceSessionUsage } from "../index.ts";
import { outcomeFrom } from "../../pi-subagents/extensions/pi-sdk-driver.ts";

const usage = {
	input: 2, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 17, reasoning: 1, cacheWrite1h: 2,
	cost: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 },
};
const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], usage, stopReason: "stop" };
const childCharge = { type: "custom", customType: "pi-subagents/usage-v1",
	data: { childId: "child", messageId: "receipt", usage } };
const auxiliary = [
	{ type: "usage", kind: "cache_warm", usage },
	{ type: "compaction", usage },
	{ type: "branch_summary", usage },
	childCharge, structuredClone(childCharge),
];

test("native charges and replayed child receipts feed one session total", () => {
	const entries = [
		{ type: "message", message: assistant },
		{ type: "message", message: { role: "toolResult", usage } },
		...auxiliary,
	];
	const result = reduceSessionUsage(entries);
	assert.equal(result.usage.totalTokens, 6 * 17);
	assert.equal(result.usage.reasoning, 6);
	assert.equal(result.usage.cacheWrite1h, 12);
	assert.equal(result.usage.cost.total, 6 * 17);
	assert.equal(result.contextTokens, 17);
	assert.equal(result.cacheHitRate, 5 / 14 * 100);
	assert.deepEqual(computeSessionStats(entries), {
		totalInput: 12, totalOutput: 18, totalCacheRead: 30, totalCacheWrite: 42, totalCost: 102,
		costInput: 12, costOutput: 18, costCacheRead: 30, costCacheWrite: 42,
	});
	assert.equal(reduceSessionUsage([]).usage, undefined);
});

test("SDK child outcomes include native auxiliary charges without treating them as context", () => {
	const outcome = outcomeFrom([assistant], "", auxiliary);
	assert.equal(outcome.usage.totalTokens, 5 * 17);
	assert.equal(outcome.usage.contextTokens, 17);
	const noAssistant = outcomeFrom([], "", auxiliary);
	assert.equal(noAssistant.usage.totalTokens, 4 * 17);
	assert.equal(noAssistant.usage.contextTokens, 0);
});

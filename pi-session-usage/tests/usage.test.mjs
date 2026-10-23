import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { computeSessionStats, reduceSessionUsage } from "../index.ts";
import { outcomeFrom } from "../../pi-agents/subagents/pi-sdk-driver.ts";

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

test("the usage fold matches Pi's own totals, including billed tools and summaries", () => {
	const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 190, cost: { input: .1, output: .2, cacheRead: .3, cacheWrite: .4, total: 1 } };
	const entries = [
		...["assistant", "toolResult"].map(role => ({ type: "message", message: { role, content: [], usage } })),
		...["compaction", "branch_summary"].map(type => ({ type, usage })),
	];
	const native = AgentSession.prototype.getSessionStats.call({ sessionManager: { getEntries: () => entries }, getContextUsage: () => undefined });
	const actual = computeSessionStats(entries);
	assert.equal(actual.totalInput, native.tokens.input);
	assert.equal(actual.totalOutput, native.tokens.output);
	assert.equal(actual.totalCacheRead, native.tokens.cacheRead);
	assert.equal(actual.totalCacheWrite, native.tokens.cacheWrite);
	assert.equal(actual.totalCost, native.cost);
});

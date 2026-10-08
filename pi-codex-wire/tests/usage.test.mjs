import assert from "node:assert/strict";
import test from "node:test";

import {
	currentUsageSource,
	parseUsageHeaders,
} from "../extensions/usage.ts";

test("Wire parses passive plan windows from Codex headers only", () => {
	const codex = parseUsageHeaders({
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-used-percent": "18.4",
		"x-codex-primary-reset-after-seconds": "60",
		"x-codex-plan-type": "pro",
	});
	assert.equal(codex?.source, "codex");
	assert.equal(codex?.primary?.label, "5h");
	assert.equal(codex?.primary?.usedPercent, 18);
	assert.equal(codex?.planType, "pro");

	assert.equal(
		parseUsageHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "0.5",
			"anthropic-ratelimit-unified-5h-reset": "2099-01-01T00:00:00Z",
		}),
		undefined,
	);
});

test("Claude header utilization is fractional and resets are epoch timestamps", () => {
	const snapshot = parseUsageHeaders({
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.184",
		"anthropic-ratelimit-unified-5h-reset": "4070908800",
		"anthropic-ratelimit-unified-7d-utilization": "0.6",
		"anthropic-ratelimit-unified-7d-reset": "2099-01-07T00:00:00Z",
	}, "claude");
	assert.equal(snapshot.source, "claude");
	assert.equal(snapshot.primary.usedPercent, 18);
	assert.equal(snapshot.primary.resetAtMs, 4070908800000);
	assert.equal(snapshot.secondary.usedPercent, 60);
	assert.equal(snapshot.secondary.label, "7d");
	assert.equal(snapshot.secondary.resetAtMs, Date.parse("2099-01-07T00:00:00Z"));
	assert.equal(parseUsageHeaders({ "anthropic-ratelimit-requests-remaining": "10" }, "claude"), undefined);
	assert.equal(parseUsageHeaders({ "anthropic-ratelimit-unified-5h-utilization": "invalid" }, "claude"), undefined);
});

test("plan windows require the corresponding subscription transport", () => {
	assert.equal(
		currentUsageSource({ api: "openai-codex-responses" }),
		"codex",
	);
	assert.equal(currentUsageSource({ api: "openai-responses" }), undefined);
	const claude = { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
	assert.equal(currentUsageSource(claude), undefined);
	assert.equal(currentUsageSource(claude, true), "claude");
	assert.equal(currentUsageSource({ ...claude, provider: "other-gateway" }, true), undefined);
	assert.equal(currentUsageSource({ ...claude, baseUrl: "https://gateway.example" }, true), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
	currentUsageSource,
	parseUsageHeaders,
} from "../extensions/usage.ts";

test("passive plan-window parsing accepts Codex headers only", () => {
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

test("plan windows are associated only with the Codex subscription transport", () => {
	assert.equal(
		currentUsageSource({ api: "openai-codex-responses" }),
		"codex",
	);
	assert.equal(currentUsageSource({ api: "openai-responses" }), undefined);
	assert.equal(currentUsageSource({ api: "anthropic-messages" }), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { modelCapacity, recordCodexCapacity } from "../config.ts";

test("a Codex model's capacity is its catalog limit, not a larger saved budget", () => {
	// WoW Addons saved 922,000 for gpt-6-astra; Codex accepts 872,000, so requests failed before Pi compacted.
	assert.equal(modelCapacity({ provider: "openai-codex", id: "gpt-6-astra", contextWindow: 922_000 }), 872_000);
	recordCodexCapacity("gpt-6-astra", 900_000);
	assert.equal(modelCapacity({ provider: "openai-codex", id: "gpt-6-astra", contextWindow: 922_000 }), 900_000, "the live catalog value wins");
});

import assert from "node:assert/strict";
import test from "node:test";

import { terminalRunCanHide } from "../extensions/run-lifecycle.ts";

test("a consumed run can hide when every subagent is terminal and inactive", () => {
	const agents = [
		{ name: "Alice", state: "done" },
		{ name: "Bob", state: "stopped" },
		{ name: "Cara", state: "error" },
	];

	assert.equal(terminalRunCanHide(agents, () => false, false), true);
});

test("live work, active processes, pending messages, and empty runs stay visible", () => {
	assert.equal(
		terminalRunCanHide([{ name: "Alice", state: "running" }], () => false, false),
		false,
	);
	assert.equal(
		terminalRunCanHide([{ name: "Alice", state: "done" }], () => true, false),
		false,
	);
	assert.equal(
		terminalRunCanHide([{ name: "Alice", state: "done" }], () => false, true),
		false,
	);
	assert.equal(terminalRunCanHide([], () => false, false), false);
});

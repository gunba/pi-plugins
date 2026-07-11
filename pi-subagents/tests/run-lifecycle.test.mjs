import assert from "node:assert/strict";
import test from "node:test";

import { terminalRunCanHide } from "../extensions/run-lifecycle.ts";

test("a consumed run can hide when every subagent is terminal and inactive", () => {
	const agents = [
		{ name: "/root/alice", state: "completed" },
		{ name: "/root/cara", state: "error" },
		{ name: "/root/dana", state: "hard_killed" },
	];

	assert.equal(terminalRunCanHide(agents, () => false, false), true);
});

test("interrupted tasks keep their run available for follow-up", () => {
	assert.equal(
		terminalRunCanHide(
			[{ name: "/root/alice", state: "interrupted" }],
			() => false,
			false,
		),
		false,
	);
});

test("live work, active processes, pending messages, and empty runs stay visible", () => {
	assert.equal(
		terminalRunCanHide([{ name: "/root/alice", state: "running" }], () => false, false),
		false,
	);
	assert.equal(
		terminalRunCanHide([{ name: "/root/alice", state: "completed" }], () => true, false),
		false,
	);
	assert.equal(
		terminalRunCanHide([{ name: "/root/alice", state: "completed" }], () => false, true),
		false,
	);
	assert.equal(terminalRunCanHide([], () => false, false), false);
});

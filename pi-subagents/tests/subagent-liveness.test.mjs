import assert from "node:assert/strict";
import test from "node:test";

import {
	nextProgressDeadline,
	stalledProgress,
} from "../extensions/subagent-liveness.ts";

test("stalled progress is a deterministic inactivity threshold", () => {
	const observations = [
		{ taskPath: "/root/stalled", progressAt: 1_000 },
		{ taskPath: "/root/active", progressAt: 9_500 },
	];
	assert.deepEqual(stalledProgress(observations, 11_000, 10_000), [
		observations[0],
	]);
});

test("new progress moves the next liveness deadline", () => {
	assert.equal(
		nextProgressDeadline(
			[
				{ taskPath: "/root/first", progressAt: 5_000 },
				{ taskPath: "/root/second", progressAt: 8_000 },
			],
			10_000,
		),
		15_000,
	);
	assert.equal(nextProgressDeadline([], 10_000), undefined);
});

test("invalid stall timeouts are rejected", () => {
	assert.throws(() => stalledProgress([], 1_000, 0), /positive finite/);
	assert.throws(() => nextProgressDeadline([], Number.NaN), /positive finite/);
});

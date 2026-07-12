import assert from "node:assert/strict";
import test from "node:test";

import { parseOverseerOutput } from "../extensions/subagent-overseer.ts";

test("overseer decisions are parsed from strict task-agnostic JSON", () => {
	assert.deepEqual(
		parseOverseerOutput(
			'{"decisions":[{"taskPath":"/root/worker","blocked":true,"reason":"CPU, tokens, and transcript are unchanged"}]}',
		),
		[
			{
				taskPath: "/root/worker",
				blocked: true,
				reason: "CPU, tokens, and transcript are unchanged",
			},
		],
	);
});

test("overseer rejects missing or malformed decisions", () => {
	assert.throws(() => parseOverseerOutput("not json"), /no JSON/i);
	assert.throws(
		() => parseOverseerOutput('{"decisions":"none"}'),
		/decisions array/i,
	);
	assert.throws(
		() => parseOverseerOutput('{"decisions":[{"taskPath":"/root/worker"}]}'),
		/invalid decision/i,
	);
});

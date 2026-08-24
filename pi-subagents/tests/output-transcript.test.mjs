import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { outcomeFrom } from "../extensions/pi-sdk-driver.ts";
import {
	MAX_PARENT_NOTICE_BYTES,
	truncateForParent,
} from "../extensions/subagent-runtime.ts";
import {
	publishedAssistantText,
	readSessionTranscript,
} from "../extensions/session-transcript.ts";

const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
};

function assistant(content, stopReason = "stop", errorMessage) {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "model",
		usage,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

test("SDK output fold selects the last non-empty assistant text, not reasoning or tool output", () => {
	const outcome = outcomeFrom(
		[
			assistant([{ type: "text", text: "first" }]),
			assistant([
				{ type: "thinking", thinking: "private" },
				{ type: "toolCall", id: "x", name: "read", arguments: {} },
				{ type: "text", text: "final" },
			]),
			assistant([]),
		],
		"stream fallback",
	);
	assert.equal(outcome.output, "final");
	assert.equal(outcome.stopReason, "completed");
	assert.deepEqual(outcome.usage, {
		input: 9,
		output: 6,
		contextTokens: 5,
		cost: 0.30000000000000004,
	});
});

test("SDK output fold preserves streamed partial text and abnormal stop reason", () => {
	assert.deepEqual(outcomeFrom([assistant([], "length")], "partial stream"), {
		output: "partial stream",
		stopReason: "max-tokens",
		usage: { input: 3, output: 2, contextTokens: 5, cost: 0.1 },
	});
	assert.deepEqual(outcomeFrom([assistant([], "aborted")], "cancelled partial"), {
		output: "cancelled partial",
		stopReason: "aborted",
		usage: { input: 3, output: 2, contextTokens: 5, cost: 0.1 },
	});
});

test("SDK output fold takes status from the terminal assistant even when earlier text is publishable", () => {
	const outcome = outcomeFrom(
		[
			assistant([{ type: "text", text: "partial useful result" }]),
			assistant([], "error", "provider failed after the partial result"),
		],
		"",
	);
	assert.equal(outcome.output, "partial useful result");
	assert.equal(outcome.stopReason, "error");
	assert.equal(outcome.errorMessage, "provider failed after the partial result");
});

test("parent-facing output is bounded by UTF-8 bytes without splitting surrogate pairs", () => {
	const output = truncateForParent("😀".repeat(MAX_PARENT_NOTICE_BYTES));
	assert.ok(Buffer.byteLength(output, "utf8") <= MAX_PARENT_NOTICE_BYTES);
	assert.match(output, /truncated/);
	assert.doesNotMatch(output, /�/);
});

test("published transcript answer is the last non-empty successful assistant message", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-output-"));
	try {
		const manager = SessionManager.create(root, join(root, "sessions"), {
			id: randomUUID(),
		});
		manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
		manager.appendMessage(assistant([{ type: "text", text: "usable result" }]));
		manager.appendMessage(assistant([], "stop"));
		manager.appendMessage(assistant([{ type: "text", text: "failed text" }], "error", "boom"));
		assert.equal(publishedAssistantText(manager.getBranch(), "fallback"), "usable result");
		const transcript = readSessionTranscript(manager.getSessionFile());
		assert.match(transcript.lines.join("\n"), /usable result/);
		assert.match(transcript.lines.join("\n"), /assistant ERROR \(error\): boom/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

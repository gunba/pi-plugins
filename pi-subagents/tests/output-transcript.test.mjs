import { usageFor } from "./helpers.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
	assert.deepEqual(outcome.usage, usageFor(9, 6, 5, 0.30000000000000004));
});

test("SDK output fold preserves streamed partial text and abnormal stop reason", () => {
	assert.deepEqual(outcomeFrom([assistant([], "length")], "partial stream"), {
		output: "partial stream",
		stopReason: "max-tokens",
		usage: usageFor(3, 2, 5, 0.1),
	});
	assert.deepEqual(outcomeFrom([assistant([], "aborted")], "cancelled partial"), {
		output: "cancelled partial",
		stopReason: "aborted",
		usage: usageFor(3, 2, 5, 0.1),
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

test("transcript previews parse appends incrementally, follow branches, and enforce display bounds", t => {
	const root = mkdtempSync(join(tmpdir(), "pi-transcript-cache-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, join(root, "sessions"));
	const first = manager.appendMessage(assistant([{ type: "text", text: "first" }]));
	const file = manager.getSessionFile();
	const read = fs.readFileSync;
	let fullReads = 0;
	t.mock.method(fs, "readFileSync", (...args) => { if (args[0] === file) fullReads++; return read(...args); });
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	assert.match(readSessionTranscript(file).lines.join("\n"), /first/);
	manager.appendMessage(assistant([{ type: "text", text: "abandoned branch" }]));
	assert.match(readSessionTranscript(file).lines.join("\n"), /abandoned branch/);
	assert.equal(fullReads, 1, "an append does not reread and parse the full session");
	manager.branch(first);
	manager.appendMessage(assistant([{ type: "text", text: "selected branch" }]));
	const branch = readSessionTranscript(file).lines.join("\n");
	assert.match(branch, /first/);
	assert.match(branch, /selected branch/);
	assert.doesNotMatch(branch, /abandoned branch/);
	manager.appendMessage(assistant([{ type: "text", text: "x".repeat(80_000) + "\x1b]52;c;secret\x07tail" }]));
	for (const limit of [0, 1, 2, 3, 64]) {
		const bounded = readSessionTranscript(file, limit).lines.join("\n");
		assert.ok(bounded.length <= limit);
		assert.doesNotMatch(bounded, /\x1b|\x07|secret/);
	}
	const entry = { type: "message", id: randomUUID(), parentId: manager.getLeafId(), timestamp: new Date().toISOString(),
		message: assistant([{ type: "text", text: "completed fragment" }]) };
	const line = JSON.stringify(entry) + "\n", half = Math.floor(line.length / 2);
	appendFileSync(file, line.slice(0, half));
	const partialSize = fs.statSync(file).size;
	readSessionTranscript(file, 64);
	assert.equal(fs.statSync(file).size, partialSize, "a preview cannot repair or alter a partial append");
	appendFileSync(file, line.slice(half));
	assert.match(readSessionTranscript(file, 64).lines.join("\n"), /completed fragment/);
	const replacement = SessionManager.create(root, join(root, "replacement"));
	replacement.appendMessage(assistant([{ type: "text", text: "replacement" }]));
	copyFileSync(replacement.getSessionFile(), file);
	assert.match(readSessionTranscript(file, 64).lines.join("\n"), /replacement/);
});

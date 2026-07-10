import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSessionTranscript } from "../extensions/session-transcript.ts";

function entry(type, id, parentId, payload) {
	return {
		type,
		id,
		parentId,
		timestamp: new Date(
			1_700_000_000_000 + Number.parseInt(id, 16),
		).toISOString(),
		...payload,
	};
}

test("session inspection follows Pi's active branch and includes tools and errors", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-"));
	const file = join(dir, "session_task-test.jsonl");
	const rows = [
		{
			type: "session",
			version: 3,
			id: "11111111-1111-4111-8111-111111111111",
			timestamp: new Date().toISOString(),
			cwd: dir,
		},
		entry("message", "00000001", null, {
			message: {
				role: "user",
				content: "Investigate the failing build",
				timestamp: 1,
			},
		}),
		entry("thinking_level_change", "00000002", "00000001", {
			thinkingLevel: "high",
		}),
		entry("message", "00000003", "00000002", {
			message: {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I should inspect the compiler output.",
					},
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "npm test" },
					},
				],
				provider: "openai-codex",
				model: "gpt-5.4",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		}),
		entry("message", "00000004", "00000003", {
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "TypeError: broken build" }],
				isError: true,
				timestamp: 3,
			},
		}),
		entry("message", "00000005", "00000004", {
			message: {
				role: "assistant",
				content: [],
				provider: "openai-codex",
				model: "gpt-5.4",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "WebSocket disconnected",
				timestamp: 4,
			},
		}),
	];
	writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

	try {
		const transcript = readSessionTranscript(file);
		const text = transcript.lines.join("\n");
		assert.equal(transcript.error, undefined);
		assert.match(text, /Investigate the failing build/);
		assert.match(text, /thinking level → high/);
		assert.match(text, /\[thinking\]/);
		assert.match(text, /\[tool call\] bash/);
		assert.match(text, /tool result · bash ERROR/);
		assert.match(text, /TypeError: broken build/);
		assert.match(text, /assistant ERROR \(error\): WebSocket disconnected/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session inspection returns the newest bounded window", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-tail-"));
	const file = join(dir, "session_task-tail.jsonl");
	const rows = [
		{
			type: "session",
			version: 3,
			id: "22222222-2222-4222-8222-222222222222",
			timestamp: new Date().toISOString(),
			cwd: dir,
		},
	];
	let parentId = null;
	for (let index = 1; index <= 20; index++) {
		const id = index.toString(16).padStart(8, "0");
		rows.push(
			entry("message", id, parentId, {
				message: {
					role: "user",
					content: `message-${index}`,
					timestamp: index,
				},
			}),
		);
		parentId = id;
	}
	writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

	try {
		const transcript = readSessionTranscript(file, 120, 4);
		const text = transcript.lines.join("\n");
		assert.match(text, /earlier session entries hidden/);
		assert.doesNotMatch(text, /message-1\b/);
		assert.match(text, /message-20/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

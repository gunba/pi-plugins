import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { copyCompletedParentTurns } from "../extensions/subagent-runtime.ts";
import { pruneCompactedSession } from "../../pi-session-memory/extensions/session-memory.ts";

const user = content => ({ role: "user", content, timestamp: 1 });
const assistant = text => ({
	role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test",
	stopReason: "stop", timestamp: 2,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("fork preserves current context edits without restoring removed or replaced content", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-edited-fork-"));
	try {
		const parent = SessionManager.create(directory, directory);
		parent.appendMessage(user("EARLIER_REQUEST")); parent.appendMessage(assistant("earlier answer"));
		const removed = parent.appendMessage(user("REMOVED_REQUEST"));
		const removedReply = parent.appendMessage(assistant("REMOVED_REPLY"));
		const request = parent.appendMessage(user("REPLACED_REQUEST"));
		const reply = parent.appendMessage(assistant("REPLACED_REPLY"));
		parent.appendContextEdit(removed, null); parent.appendContextEdit(removedReply, null);
		parent.appendContextEdit(request, { content: "current request" });
		parent.appendContextEdit(reply, { content: [{ type: "text", text: "current answer" }] });
		parent.appendMessage(user("IN_FLIGHT_REQUEST"));
		parent.appendMessage({ ...assistant(""), stopReason: "toolUse", content: [{ type: "toolCall", name: "spawn_agent", id: "spawn", arguments: {} }] });
		const original = readFileSync(parent.getSessionFile());
		for (const turns of [undefined, 1]) {
			const child = SessionManager.create(directory, directory);
			copyCompletedParentTurns(parent, child, "spawn", turns);
			const context = JSON.stringify(child.buildSessionContext().messages);
			assert.match(context, /current request/); assert.match(context, /current answer/);
			assert.doesNotMatch(context, /REMOVED_|REPLACED_|IN_FLIGHT_/);
			if (turns === 1) assert.doesNotMatch(context, /EARLIER_REQUEST/);
			else assert.match(context, /EARLIER_REQUEST/);
		}
		assert.deepEqual(readFileSync(parent.getSessionFile()), original);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fork checkpoints survive reopen and nested forks without sharing resident payloads", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-fork-"));
	try {
		const parent = SessionManager.create(directory, directory);
		parent.appendMessage(user("earlier request"));
		parent.appendMessage(assistant("earlier answer"));
		const kept = parent.appendMessage(user("retained request"));
		parent.appendMessage(assistant("retained answer"));
		const details = { nativeCodex: { output: [{ type: "compaction", encrypted_content: "fixture-opaque" }] } };
		parent.appendCompaction("checkpoint", kept, 100, details, true);
		const parentContext = structuredClone(parent.buildSessionContext());
		const parentBytes = readFileSync(parent.getSessionFile());

		const child = SessionManager.create(directory, directory);
		copyCompletedParentTurns(parent, child, "not-present");
		const inherited = child.getBranch().find(entry => entry.type === "custom_message");
		assert.deepEqual(inherited.details.sourceDetails, details);
		assert.notEqual(inherited.details.sourceDetails, details);
		assert.deepEqual(SessionManager.open(child.getSessionFile()).getBranch()[0].details.sourceDetails, details);
		const grandchild = SessionManager.create(directory, directory);
		copyCompletedParentTurns(child, grandchild, "not-present");
		const grandchildSummary = grandchild.getBranch().find(entry => entry.type === "custom_message");
		assert.notEqual(grandchildSummary.details, inherited.details);
		grandchildSummary.details.sourceDetails.nativeCodex.output[0].encrypted_content = "changed fixture";
		assert.equal(inherited.details.sourceDetails.nativeCodex.output[0].encrypted_content, "fixture-opaque");

		const newKept = child.appendMessage(user("child request"));
		child.appendMessage(assistant("child answer"));
		child.appendCompaction("child checkpoint", newKept, 100);
		assert.ok(pruneCompactedSession(child).prunedEntries > 0);
		assert.deepEqual(parent.buildSessionContext(), parentContext);
		assert.deepEqual(readFileSync(parent.getSessionFile()), parentBytes);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { materializeSession } from "../src/host/session-storage.ts";

test("an empty Desk conversation and its extension state survive reopening without inference", t => {
	const directory = mkdtempSync(join(tmpdir(), "desk-session-storage-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(directory, directory);
	const id = manager.getSessionId(), file = manager.getSessionFile();
	assert.equal(existsSync(file), false);
	materializeSession(manager);
	manager.appendSessionInfo("Empty conversation");
	manager.appendCustomEntry("sample", { saved: true });
	const reopened = SessionManager.open(file);
	assert.equal(reopened.getSessionId(), id);
	assert.equal(reopened.getSessionName(), "Empty conversation");
	assert.deepEqual(reopened.getEntries().at(-1).data, { saved: true });
	assert.equal(reopened.getEntries().some(entry => entry.type === "message"), false);
	materializeSession(reopened);
	assert.equal(reopened.getEntries().length, 2);
});

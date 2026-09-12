import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	SessionManager,
	buildContextEntries,
} from "@earendil-works/pi-coding-agent";
import extension, {
	pruneCompactedSession,
	restorePrunedSession,
} from "../extensions/session-memory.ts";

const text = (value) => [{ type: "text", text: value }];
const fixtures = mkdtempSync(join(tmpdir(), "pi-memory-fixtures-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
let fixtureId = 0;

function user(id, parentId, value) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text(value), timestamp: 1 },
	};
}

function assistant(id, parentId, value) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: text(value),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

function manager(entries, leafId) {
	const id = `fixture-${++fixtureId}`;
	const file = join(fixtures, `${id}.jsonl`);
	writeFileSync(file, [
		{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: fixtures },
		...entries,
	].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return {
		getSessionFile: () => file,
		getSessionId: () => id,
		getEntries: () => entries.slice(),
		getBranch: () => {
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const branch = [];
			for (let entry = byId.get(leafId); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
				branch.push(entry);
			}
			return branch.reverse();
		},
		buildContextEntries: () => buildContextEntries(entries, leafId),
	};
}

test("does nothing before the first compaction", () => {
	const entries = [user("u1", null, "keep me")];
	const before = structuredClone(entries);
	const report = pruneCompactedSession(manager(entries, "u1"));
	assert.equal(report.compactionId, undefined);
	assert.equal(report.prunedEntries, 0);
	assert.deepEqual(entries, before);
});

test("releases only payloads outside the active context and keeps current branch state", () => {
	const huge = "x".repeat(100_000);
	const entries = [
		user("u0", null, huge),
		assistant("a0", "u0", huge),
		{
			type: "compaction",
			id: "c0",
			parentId: "a0",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: huge,
			firstKeptEntryId: "u0",
			tokensBefore: 100,
			details: { files: [huge] },
		},
		user("u1", "c0", huge),
		{
			type: "custom",
			id: "state",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "goal-change",
			data: { objective: "keep extension state" },
		},
		user("kept", "state", "active kept message"),
		assistant("kept-a", "kept", "active kept answer"),
		{
			type: "compaction",
			id: "c1",
			parentId: "kept-a",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "latest summary",
			firstKeptEntryId: "kept",
			tokensBefore: 200,
			details: { files: ["active.ts"] },
		},
		user("new", "c1", "active new message"),
		assistant("leaf", "new", "active new answer"),
		{
			type: "custom",
			id: "abandoned-state",
			parentId: "a0",
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "abandoned",
			data: { payload: huge },
		},
	];
	const fake = manager(entries, "leaf");
	const activeBefore = structuredClone(fake.buildContextEntries());

	const report = pruneCompactedSession(fake);

	assert.equal(report.compactionId, "c1");
	assert.equal(report.activeEntries, 5);
	assert.ok(report.estimatedBytesReleased > 490_000);
	assert.deepEqual(fake.buildContextEntries(), activeBefore);
	assert.deepEqual(entries[0].message.content, []);
	assert.deepEqual(entries[1].message.content, []);
	assert.equal(entries[1].message.provider, "openai-codex");
	assert.equal(entries[2].summary, "");
	assert.equal(entries[2].details, undefined);
	assert.deepEqual(entries[4].data, { objective: "keep extension state" });
	assert.equal(entries[10].data, undefined);
	assert.equal(pruneCompactedSession(fake).estimatedBytesReleased, 0);
});

test("keeps the JSONL archive unchanged and future appends remain append-only", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-memory-"));
	try {
		const sm = SessionManager.create(directory, directory);
		sm.appendMessage({ role: "user", content: text("old ".repeat(10_000)), timestamp: 1 });
		sm.appendMessage(assistant("unused", null, "answer ".repeat(10_000)).message);
		const keptId = sm.appendMessage({ role: "user", content: text("keep"), timestamp: 2 });
		sm.appendMessage(assistant("unused", null, "kept answer").message);
		sm.appendCompaction("summary", keptId, 100);
		sm.appendMessage({ role: "user", content: text("after"), timestamp: 3 });
		sm.appendMessage(assistant("unused", null, "after answer").message);

		const file = sm.getSessionFile();
		assert.ok(file);
		const archiveBefore = readFileSync(file, "utf8");
		const contextBefore = structuredClone(sm.buildSessionContext());

		const report = pruneCompactedSession(sm);

		assert.ok(report.estimatedBytesReleased > 50_000);
		assert.deepEqual(sm.buildSessionContext(), contextBefore);
		assert.equal(readFileSync(file, "utf8"), archiveBefore);

		sm.appendMessage({ role: "user", content: text("future append"), timestamp: 4 });
		const archiveAfter = readFileSync(file, "utf8");
		assert.ok(archiveAfter.startsWith(archiveBefore));
		assert.match(archiveAfter.slice(archiveBefore.length), /future append/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("extension prunes on startup and compaction and supports runtime toggles", async () => {
	const hooks = {};
	const commands = {};
	extension({
		on: (name, handler) => { hooks[name] = handler; },
		registerCommand: (name, command) => { commands[name] = command; },
	});
	const entries = [
		user("old", null, "x".repeat(10_000)),
		user("kept", "old", "keep"),
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
		},
		assistant("leaf", "compact", "answer"),
	];
	const notifications = [];
	const ctx = {
		sessionManager: manager(entries, "leaf"),
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};

	hooks.session_start({}, ctx);
	assert.deepEqual(entries[0].message.content, []);
	await commands["session-memory"].handler("off", ctx);
	assert.match(notifications.at(-1).message, /disabled/);
	await commands["session-memory"].handler("prune", ctx);
	assert.match(notifications.at(-1).message, /disabled/);
	await commands["session-memory"].handler("on", ctx);
	hooks.session_compact({}, ctx);
	await commands["session-memory"].handler("status", ctx);
	assert.match(notifications.at(-1).message, /3 active \/ 4 total/);
});

test("restores old branches and checkpoint details before navigation without writing the archive", () => {
	const sm = SessionManager.create(fixtures, fixtures);
	const first = sm.appendMessage({ role: "user", content: text("original request"), timestamp: 1 });
	const old = sm.appendMessage(assistant("unused", null, "original answer").message);
	const details = { nativeCodex: { output: [{ type: "compaction", encrypted_content: "fixture" }] } };
	const checkpoint = sm.appendCompaction("first checkpoint", first, 100, details, true);
	const kept = sm.appendMessage({ role: "user", content: text("new request"), timestamp: 2 });
	sm.appendMessage(assistant("unused", null, "new answer").message);
	sm.appendCompaction("second checkpoint", kept, 100);
	const archive = readFileSync(sm.getSessionFile());
	const oldContext = sm.getBranch(old).map(entry => structuredClone(entry));
	const hooks = {};
	extension({ on: (name, fn) => { hooks[name] = fn; }, registerCommand() {} });
	const ctx = { sessionManager: sm, ui: { notify() {} } };
	hooks.session_start({}, ctx);
	assert.deepEqual(sm.getEntry(first).message.content, []);
	assert.equal(sm.getEntry(checkpoint).details, undefined);
	// Native tree preparation holds references to these same entry objects.
	const preparedEntry = sm.getEntry(checkpoint);
	assert.equal(hooks.session_before_tree({}, ctx), undefined);
	assert.deepEqual(preparedEntry.details, details);
	assert.deepEqual(sm.getBranch(old), oldContext);
	sm.branch(checkpoint);
	hooks.session_tree({}, ctx);
	assert.deepEqual(sm.getEntry(checkpoint).details, details);
	assert.deepEqual(sm.buildSessionContext().messages[1].content, text("original request"));
	assert.deepEqual(readFileSync(sm.getSessionFile()), archive);
});

test("does not prune sessions without a persisted archive", () => {
	const sm = SessionManager.inMemory();
	sm.appendMessage({ role: "user", content: text("original"), timestamp: 1 });
	sm.appendMessage(assistant("unused", null, "answer").message);
	const kept = sm.appendMessage({ role: "user", content: text("keep"), timestamp: 2 });
	sm.appendCompaction("summary", kept, 100);
	const original = structuredClone(sm.getEntries());
	assert.equal(pruneCompactedSession(sm).prunedEntries, 0);
	assert.deepEqual(sm.getEntries(), original);
});

test("archive failure cancels navigation and restoration is atomic", () => {
	const entries = [
		user("old", null, "saved"),
		user("kept", "old", "keep"),
		{ type: "compaction", id: "compact", parentId: "kept",
			timestamp: "2026-01-01T00:00:00.000Z", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100 },
	];
	const sm = manager(entries, "compact");
	const hooks = {};
	extension({ on: (name, fn) => { hooks[name] = fn; }, registerCommand() {} });
	const notifications = [];
	const ctx = { sessionManager: sm, ui: { notify: text => notifications.push(text) } };
	hooks.session_start({}, ctx);
	const pruned = structuredClone(entries);
	writeFileSync(sm.getSessionFile(), '{"type":"session","version":3,"id":"other"}\n');
	assert.throws(() => restorePrunedSession(sm), /does not match/);
	assert.deepEqual(entries, pruned);
	assert.deepEqual(hooks.session_before_tree({}, ctx), { cancel: true });
	assert.deepEqual(hooks.session_before_fork({}, ctx), { cancel: true });
	assert.match(notifications.at(-1), /cancelled/);
	assert.deepEqual(entries, pruned);
});

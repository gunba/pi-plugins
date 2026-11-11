import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { reduceEvents } from "../src/client/state.ts";

test("explicit close removes a workspace session, but retains its native reference", async () => {
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const key = randomUUID(), activation = randomUUID();
		const view = { key, activation, cwd: dir, created: 1, state: "ready", file: join(dir, "native.jsonl") };
		host.sessions.set(key, { view, worker: { close: async () => {} } });
		host.workerEvent(key, { type: "control", control: {
			id: randomUUID(), kind: "close", state: "completed", generation: "g", started: 1,
		} });
		assert.equal(host.state().sessions.length, 0);
		const saved = new SessionCatalog(dir).read()[0];
		assert.equal(saved.file, view.file);
		assert.equal(saved.interrupted, false);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a closing conversation does not report Starting when its presentation is torn down", async () => {
	// Closing announced new presentation generations, which the host took for a restart.
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const key = randomUUID(), close = randomUUID();
		const ui = generation => ({ generation, views: [], interactions: [], statuses: {}, notifications: [], editorText: "", editorId: "e", title: "Pi Desk" });
		host.sessions.set(key, { view: { key, activation: randomUUID(), cwd: dir, created: 1, state: "ready", ui: ui("first") }, worker: { close: async () => {} } });
		host.workerEvent(key, { type: "control", control: { id: close, kind: "close", state: "running", generation: "", started: 1 } });
		host.workerEvent(key, { type: "ui", snapshot: ui("teardown") });
		assert.equal(host.sessions.get(key).view.state, "ready");
		host.workerEvent(key, { type: "control", control: { id: close, kind: "close", state: "completed", generation: "", started: 1, ended: 2 } });
		assert.equal(host.state().sessions.length, 0);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("restarting a conversation onto a new process keeps it open and selected", async () => {
	// The close half of a restart dropped the conversation from the list, so Desk fell back to the intro splash.
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const key = randomUUID(), close = randomUUID();
		host.sessions.set(key, { replacing: true, view: { key, activation: randomUUID(), cwd: dir, created: 1, state: "ready", updating: true }, worker: { close: async () => {} } });
		host.workerEvent(key, { type: "control", control: { id: close, kind: "close", state: "completed", generation: "", started: 1, ended: 2 } });
		const listed = host.state().sessions.find(session => session.key === key);
		assert.equal(listed?.state, "starting");
		assert.equal(listed?.updating, true);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("host restart preserves open membership without starting Pi; explicit close can dismiss it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const key = randomUUID(), oldActivation = randomUUID();
	new SessionCatalog(dir).write([{ key, activation: oldActivation, cwd: dir, created: 1, state: "ready" }]);
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const restored = host.state().sessions[0];
		assert.equal(restored.interrupted, true);
		assert.equal(host.sessions.get(key).worker, undefined);
		const close = activation => host.api.handle("operator", {
			method: "POST", path: `/api/sessions/${key}/close`, body: { id: randomUUID(), activation },
		});
		assert.equal((await close(oldActivation)).status, 409, "an old browser cannot close a new host incarnation");
		assert.ok(restored.activation);
		assert.notEqual(restored.activation, oldActivation);
		assert.equal((await close(restored.activation)).status, 200);
		assert.equal(host.state().sessions.length, 0);
		assert.equal(new SessionCatalog(dir).read()[0].interrupted, false);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** Registers a helper agent as the subagent runtime does, with its history in its conversation's folder. */
function helperOf(host, dir, root) {
	const helper = randomUUID(), folder = join(dir, "subagents", "sessions", root), file = join(folder, `2026-11-08T02-20-55-550Z_${helper}.jsonl`);
	mkdirSync(folder, { recursive: true });
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: helper, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
	host.parties.store.register(helper, randomUUID(), "Untitled conversation", dir, "child", file);
	return helper;
}

test("watch news for a helper agent waits for its next turn instead of opening it as a conversation", async () => {
	// Desk opened Idea Arena's helpers for their watches' news. Their conversation's process held them open, so each try
	// left a failed "New conversation" row, and another every 15 minutes.
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const helper = helperOf(host, dir, randomUUID());
		host.watches.store.addEvent({ id: randomUUID(), watch: "", agent: helper, home: "", name: "w1", text: "The auditor ruled.", created: Date.now(), state: "pending" });
		host.watches.scan();
		assert.deepEqual(host.state().sessions, []);
		assert.deepEqual(host.watches.store.events(helper, "pending").map(event => event.text), ["The auditor ruled."]);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a removed row for the same conversation doesn't take the news of the sleeping one listed", async () => {
	// A conversation removed and later resumed under another letter case of its file's path was listed twice. Its watch's
	// news went to the newer, removed row, which has no one to tell, so the sleeping conversation was never woken.
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const agent = randomUUID(), file = join(dir, "native.jsonl"), listed = randomUUID(), removed = randomUUID();
		host.sessions.set(listed, { view: { key: listed, activation: randomUUID(), cwd: dir, created: 1, state: "closed", kept: true, agentId: agent, file } });
		host.sessions.set(removed, { view: { key: removed, activation: randomUUID(), cwd: dir, created: 2, state: "closed", agentId: agent, file } });
		const reopened = [];
		host.createSession = (_cwd, _file, existing) => { reopened.push(existing.view.key); return existing.view.key; };
		host.watches.store.addEvent({ id: randomUUID(), watch: "", agent, home: "", name: "w1", text: "Watch w1: it's 3:01 am, the time you set.", created: Date.now(), state: "pending" });
		host.watches.scan();
		assert.deepEqual(reopened, [listed]);
		assert.deepEqual(host.watches.store.events(agent, "pending").map(event => event.name), ["w1"]);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("removing a conversation ends its helper agents' watches with its own", async () => {
	// A helper runs only in its conversation's process; once that was removed, the helper's watches ran on unheard.
	const dir = mkdtempSync(join(tmpdir(), "desk-workspace-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: dir, port: 0 });
	try {
		await host.start();
		const root = randomUUID(), helper = helperOf(host, dir, root), stranger = helperOf(host, dir, randomUUID());
		const watch = agent => {
			const id = randomUUID(), created = Date.now();
			host.watches.store.insert({ id, agent, home: "", runs: "", name: "w1", spec: { id: "w1", mode: "time", at: created + 3_600_000, cwd: dir, created },
				state: "running", created, progress: {} });
			return id;
		};
		const own = watch(root), helpers = watch(helper), others = watch(stranger);
		const key = randomUUID(), activation = randomUUID();
		host.sessions.set(key, { view: { key, activation, cwd: dir, created: 1, state: "closed", kept: true, agentId: root } });
		const removed = await host.api.handle("operator", { method: "POST", path: `/api/sessions/${key}/close`, body: { id: randomUUID(), activation, keep: false } });
		assert.equal(removed.status, 200);
		assert.deepEqual([own, helpers, others].map(id => host.watches.store.get(id).state), ["ended", "ended", "running"]);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Resume remains available with only interruption feedback in the transcript", () => {
	const source = readFileSync(new URL("../src/client/app.tsx", import.meta.url), "utf8");
	assert.equal(/\{session\s*&&\s*!canCompose\s*&&\s*\(\s*<div className="connection-banner">/.test(source), true,
		"the Resume control must not depend on native messages; feedback alone can fill the transcript");
});

test("closed rows and their transcript leave every browser, without hiding interrupted rows", () => {
	const open = { key: "open", state: "ready", cwd: "/project", created: 1 };
	const interrupted = { ...open, key: "interrupted", state: "closed", interrupted: true };
	const closed = { ...open, key: "closed", state: "closed" };
	let state = reduceEvents({ messages: {} }, [{ type: "state",
		state: { name: "Computer", cwd: "/project", sessions: [open, interrupted, closed] } }]);
	assert.deepEqual(state.host.sessions.map(item => item.key), ["open", "interrupted"]);
	state.messages.open = [{ id: "message" }];
	state = reduceEvents(state, [{ type: "session", session: { ...open, state: "closed" } }]);
	assert.deepEqual(state.host.sessions.map(item => item.key), ["interrupted"]);
	assert.equal(state.messages.open, undefined);
});

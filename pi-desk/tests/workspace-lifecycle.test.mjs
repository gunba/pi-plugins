import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

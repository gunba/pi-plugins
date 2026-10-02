import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DeskHost } from "../src/host/server.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "../src/host/worker-errors.ts";
import { API_HEADER, API_VERSION } from "../src/shared/release.ts";

test("a background catalog failure keeps the host alive and explicit durability barriers fail", async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-catalog-lock-"));
	const host = new DeskHost({ cwd: root, agentDir: root, dataDir: root, port: 0 });
	try {
		const { origin } = await host.start();
		const lock = Object.assign(new Error("fixture catalog publication is locked"), { code: "EPERM" });
		const writer = t.mock.method(host.catalog, "write", () => { throw lock; });
		let scheduled;
		const timer = t.mock.method(globalThis, "setTimeout", callback => { scheduled = callback; return 1; });
		t.mock.method(console, "error", () => {});
		host.persist();
		assert.doesNotThrow(() => scheduled());
		assert.match(host.state().storageError, /references.*not.*saved/i);
		assert.throws(() => host.persist(true), error => error === lock);
		const fork = t.mock.method(childProcess, "fork", () => { throw Error("An unsaved reference must not launch a worker"); });
		syncBuiltinESMExports();
		assert.throws(() => host.createSession(root), error => error === lock);
		assert.equal(fork.mock.callCount(), 0);
		assert.equal(host.sessions.size, 0, "a rejected initial save cannot strand a starting session");
		const key = randomUUID();
		host.sessions.set(key, { view: { key, state: "ready", cwd: root, created: 1 } });
		assert.doesNotThrow(() => host.workerEvent(key, { type: "control", control: { id: "done", kind: "compact", state: "completed" } }));
		host.sessions.clear();
		writer.mock.restore(); timer.mock.restore();
		const token = JSON.parse(readFileSync(join(root, "access.json"), "utf8")).operator;
		const response = await fetch(`${origin}/api/storage/retry`, { method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [API_HEADER]: String(API_VERSION) }, body: "{}" });
		assert.equal(response.status, 200); assert.deepEqual(await response.json(), { saved: true });
		assert.equal(host.state().storageError, undefined);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); await host.close(); rmSync(root, { recursive: true, force: true }); }
});

test("worker loss and stale generations are not reported as definitive command rejection", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-control-"));
	const host = new DeskHost({ cwd: root, agentDir: root, dataDir: root, port: 0 });
	try {
		const { origin } = await host.start();
		const token = JSON.parse(readFileSync(join(root, "access.json"))).operator;
		const key = randomUUID();
		let failure = new WorkerConnectionError("Worker stopped before the outcome was confirmed.");
		host.sessions.set(key, { view: { key, state: "ready", cwd: root, created: Date.now() },
			worker: { command: async () => { throw failure; }, close: async () => {} } });
		const send = () => fetch(`${origin}/api/sessions/${key}/command`, {
			method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [API_HEADER]: String(API_VERSION) },
			body: JSON.stringify({ id: randomUUID(), generation: "sample", command: { kind: "name", name: "Sample" } }),
		});
		let response = await send();
		assert.equal(response.status, 503); await response.text();
		failure = new StaleGeneration();
		response = await send();
		assert.equal(response.status, 409); await response.text();
		failure = new ReceiptConflict("Receipt expired");
		response = await send();
		assert.equal(response.status, 409); await response.text();
		const managed = host.sessions.get(key);
		managed.view.ui = { generation: "old", interactions: [{ id: "unanswerable" }] };
		managed.view.snapshot = { activity: "waiting" };
		host.workerEvent(key, { type: "fatal", error: "Worker stopped" });
		assert.equal(managed.view.ui, undefined, "a stopped worker cannot leave a live question");
		assert.equal(managed.view.snapshot, undefined);
	} finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});

test("host recovery preserves an unfinished control as uncertain without replaying it", () => {
	const root = mkdtempSync(join(tmpdir(), "desk-control-catalog-"));
	try {
		const catalog = new SessionCatalog(root);
		catalog.write([{ key: "sample", state: "ready", cwd: root, created: 1, controls: [{
			id: "control", kind: "compact", generation: "before", started: 1, state: "running",
		}] }]);
		const restored = catalog.read()[0];
		assert.equal(restored.state, "closed");
		assert.equal(restored.controls[0].state, "interrupted");
		assert.match(restored.controls[0].error, /not replayed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

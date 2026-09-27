import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "../src/host/worker-errors.ts";
import { API_HEADER, API_VERSION } from "../src/shared/release.ts";

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

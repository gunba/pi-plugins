import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { API_HEADER, API_VERSION } from "../src/shared/release.ts";

test("host shutdown rejects party startup waits without leaving their timeout alive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "desk-startup-close-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, port: 0 });
	try {
		await host.start();
		host.sessions.set("starting", { view: { key: "starting", cwd: dir, created: Date.now(), state: "starting" } });
		const rejected = assert.rejects(host.waitForSession("starting"), /Desk stopped during agent startup/);
		await host.close(); await rejected;
		assert.equal(host.startupWaits.size, 0);
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("party close skips closed children with no parent driver without resuming an owner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "desk-party-closed-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, port: 0 });
	try {
		await host.start();
		const store = host.parties.store, child = randomUUID(), root = randomUUID(), owner = randomUUID();
		for (const id of [root, child]) {
			store.register(id, owner, id, dir, id === child ? "child" : "session");
			store.join(id, owner, "closed-party", id); store.release(id, owner);
		}
		host.createSession = () => assert.fail("Closing stopped agents must not start an owner");
		const targets = [root, child].map(id => ({ id, epoch: store.member(id).epoch }));
		assert.deepEqual(await host.closePartyAgents("closed-party", targets), { results: [
			{ id: child, state: "already_closed" }, { id: root, state: "already_closed" },
		] });
		assert.match((await host.closePartyAgents("closed-party", [{ id: child, epoch: randomUUID() }])).results[0].error, /membership changed/);
		store.touch(child, owner, "idle");
		assert.match((await host.closePartyAgents("closed-party", [targets[1]])).results[0].error, /parent driver is unavailable/);
		store.release(child, owner);
		host.partyOperations.registerDriver(root, owner, "", [child]);
		let routed = 0;
		host.partyOperations.queueDriver = (reference, control) => {
			assert.equal(reference.owner, owner); assert.equal(control.kind, "close"); routed++;
		};
		host.partyOperations.waitDriver = async () => ({ result: { session: child, state: "closed" } });
		assert.deepEqual(await host.closePartyAgents("closed-party", [targets[1]]), { results: [{ id: child, state: "closed" }] });
		assert.equal(routed, 1, "A live driver must settle its own child, even when the child's worker is stopped");
	} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SSE reconnects during worker shutdown cannot keep the host lease alive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "desk-close-"));
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir: join(dir, "desk"), port: 0 });
	let release;
	const stopped = new Promise(resolve => { release = resolve; });
	let closing;
	try {
		const { origin } = await host.start();
		const token = JSON.parse(readFileSync(join(dir, "desk", "access.json"))).operator;
		host.sessions.set("probe", { view: { key: "probe", state: "ready", cwd: dir, created: Date.now() },
			worker: { close: () => stopped } });
		closing = host.close();
		const response = await fetch(`${origin}/api/events`, { headers: { Authorization: `Bearer ${token}`, [API_HEADER]: String(API_VERSION) } });
		assert.equal(response.status, 503);
		await response.text();
	} finally {
		release();
		host.server.closeAllConnections();
		await closing;
		await host.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

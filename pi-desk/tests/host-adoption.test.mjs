import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { SessionWorker } from "../src/host/worker-client.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { InputLedger } from "../src/host/inputs.ts";
import { WorkerConnectionError } from "../src/host/worker-errors.ts";
import { atomicJson, readState, runtimeIdentity, versionDirectory } from "../manage/store.ts";
import { activatePreparedRuntime } from "../manage/activate.ts";
import { attachWorker, waitWorkerStopped, workerDirectory } from "../src/host/worker-registry.ts";

const module = fileURLToPath(new URL("./fixtures/persistent-worker.mjs", import.meta.url));
async function waitFixtureExit(pid) {
	const until = Date.now() + 15_000;
	while (pid) {
		try { process.kill(pid, 0); }
		catch (error) { if (error.code === "ESRCH") return; throw error; }
		assert.ok(Date.now() < until, `Fixture actor ${pid} did not exit`);
		await delay(25);
	}
}

test("host adoption preserves activation and recovers sent input without replay while queued input reaches the same actor", { timeout: 20000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-host-adoption-")), data = join(root, "desk");
	mkdirSync(data);
	const key = randomUUID(), activation = randomUUID(), file = join(root, "native.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: root, timestamp: new Date().toISOString() }) + "\n");
	const original = readFileSync(file);
	let admitted;
	const accepted = new Promise(resolve => { admitted = resolve; });
	const worker = new SessionWorker({ cwd: root, agentDir: root, sessionFile: file }, message => {
		if (message.type === "event") admitted();
	}, { directory: data, key, module });
	const snapshot = await worker.start();
	const catalog = new SessionCatalog(data);
	catalog.write([{ key, activation, cwd: root, created: Date.now(), state: "ready", snapshot }]);
	const ledger = new InputLedger(data), sent = randomUUID(), queued = randomUUID();
	const input = (id, text) => ({ id, activation, generation: snapshot.ui.generation, command: { kind: "prompt", text } });
	ledger.admit(key, input(sent, "Already sent")); ledger.settle(key, sent, "sending");
	ledger.admit(key, input(queued, "Still queued")); ledger.close();
	const command = worker.command({ kind: "prompt", text: "Already sent" }, snapshot.ui.generation, sent).catch(error => error);
	await accepted;
	await worker.detach();
	assert.ok(await command instanceof WorkerConnectionError);
	const host = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	t.after(async () => {
		await host.close(); await waitFixtureExit(snapshot.pid);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
	});
	await host.start();
	const managed = await host.waitForSession(key);
	assert.equal(managed.view.activation, activation);
	assert.equal(managed.worker.instance, worker.instance);
	assert.equal(managed.view.snapshot.id, snapshot.id);
	assert.deepEqual(managed.view.snapshot.accounts, snapshot.accounts);
	for (;;) {
		if (host.inputs.read(key, sent).status.state === "accepted" && host.inputs.read(key, queued).status.state === "accepted") break;
		await delay(5);
	}
	const current = await managed.worker.command({ kind: "snapshot" });
	assert.equal(current.pid, snapshot.pid);
	assert.equal(current.child, snapshot.child);
	assert.equal(current.writes, 2, "one prior accepted command plus one previously undispatched message");
	assert.deepEqual(readFileSync(file), original);
	assert.deepEqual(managed.view.inputs, []);
});

test("adoption-only attachment never cold-starts a missing actor", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-adopt-only-"));
	try {
		await assert.rejects(attachWorker(workerDirectory(root, "missing"), { cwd: root }, () => {}, () => {},
			{ adoptOnly: true, expectedInstance: randomUUID(), module }), /no worker was started/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("public runtime activation replaces the host while a busy actor and its process keep their old runtime", { timeout: 20000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-live-update-")), data = join(root, "desk"), home = join(root, "runtime");
	mkdirSync(data); mkdirSync(home);
	const ready = (digest, desk) => {
		const id = runtimeIdentity(digest, process.platform, process.arch, process.versions.modules);
		const entry = join(versionDirectory(home, id), "source", "pi-desk", "dist", "host");
		mkdirSync(entry, { recursive: true });
		for (const name of ["cli.js", "managed.js", "manage-cli.js"]) writeFileSync(join(entry, name), "");
		atomicJson(join(versionDirectory(home, id), "runtime.json"), { format: 1, id, digest, platform: process.platform,
			arch: process.arch, node: process.versions.modules, source: root, readyAt: new Date().toISOString(),
			plugins: "0.29.3", desk, engine: "1.0.0" });
		return id;
	};
	const active = ready("a".repeat(64), "0.5.23"), target = ready("b".repeat(64), "0.5.24");
	const pin = versionDirectory(home, active);
	atomicJson(join(home, "state.json"), { format: 1, source: root, active, pending: target, autoApply: target });
	atomicJson(join(home, "installation.json"), { format: 1, directory: data, agentDir: root, cwd: root, port: 0 });
	const key = randomUUID(), activation = randomUUID(), file = join(root, "native.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: root, timestamp: new Date().toISOString() }) + "\n");
	const original = readFileSync(file);
	const first = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	await first.start(); first.runtime = active; first.runtimeHome = home;
	let entered;
	const sending = new Promise(resolve => { entered = resolve; });
	let actorPid;
	const worker = new SessionWorker({ cwd: root, agentDir: root, sessionFile: file }, message => {
		first.workerEvent(key, message);
		if (message.type === "event") entered();
	}, { directory: data, key, module }, { attach: async (...args) => {
		const connection = await attachWorker(...args.slice(0, 4), { ...args[4], runtimeDirectory: pin });
		actorPid = connection.record.pid;
		return connection;
	}, waitStopped: waitWorkerStopped });
	let next;
	t.after(async () => {
		await next?.close(); await first.close(); await worker.close();
		// Releasing the registry is not process exit; Windows can still hold the actor's cwd.
		await waitFixtureExit(actorPid);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
	});
	const snapshot = await worker.start();
	const managed = { worker, initialized: true, initialGeneration: snapshot.ui.generation,
		view: { key, activation, cwd: root, created: Date.now(), state: "ready", file, snapshot, ui: snapshot.ui } };
	first.sessions.set(key, managed); first.persist(true);
	const id = randomUUID();
	first.inputs.admit(key, { id, activation, generation: worker.generation, command: { kind: "prompt", text: "Held during update" } });
	first.drainInputs(managed);
	await sending;
	assert.equal(managed.view.snapshot.activity, "running");
	const sourceHost = first.control.record.instance;
	const checkpoint = "busy-handoff";
	assert.deepEqual(await activatePreparedRuntime(home, target, checkpoint), { release: "0.5.24", startup: "launcher" });
	assert.equal(readState(home).active, target);
	assert.equal(readState(home).previous, active);
	process.kill(snapshot.pid, 0); process.kill(snapshot.child, 0);
	const ledger = new InputLedger(data);
	assert.equal(ledger.read(key, id).status.state, "sending");
	assert.equal(ledger.checkpoint().state, "committed"); ledger.close();
	next = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	const recover = next.recoverUpdateReferences.bind(next);
	next.recoverUpdateReferences = () => { next.runtime = target; next.runtimeHome = home; return recover(); };
	next.scheduleUpdateCheck = () => {}; // This isolated release fixture has no remote update channel.
	await next.start();
	const adopted = await next.waitForSession(key);
	await next.restoreUpdateJob;
	assert.equal(adopted.view.snapshot.activity, "running");
	writeFileSync(join(root, "allow-finish"), "");
	for (;;) { if (next.inputs.read(key, id).status.state === "accepted") break; await delay(5); }
	assert.notEqual(next.control.record.instance, sourceHost);
	assert.equal(adopted.view.activation, activation);
	assert.equal(adopted.worker.instance, worker.instance);
	assert.equal(adopted.worker.runtimeDirectory, pin);
	const current = await adopted.worker.command({ kind: "snapshot" });
	assert.equal(current.pid, snapshot.pid); assert.equal(current.child, snapshot.child);
	assert.equal(current.runtimePin, pin); assert.equal(current.writes, 1);
	assert.equal(next.inputs.checkpoint().state, "complete");
	assert.deepEqual(readFileSync(file), original);
	assert.equal(readFileSync(join(pin, "runtime.json"), "utf8").includes(active), true);
});

test("a lost host connection reattaches the same long-lived actor and reconciles input receipts without replay", { timeout: 20000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-connection-recovery-")), data = join(root, "desk");
	mkdirSync(data);
	const key = randomUUID(), activation = randomUUID(), file = join(root, "native.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: root, timestamp: new Date().toISOString() }) + "\n");
	const original = readFileSync(file), host = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	await host.start();
	let entered, actorPid;
	const worker = new SessionWorker({ cwd: root, agentDir: root, sessionFile: file }, message => {
		host.workerEvent(key, message);
		if (message.type === "event") entered?.();
	}, { directory: data, key, module });
	t.after(async () => {
		await host.close();
		// A detached view no longer owns the fixture's live actor. Adopt it only to clean up.
		const cleanup = new SessionWorker({ cwd: root }, () => {}, { directory: data, key, adopt: worker.instance });
		await cleanup.close();
		await waitFixtureExit(actorPid);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
	});
	const snapshot = await worker.start(); actorPid = snapshot.pid;
	const managed = { worker, initialized: true, initialGeneration: worker.initialGeneration,
		view: { key, activation, cwd: root, file, created: Date.now(), state: "ready", snapshot, ui: snapshot.ui } };
	host.sessions.set(key, managed);
	// Long-lived actors can retire their initial command receipt. Adoption must not initialize again.
	await Promise.all(Array.from({ length: 257 }, (_, index) => worker.command({ kind: "name", name: `fixture-${index}` })));
	assert.equal((await worker.receipt(`init:${worker.instance}`)).state, "retired");
	const sending = new Promise(resolve => { entered = resolve; });
	const sent = randomUUID(), queued = randomUUID();
	for (const [id, text] of [[sent, "Held during update"], [queued, "Previously queued"]])
		host.inputs.admit(key, { id, activation, generation: worker.generation, command: { kind: "prompt", text } });
	host.drainInputs(managed);
	await sending;
	await (await worker.connection).channel.detach();
	const until = Date.now() + 4000;
	let recovered;
	for (;;) {
		recovered = host.sessions.get(key);
		if (recovered !== managed && recovered.initialized && recovered.view.state === "ready") break;
		assert.ok(Date.now() < until, `No automatic recovery: ${recovered.view.state}`);
		await delay(5);
	}
	assert.equal(recovered.worker.instance, worker.instance);
	assert.equal(recovered.view.activation, activation);
	assert.equal(recovered.worker.generation, snapshot.ui.generation);
	assert.deepEqual(recovered.view.snapshot.accounts, snapshot.accounts);
	assert.equal(host.inputs.read(key, sent).status.state, "sending");
	assert.equal(host.inputs.read(key, queued).status.state, "queued");
	process.kill(snapshot.pid, 0); process.kill(snapshot.child, 0);
	writeFileSync(join(root, "allow-finish"), "");
	while (host.inputs.read(key, queued).status.state !== "accepted") {
		assert.ok(Date.now() < until, "Input receipts did not settle");
		await delay(5);
	}
	assert.equal(host.inputs.read(key, sent).status.state, "accepted");
	const current = await recovered.worker.command({ kind: "snapshot" });
	assert.equal(current.pid, snapshot.pid); assert.equal(current.child, snapshot.child);
	assert.equal(current.writes, 259, "257 earlier commands, one recovered receipt, one queued message");
	assert.deepEqual(readFileSync(file), original);
	// An immediately recurring failure stops instead of entering an attachment loop.
	await (await recovered.worker.connection).channel.detach();
	await delay(25);
	assert.equal(host.sessions.get(key), recovered);
	assert.equal(recovered.view.state, "failed");
	assert.equal(recovered.worker, undefined);
	process.kill(snapshot.pid, 0);
});

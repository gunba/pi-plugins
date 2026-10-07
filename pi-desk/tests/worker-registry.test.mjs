import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { serveWorker } from "../src/host/worker-runtime.ts";
import { WorkerChannel } from "../src/host/worker-channel.ts";
import { attachWorker, readWorkerRecord, waitWorkerStopped, workerLease, writeWorkerFile } from "../src/host/worker-registry.ts";

const source = name => new URL(`../src/host/${name}.ts`, import.meta.url).href;
function inbox() {
	const waiting = new Map(), values = new Map();
	return {
		receive(message) {
			const yes = waiting.get(message.id)?.shift();
			if (yes) yes(message);
			else { const queue = values.get(message.id) ?? []; queue.push(message); values.set(message.id, queue); }
		},
		wait(id) {
			const value = values.get(id)?.shift();
			if (value) return Promise.resolve(value);
			return new Promise(resolve => { const queue = waiting.get(id) ?? []; queue.push(resolve); waiting.set(id, queue); });
		},
	};
}

test("a detached worker and its child survive host-process exit and keep their runtime and receipt", { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-worker-registry-")), directory = join(root, "actor");
	const fixture = join(root, "worker.mjs"), hostFixture = join(root, "host.mjs");
	await writeFile(fixture, `
import { serveWorker } from ${JSON.stringify(source("worker-runtime"))};
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const runtime = await serveWorker(process.argv[2], async send => {
 const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
 await once(child, 'spawn');
 let writes = 0, pin;
 const snapshot = () => ({ id: 'fixture-native-id', ui: { generation: 'fixture-generation' }, accounts: { codex: 'fixture-account' }, writes, pid: process.pid, child: child.pid, pin });
 return {
  async start(options) { pin = options.runtimeDirectory; return snapshot(); },
  snapshot,
  async command(_generation, command) {
   if (command.kind === 'snapshot') return snapshot();
   send({ type: 'event', event: { type: 'fixture-accepted' } });
   await new Promise(resolve => setTimeout(resolve, 250));
   return { ...snapshot(), writes: ++writes };
  },
  async checkpoint() {},
  async shutdownCheckpoint() { return snapshot(); },
  async close() { const exit = once(child, 'exit'); child.kill(); await exit; }
 };
});
process.on('SIGTERM', () => void runtime.stop());
runtime.closed.then(() => process.exit(0), () => process.exit(1));
`);
	await writeFile(hostFixture, `
import { attachWorker } from ${JSON.stringify(source("worker-registry"))};
const connection = await attachWorker(process.argv[2], { cwd: process.cwd(), runtimeDirectory: '/caller-override' },
 message => { if (message.type === 'event' && message.event.type === 'fixture-accepted') process.exit(0); }, () => {});
connection.channel.send({ type: 'command', id: 'accepted-work', generation: 'fixture-generation', command: { kind: 'name', name: 'Delayed' } });
`);
	const firstInbox = inbox();
	const first = await attachWorker(directory, { cwd: root, runtimeDirectory: "/caller-override" }, firstInbox.receive, () => {},
		{ module: fixture, runtimeDirectory: "/fixture/immutable-runtime" });
	assert.equal(first.created, true);
	let stopped = false;
	t.after(async () => {
		if (!stopped) {
			const rescueInbox = inbox();
			const rescue = await attachWorker(directory, { cwd: root }, rescueInbox.receive, () => {});
			rescue.channel.send({ type: "shutdown", id: "fixture-cleanup" });
			await rescueInbox.wait("fixture-cleanup");
			await waitWorkerStopped(directory, rescue.record.instance);
		}
		await rm(root, { recursive: true, force: true });
	});
	assert.equal(first.bootstrap.options.runtimeDirectory, "/fixture/immutable-runtime");
	first.channel.send({ type: "init", id: `init:${first.record.instance}`, options: first.bootstrap.options });
	const initialized = (await firstInbox.wait(`init:${first.record.instance}`)).value;
	assert.equal(initialized.pin, "/fixture/immutable-runtime");
	await first.channel.detach();
	const host = spawn(process.execPath, [hostFixture, directory], { stdio: "ignore" });
	const [code, signal] = await once(host, "exit");
	assert.equal(code, 0);
	assert.equal(signal, null);
	const nextInbox = inbox();
	const next = await attachWorker(directory, { cwd: root, runtimeDirectory: "/new-default" }, nextInbox.receive, () => {},
		{ module: fixture, runtimeDirectory: "/new-default" });
	assert.equal(next.created, false);
	assert.equal(next.record.pid, first.record.pid);
	assert.equal(next.record.instance, first.record.instance);
	assert.equal(next.record.runtimeDirectory, "/fixture/immutable-runtime");
	process.kill(initialized.pid, 0);
	process.kill(initialized.child, 0);
	next.channel.send({ type: "command", id: "accepted-work", generation: "fixture-generation", command: { kind: "name", name: "Delayed" } });
	const recovered = (await nextInbox.wait("accepted-work")).value;
	assert.equal(recovered.writes, 1);
	assert.equal(recovered.pid, initialized.pid);
	assert.equal(recovered.child, initialized.child);
	assert.equal(recovered.pin, initialized.pin);
	next.channel.send({ type: "command", id: "snapshot", generation: "fixture-generation", command: { kind: "snapshot" } });
	assert.equal((await nextInbox.wait("snapshot")).value.writes, 1);
	next.channel.send({ type: "shutdown", id: "shutdown" });
	assert.equal((await nextInbox.wait("shutdown")).value.pid, initialized.pid);
	await waitWorkerStopped(directory, next.record.instance);
	stopped = true;
	assert.equal(readWorkerRecord(directory), undefined);
	await next.channel.detach();
});

test("cold engine loading starts only after authenticated initialization", { timeout: 20000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-worker-cold-")), directory = join(root, "actor");
	const fixture = join(root, "worker.mjs"), started = join(root, "engine-started");
	await writeFile(fixture, `
import { serveWorker } from ${JSON.stringify(source("worker-runtime"))};
import { writeFileSync } from 'node:fs';
const runtime = await serveWorker(process.argv[2], async () => {
 writeFileSync(${JSON.stringify(started)}, 'started');
 const until = Date.now() + 6000;
 while (Date.now() < until) {}
 const snapshot = () => ({ id: 'cold-native-id', ui: { generation: 'cold-generation' } });
 return { async start() { return snapshot(); }, snapshot, async command() {}, async checkpoint() {},
  async shutdownCheckpoint() { return snapshot(); }, async close() {} };
});
runtime.closed.then(() => process.exit(0), () => process.exit(1));
`);
	let stopped = false;
	t.after(async () => {
		if (!stopped && readWorkerRecord(directory)) {
			const rescueInbox = inbox();
			const rescue = await attachWorker(directory, { cwd: root }, rescueInbox.receive, () => {}, { adoptOnly: true });
			rescue.channel.send({ type: "shutdown", id: "cold-cleanup", force: true });
			await rescueInbox.wait("cold-cleanup");
			await waitWorkerStopped(directory, rescue.record.instance);
		}
		await rm(root, { recursive: true, force: true });
	});
	const messages = inbox();
	const connection = await attachWorker(directory, { cwd: root }, messages.receive, () => {}, { module: fixture });
	assert.equal(existsSync(started), false);
	connection.channel.send({ type: "describe", id: "before-init" });
	assert.equal((await messages.wait("before-init")).value.snapshot, undefined);
	assert.equal(existsSync(started), false);
	connection.channel.send({ type: "init", id: "cold-init", options: connection.bootstrap.options });
	assert.equal((await messages.wait("cold-init")).value.id, "cold-native-id");
	assert.equal(existsSync(started), true);
	connection.channel.send({ type: "shutdown", id: "cold-shutdown" });
	await messages.wait("cold-shutdown");
	await waitWorkerStopped(directory, connection.record.instance);
	stopped = true;
	await connection.channel.detach();
});

test("an unopened worker can shut down without loading the engine", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-worker-unopened-"));
	writeWorkerFile(root, "bootstrap.json", { version: 1, instance: randomUUID(), secret: randomBytes(32).toString("hex"), options: { cwd: root } });
	let loads = 0;
	const runtime = await serveWorker(root, async () => { loads++; throw new Error("Native loading was not requested."); });
	t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
	const messages = inbox();
	const channel = await WorkerChannel.connect(runtime.endpoint.address, messages.receive, () => {});
	channel.send({ type: "shutdown", id: "unopened-shutdown" });
	assert.equal((await messages.wait("unopened-shutdown")).error, undefined);
	await runtime.closed;
	assert.equal(loads, 0);
	assert.equal(readWorkerRecord(root), undefined);
	await channel.detach();
});

test("worker failures retain a diagnostic without environment variables or network details", { timeout: 20000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-worker-diagnostic-"));
	const fixture = join(root, "worker.mjs");
	await writeFile(fixture, `
import { serveWorker } from ${JSON.stringify(source("worker-runtime"))};
const runtime = await serveWorker(process.argv[2], async () => {
 const snapshot = () => ({ id: 'diagnostic-native-id', ui: { generation: 'diagnostic-generation' } });
 return { async start(options) { if (options.sessionFile === 'startup-failure') throw new Error('fixture initialization failed'); return snapshot(); }, snapshot,
  async command() { setImmediate(() => { throw new Error('fixture uncaught failure'); }); },
  async checkpoint() {}, async shutdownCheckpoint() {}, async close() {} };
});
runtime.closed.then(() => process.exit(0), () => process.exit(1));
`);
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const startup of [false, true]) await t.test(startup ? "initialization failure" : "uncaught failure", async t => {
		const directory = join(root, startup ? "startup" : "uncaught"), messages = inbox();
		let disconnected, detached = false; const closed = new Promise(resolve => { disconnected = resolve; });
		const connection = await attachWorker(directory, { cwd: root, ...(startup ? { sessionFile: "startup-failure" } : {}) },
			messages.receive, () => { detached = true; disconnected(); }, { module: fixture });
		t.after(async () => {
			if (!detached) connection.channel.send({ type: "shutdown", id: "cleanup", force: true });
			await closed;
			await connection.channel.detach();
			// Channel closure precedes process exit, which releases its Windows cwd handle.
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				try { process.kill(connection.record.pid, 0); }
				catch (error) { if (error.code === "ESRCH") return; throw error; }
				await delay(10);
			}
			assert.fail("The diagnostic fixture did not exit.");
		});
		connection.channel.send({ type: "init", id: "init", options: connection.bootstrap.options });
		const initialized = await messages.wait("init");
		if (startup) {
			assert.match(initialized.error, /fixture initialization failed/);
			connection.channel.send({ type: "shutdown", id: "shutdown", force: true });
			await closed;
		} else {
			assert.equal(initialized.value.id, "diagnostic-native-id");
			connection.channel.send({ type: "command", id: "crash", generation: "diagnostic-generation", command: { kind: "name", name: "fixture" } });
			await closed;
		}
		const report = JSON.parse(await readFile(join(directory, "failure.json"), "utf8"));
		assert.equal(report.header.processId, connection.record.pid);
		assert.match(report.javascriptStack.message, startup ? /fixture initialization failed/ : /fixture uncaught failure/);
		assert.equal(report.environmentVariables, undefined);
		assert.equal(report.header.networkInterfaces, undefined);
		assert(report.javascriptHeap.memoryLimit > 0);
	});
});

test("an occupied actor lease or unresolved launch cannot create a second worker", async () => {
	const root = await mkdtemp(join(tmpdir(), "desk-worker-occupied-"));
	const lease = workerLease(root);
	try {
		await assert.rejects(attachWorker(root, { cwd: root }, () => {}, () => {}, { module: "/not-launched.mjs" }), /unconfirmed/);
	} finally { lease.close(); }
	writeWorkerFile(root, "bootstrap.json", { version: 1, instance: randomUUID(), secret: randomBytes(32).toString("hex"), options: { cwd: root } });
	try {
		await assert.rejects(attachWorker(root, { cwd: root }, () => {}, () => {}, { module: "/not-launched.mjs" }), /unconfirmed/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
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

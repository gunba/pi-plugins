import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { SessionWorker } from "../src/host/worker-client.ts";
import { WorkerConnectionError, StaleGeneration } from "../src/host/worker-errors.ts";

test("concurrent retries share one IPC request and neither caller loses its reply", async (t) => {
	const child = new EventEmitter();
	const sent = [];
	child.send = (request, done) => { sent.push(request); done(null); };
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const worker = new SessionWorker({ cwd: process.cwd() }, () => {});
	const first = worker.command({ kind: "name", name: "Example" }, "generation", "same-id");
	const second = worker.command({ kind: "name", name: "Example" }, "generation", "same-id");
	assert.equal(sent.length, 1);
	await assert.rejects(worker.command({ kind: "name", name: "Different" }, "generation", "same-id"), /different contents/);
	child.emit("message", { type: "result", id: "same-id", value: "saved" });
	assert.deepEqual(await Promise.all([first, second]), ["saved", "saved"]);
});

test("long controls return admission, retain outcomes and do not repeat after generation changes", async t => {
	const child = new EventEmitter(), sent = [], events = [];
	child.send = (request, done) => { sent.push(request); done(null); };
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const worker = new SessionWorker({ cwd: process.cwd() }, event => events.push(event));
	worker.generation = "before";
	assert.equal(worker.submitControl({ kind: "reload" }, "before", "reload").control.state, "running");
	assert.equal(worker.submitControl({ kind: "reload" }, "before", "reload").accepted, true);
	assert.equal(sent.length, 1);
	assert.throws(() => worker.submitControl({ kind: "fork", entry: "entry", position: "at" }, "before", "fork"), /already running/);
	worker.generation = "after";
	child.emit("message", { type: "result", id: "reload", value: {} });
	await new Promise(setImmediate);
	assert.equal(worker.submitControl({ kind: "reload" }, "before", "reload").control.state, "completed");
	assert.equal(sent.length, 1, "completed retries do not submit another IPC request");
	assert.throws(() => worker.submitControl({ kind: "reload" }, "before", "new"), StaleGeneration);
	assert.equal(events.filter(event => event.type === "control").at(-1).control.state, "completed");

	worker.submitControl({ kind: "compact" }, "after", "compact");
	const lost = worker.command({ kind: "prompt", text: "Not replayed" }, "after", "prompt").catch(error => error);
	child.emit("exit", null, "SIGKILL");
	assert.ok(await lost instanceof WorkerConnectionError);
	await new Promise(setImmediate);
	assert.equal(events.filter(event => event.type === "control").at(-1).control.state, "interrupted");
});

test("closing waits for worker exit after shutdown admission and IPC disconnect", async t => {
	const child = new EventEmitter();
	child.connected = true;
	child.send = (request, done) => { done(null); queueMicrotask(() => child.emit("message", { type: "result", id: request.id })); };
	child.disconnect = () => { child.connected = false; };
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const worker = new SessionWorker({ cwd: process.cwd() }, () => {});
	let finished = false;
	const closing = worker.close().then(() => { finished = true; });
	await new Promise(setImmediate);
	assert.equal(child.connected, false);
	assert.equal(finished, false);
	child.emit("exit", 0, null);
	await closing;
	assert.equal(finished, true);
});

test("worker loss before a close acknowledgement still invalidates the live session", async t => {
	const child = new EventEmitter(), events = [];
	child.send = (_request, done) => done(null);
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const worker = new SessionWorker({ cwd: process.cwd() }, event => events.push(event));
	worker.generation = "sample";
	worker.submitControl({ kind: "close" }, "sample", "close");
	child.emit("exit", null, "SIGKILL");
	await new Promise(setImmediate);
	assert.ok(events.some(event => event.type === "fatal"));
	assert.equal(events.filter(event => event.type === "control").at(-1).control.state, "interrupted");
});

test("closing before a presentation generation exists uses worker lifecycle IPC and waits for exit", async t => {
	const child = new EventEmitter(), sent = [], events = [];
	child.connected = true;
	child.send = (request, done) => { sent.push(request); done(null); };
	child.disconnect = () => { child.connected = false; };
	t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const worker = new SessionWorker({ cwd: process.cwd() }, event => events.push(event));
	assert.equal(worker.generation, "");
	assert.equal(worker.submitControl({ kind: "close" }, "", "close-before-start").control.state, "running");
	assert.equal(sent[0].type, "shutdown");
	assert.equal(Object.hasOwn(sent[0], "generation"), false);
	worker.generation = "a-later-presentation";
	assert.equal(worker.submitControl({ kind: "close" }, worker.generation, "close-before-start").control.state, "running");
	assert.equal(sent.length, 1);
	child.emit("message", { type: "result", id: sent[0].id });
	await new Promise(setImmediate);
	assert.equal(child.connected, false);
	assert.equal(events.at(-1).control.state, "running", "IPC disconnect is not process exit");
	child.emit("exit", 0, null);
	await new Promise(setImmediate);
	assert.equal(events.at(-1).control.state, "completed");
	assert.equal(events.some(event => event.type === "fatal"), false);
});

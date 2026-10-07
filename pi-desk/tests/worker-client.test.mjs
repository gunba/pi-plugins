import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionWorker } from "../src/host/worker-client.ts";
import { WorkerControls } from "../src/host/worker-controls.ts";
import { WorkerConnectionError, StaleGeneration } from "../src/host/worker-errors.ts";

const flush = () => new Promise(setImmediate);
function fixture(options = { cwd: process.cwd() }, event = () => {}) {
	const sent = [], operations = [];
	let receive, disconnect, release;
	const stopped = new Promise(resolve => { release = resolve; });
	const instance = randomUUID();
	const state = { generation: "before", detached: false, waited: false };
	const controlBook = new WorkerControls(() => state.generation, (command, id, generation) =>
		new Promise((resolve, reject) => operations.push({ command, id, generation, resolve, reject })), control => receive({ type: "control", control }));
	const channel = {
		send(request) {
			sent.push(request);
			if (request.type === "describe") receive({ type: "result", id: request.id, value: { snapshot: { ui: { generation: state.generation } }, controls: controlBook.snapshot() } });
			if (request.type === "control") {
				try { receive({ type: "result", id: request.id, value: controlBook.submit(request.command, request.generation, request.id) }); }
				catch (error) { receive({ type: "result", id: request.id, error: error.message, code: error instanceof StaleGeneration ? "stale_generation" : "receipt_conflict" }); }
			}
		},
		async detach() { state.detached = true; disconnect(); },
	};
	const connections = {
		async attach(_directory, init, listener, lost, settings) {
			receive = listener; disconnect = lost;
			return { channel, record: { instance, runtimeDirectory: settings.runtimeDirectory }, created: true,
				bootstrap: { options: { ...init, runtimeDirectory: settings.runtimeDirectory } } };
		},
		async waitStopped() { state.waited = true; await stopped; },
	};
	const worker = new SessionWorker(options, event, { directory: "/fixture", key: "worker" }, connections);
	return { worker, sent, operations, state, release, instance, receive: message => receive(message), disconnect: () => disconnect() };
}

test("the host pins initialization in the bootstrap rather than accepting a caller override", async t => {
	const before = process.env.PI_DESK_RUNTIME;
	process.env.PI_DESK_RUNTIME = "/fixture/host-runtime";
	t.after(() => { if (before === undefined) delete process.env.PI_DESK_RUNTIME; else process.env.PI_DESK_RUNTIME = before; });
	const f = fixture({ cwd: process.cwd(), runtimeDirectory: "/untrusted/override" });
	const ready = f.worker.start();
	await flush();
	assert.equal(f.sent[0].options.runtimeDirectory, "/fixture/host-runtime");
	assert.equal(f.sent[0].id, `init:${f.instance}`);
	f.receive({ type: "result", id: f.sent[0].id, value: { ui: { generation: "before" } } });
	await ready;
	assert.equal(f.worker.runtimeDirectory, "/fixture/host-runtime");
});

test("concurrent retries share one request and neither caller loses its reply", async () => {
	const f = fixture();
	const first = f.worker.command({ kind: "name", name: "Example" }, "generation", "same-id");
	const second = f.worker.command({ kind: "name", name: "Example" }, "generation", "same-id");
	await flush();
	assert.equal(f.sent.length, 1);
	await assert.rejects(f.worker.command({ kind: "name", name: "Different" }, "generation", "same-id"), /different contents/);
	f.receive({ type: "result", id: "same-id", value: "saved" });
	assert.deepEqual(await Promise.all([first, second]), ["saved", "saved"]);
});

test("long-control admission and outcomes belong to the worker across generation changes", async () => {
	const events = [], f = fixture(undefined, event => events.push(event));
	assert.equal((await f.worker.submitControl({ kind: "reload" }, "before", "reload")).control.state, "running");
	assert.equal((await f.worker.submitControl({ kind: "reload" }, "before", "reload")).accepted, true);
	assert.equal(f.operations.length, 1);
	await assert.rejects(f.worker.submitControl({ kind: "fork", entry: "entry", position: "at" }, "before", "fork"), /already running/);
	f.state.generation = "after";
	f.operations[0].resolve();
	await flush();
	assert.equal((await f.worker.submitControl({ kind: "reload" }, "before", "reload")).control.state, "completed");
	assert.equal(f.operations.length, 1);
	await assert.rejects(f.worker.submitControl({ kind: "reload" }, "before", "new"), StaleGeneration);
	assert.equal(events.filter(event => event.type === "control").at(-1).control.state, "completed");
});

test("explicit close waits for worker lease release after shutdown acknowledgement", async () => {
	const f = fixture();
	let finished = false;
	const closing = f.worker.close().then(() => { finished = true; });
	await flush();
	assert.equal(f.sent[0].type, "shutdown");
	f.receive({ type: "result", id: f.sent[0].id });
	await flush();
	assert.equal(f.state.waited, true);
	assert.equal(finished, false);
	f.release();
	await closing;
	assert.equal(f.state.detached, true);
	assert.equal(finished, true);
});

test("connection loss leaves work outcomes unconfirmed instead of sending shutdown", async () => {
	const events = [], f = fixture(undefined, event => events.push(event));
	const lost = f.worker.command({ kind: "prompt", text: "Not replayed" }, "before", "prompt").catch(error => error);
	await flush();
	f.disconnect();
	assert.ok(await lost instanceof WorkerConnectionError);
	assert.ok(events.some(event => event.type === "detached"));
	assert.equal(f.sent.some(request => request.type === "shutdown"), false);
});

test("intentional host detach does not send shutdown or report worker failure", async () => {
	const events = [], f = fixture(undefined, event => events.push(event));
	await f.worker.detach();
	assert.equal(f.state.detached, true);
	assert.equal(f.sent.length, 0);
	assert.equal(events.some(event => event.type === "fatal" || event.type === "detached"), false);
});

test("closing before presentation exists has worker-owned admission and does not repeat on generation change", async () => {
	const events = [], f = fixture(undefined, event => events.push(event));
	assert.equal(f.worker.generation, "");
	assert.equal((await f.worker.submitControl({ kind: "close" }, "", "close-before-start")).control.state, "running");
	await flush();
	f.worker.generation = "later";
	assert.equal((await f.worker.submitControl({ kind: "close" }, "later", "close-before-start")).control.state, "running");
	assert.equal(f.operations.length, 1);
	f.operations[0].resolve();
	await flush();
	f.disconnect();
	assert.equal(events.some(event => event.type === "fatal" || event.type === "detached"), false);
	assert.equal(events.filter(event => event.type === "control").at(-1).control.state, "completed");
});

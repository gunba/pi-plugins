import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { Attachments } from "../src/host/attachments.ts";
import { WorkerConnectionError } from "../src/host/worker-errors.ts";
import { API_HEADER, API_VERSION } from "../src/shared/release.ts";

async function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "desk-input-")), dataDir = join(dir, "desk");
	const host = new DeskHost({ cwd: dir, agentDir: dir, dataDir, port: 0 });
	await host.start();
	t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });
	const key = randomUUID(), activation = randomUUID(), generation = randomUUID(), calls = [];
	const worker = { generation: "", command: async (command, generation, id) => { calls.push({ command, generation, id }); return { accepted: true }; }, close: async () => {} };
	const managed = { view: { key, activation, cwd: dir, created: Date.now(), state: "starting" }, worker };
	host.sessions.set(key, managed);
	const token = JSON.parse(readFileSync(join(dataDir, "access.json"))).operator;
	const request = async (path, body, method = body === undefined ? "GET" : "POST") => {
		const response = await fetch(`${host.origin}/api/sessions/${key}/${path}`, {
			method, headers: { Authorization: `Bearer ${token}`, [API_HEADER]: String(API_VERSION), "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: await response.json() };
	};
	const input = (text, extra = {}) => ({ id: randomUUID(), activation, command: { kind: "prompt", text }, ...extra });
	const ready = async () => {
		worker.generation = generation; managed.initialized = true; managed.initialGeneration = generation;
		managed.view = { ...managed.view, state: "ready", ui: { generation } };
		host.drainInputs(managed); await managed.draining;
	};
	return { dir, dataDir, host, key, activation, generation, worker, managed, calls, request, input, ready };
}

test("text and files are admitted before Pi exists, cancellable, then delivered once to the initialized generation", async t => {
	const f = await fixture(t);
	const upload = command => f.request("uploads", { activation: f.activation, command });
	const { body: { result: { id } } } = await upload({ kind: "upload_begin", name: "notes.txt", size: 5 });
	assert.equal((await upload({ kind: "upload_chunk", id, offset: 0, base64: Buffer.from("hello").toString("base64") })).status, 200);
	assert.equal((await upload({ kind: "upload_finish", id })).status, 200);
	const first = f.input("Read the attachment", { command: { kind: "prompt", text: "Read the attachment", attachments: [id] } });
	const second = f.input("Then summarize");
	assert.equal((await f.request("inputs", first)).status, 202);
	assert.equal((await f.request("inputs", second)).status, 202);
	assert.equal(f.managed.view.inputs.length, 2);
	assert.equal(f.managed.view.inputs[0].state, "queued");
	assert.equal(f.calls.length, 0);
	assert.equal((await upload({ kind: "upload_discard", id })).status, 400, "queued input owns the completed file");
	assert.equal((await f.request(`inputs/${second.id}/cancel`, {})).status, 200);
	assert.equal((await f.request("inputs", second)).body.input.state, "cancelled");
	assert.equal((await f.request("inputs", first)).body.input.state, "queued", "lost admission response can be reconciled by receipt");
	assert.equal((await f.request("inputs", { ...first, command: { kind: "prompt", text: "Different" } })).status, 409);
	await f.ready();
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].generation, f.generation);
	assert.equal(f.calls[0].id, first.id);
	assert.equal(f.calls[0].command.behavior, "followUp");
	assert.match(new Attachments(f.dir, f.key).prepare([id], false).text, /notes.txt/);
	assert.equal((await upload({ kind: "upload_discard", id })).status, 400, "native input may have observed the file");
	assert.equal((await f.request("inputs", first)).body.input.state, "accepted");
	assert.equal(f.calls.length, 1);
	assert.deepEqual(f.managed.view.inputs, []);
	assert.equal((await f.request(`inputs/${first.id}`)).body.command, undefined, "no second store of accepted message bodies");
});

test("cancellation releases an undispatched file; startup failure preserves recoverable text and files across host restart", async t => {
	const f = await fixture(t);
	const { body: { result: { id } } } = await f.request("uploads", { activation: f.activation, command: { kind: "upload_begin", name: "empty.txt", size: 0 } });
	await f.request("uploads", { activation: f.activation, command: { kind: "upload_finish", id } });
	const input = f.input("", { command: { kind: "prompt", text: "", attachments: [id] } });
	await f.request("inputs", input);
	await f.request(`inputs/${input.id}/cancel`, {});
	assert.equal((await f.request("uploads", { activation: f.activation, command: { kind: "upload_discard", id } })).status, 200);
	const { body: { result: { id: keptFile } } } = await f.request("uploads", { activation: f.activation, command: { kind: "upload_begin", name: "kept.txt", size: 0 } });
	await f.request("uploads", { activation: f.activation, command: { kind: "upload_finish", id: keptFile } });
	const retained = f.input("Keep this draft", { command: { kind: "prompt", text: "Keep this draft", attachments: [keptFile] } });
	await f.request("inputs", retained);
	await f.host.close();
	const restarted = new DeskHost({ cwd: f.dir, agentDir: f.dir, dataDir: f.dataDir, port: 0 });
	try {
		await restarted.start();
		const session = restarted.state().sessions.find(session => session.key === f.key);
		assert.equal(session.state, "closed");
		assert.ok(session.activation);
		assert.notEqual(session.activation, f.activation);
		assert.equal(session.interrupted, true);
		assert.equal(session.inputs[0].state, "failed");
		assert.match(session.inputs[0].error, /not retried/);
		assert.equal(restarted.inputs.read(f.key, retained.id).command.text, "Keep this draft");
		assert.throws(() => restarted.attachments(f.key).command({ kind: "upload_discard", id: keptFile }), /references/);
		assert.match(restarted.attachments(f.key).prepare([keptFile], false).text, /kept.txt/);
		assert.equal(restarted.sessions.get(f.key).worker, undefined);
		assert.equal(f.calls.length, 0);
	} finally { await restarted.close(); }
});

test("uncertain native admission is retained and never replayed by a duplicate request or reconnect", async t => {
	const f = await fixture(t);
	const input = f.input("Do work"), following = f.input("More work");
	await f.request("inputs", input); await f.request("inputs", following);
	let calls = 0;
	f.worker.command = async () => { calls++; throw new WorkerConnectionError("Worker connection lost."); };
	await f.ready();
	assert.equal(calls, 1);
	assert.equal((await f.request("inputs", input)).body.input.state, "interrupted");
	assert.equal((await f.request("inputs", following)).body.input.state, "failed");
	assert.equal((await f.request(`inputs/${input.id}/cancel`, {})).status, 409);
	f.host.drainInputs(f.managed); await f.managed.draining;
	assert.equal(calls, 1);
	assert.equal((await f.request(`inputs/${input.id}`)).body.command.text, "Do work");
});

test("stale activations, native generation changes, denied access and pending controls cannot redirect queued input", async t => {
	const f = await fixture(t);
	assert.equal((await f.request("inputs", f.input("Wrong worker", { activation: randomUUID() }))).status, 409);
	assert.equal((await f.request("uploads", { activation: randomUUID(), command: { kind: "upload_begin", name: "bad", size: 1 } })).status, 409);
	const denied = await f.host.api({ authorized: () => false }, {
		method: "POST", path: `/api/sessions/${f.key}/inputs`, body: f.input("Unauthorized"),
	});
	assert.equal(denied.status, 401);
	await f.ready();
	const input = f.input("Original branch", { generation: f.generation });
	f.managed.view.controls = [{ state: "running" }];
	assert.equal((await f.request("inputs", input)).status, 400);
	f.managed.view.controls = [];
	// Hold dispatch, admit to the original generation, then change the native branch.
	f.managed.initialized = false;
	await f.request("inputs", input);
	f.worker.generation = randomUUID(); f.managed.initialized = true;
	f.host.drainInputs(f.managed); await f.managed.draining;
	assert.equal(f.calls.length, 0);
	assert.equal((await f.request(`inputs/${input.id}`)).body.status.state, "failed");
	assert.equal((await f.request("command", { id: randomUUID(), generation: f.generation, command: input.command })).status, 400, "no bypass of admission through the old command route");
});

test("close binds the worker activation before touching pending input, even before a native generation exists", async t => {
	const f = await fixture(t);
	await f.request("inputs", f.input("Not sent yet"));
	let closes = 0;
	f.worker.submitControl = (command, generation, id) => {
		closes++;
		return { accepted: true, control: { id, generation, kind: command.kind, state: "running", started: Date.now() } };
	};
	assert.equal((await f.request("close", { id: randomUUID(), activation: randomUUID() })).status, 409);
	assert.equal((await f.request("close", { id: randomUUID() })).status, 400);
	assert.equal(closes, 0);
	assert.equal(f.managed.view.inputs[0].state, "queued");
	assert.equal((await f.request("close", { id: randomUUID(), activation: f.activation })).status, 202);
	assert.equal(closes, 1);
	assert.equal(f.managed.view.inputs[0].state, "failed");
	assert.match(f.managed.view.inputs[0].error, /not retried/);
});

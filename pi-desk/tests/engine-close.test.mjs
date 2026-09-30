import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, watch, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeskEngine } from "../src/host/engine.ts";
import { SessionLease } from "../../pi-session-ownership/lease.ts";

test("overlapping shutdown callers await the same cleanup, including failure", async () => {
	const messages = [], engine = new DeskEngine(message => messages.push(message));
	let release, entered, calls = 0, secondDone = false;
	const gate = new Promise(resolve => { release = resolve; });
	const started = new Promise(resolve => { entered = resolve; });
	engine.runtime = { dispose: async () => { calls++; entered(); await gate; throw new Error("Cleanup failed"); } };
	const first = engine.close(); void first.catch(() => {});
	await started;
	const second = engine.close().finally(() => { secondDone = true; }); void second.catch(() => {});
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(secondDone, false);
	release();
	await assert.rejects(first, /Cleanup failed/);
	await assert.rejects(second, /Cleanup failed/);
	assert.equal(calls, 1);
	assert.equal(messages.filter(message => message.type === "fatal").length, 1);
	assert.equal(await engine.presentation.request({ kind: "input", title: "Late request" }), null);
});

test("close aborts active work but retains lifecycle ownership until a transition finishes", async () => {
	const engine = new DeskEngine(() => {});
	let release, disposed = false, aborted = false, ended = false;
	engine.snapshot = () => ({});
	engine.runtime = {
		session: { isCompacting: false, abortCompaction() {}, abortBranchSummary() {}, abort: async () => { aborted = true; } },
		dispose: async () => { disposed = true; },
	};
	const transition = engine.change(() => new Promise(resolve => { release = resolve; }));
	await Promise.resolve();
	const closing = engine.close().then(() => { ended = true; });
	await new Promise(setImmediate);
	assert.equal(aborted, true);
	assert.equal(disposed, false);
	assert.equal(ended, false);
	assert.equal(await engine.presentation.request({ kind: "input", title: "Late question" }), null);
	release();
	await transition; await closing;
	assert.equal(disposed, true);
	assert.equal(ended, true);
	await assert.rejects(engine.change(async () => assert.fail("A closed runtime must not start another transition")), /closing/);
});

test("explicit Stop starts a native turn for stranded steering, but never during closure", async () => {
	const engine = new DeskEngine(() => {}), steering = ["No need", "I uploaded it"], calls = [];
	engine.snapshot = () => ({});
	const session = {
		isIdle: true, abortCompaction() {}, abortBranchSummary() {}, abort: async () => {},
		getSteeringMessages: () => steering,
		sendCustomMessage: async (message, options) => { calls.push({ message, options }); },
	};
	engine.runtime = { session, dispose: async () => {} };
	try {
		await engine.command(engine.presentation.generation, { kind: "abort" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].message.display, false);
		assert.equal(calls[0].options.triggerTurn, true);
		assert.deepEqual(steering, ["No need", "I uploaded it"], "native queues, including their attachments, are not rebuilt from text");
		steering.length = 0;
		await engine.command(engine.presentation.generation, { kind: "abort" });
		assert.equal(calls.length, 1, "Stop without steering remains stopped");
		steering.push("late"); session.abort = async () => { engine.closed = true; };
		await engine.command(engine.presentation.generation, { kind: "abort" });
		assert.equal(calls.length, 1, "closure cannot launch another model turn");
	} finally { engine.closed = false; await engine.close(); }
});

test("native shutdown hooks can settle a tool that is still aborting", async () => {
	const engine = new DeskEngine(() => {});
	let release, disposed = false;
	engine.runtime = {
		session: { abortCompaction() {}, abortBranchSummary() {}, abort: () => new Promise(resolve => { release = resolve; }) },
		dispose: async () => { disposed = true; release(); },
	};
	await engine.close();
	assert.equal(disposed, true);
});

test("closing during SDK discovery retains the writer until late startup cleanup", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-start-close-")), agent = join(root, "agent"), sessions = join(root, "sessions");
	for (const directory of [join(agent, "extensions"), sessions]) mkdirSync(directory, { recursive: true });
	const entered = join(root, "entered"), release = join(root, "release");
	writeFileSync(join(agent, "extensions", "gate.ts"), `import {existsSync,writeFileSync,watch} from "node:fs";
export default async function(){writeFileSync(${JSON.stringify(entered)},"ready");await new Promise(resolve=>{
 const watcher=watch(${JSON.stringify(root)},()=>{if(existsSync(${JSON.stringify(release)})){watcher.close();resolve()}});
});}`);
	const oldAgent = process.env.PI_CODING_AGENT_DIR, engine = new DeskEngine(() => {});
	let timer, watcher, result, closing;
	const waiting = new Promise((resolve, reject) => {
		watcher = watch(root, () => { if (existsSync(entered)) resolve(); });
		timer = setTimeout(() => reject(Error("Startup did not reach its gate")), 10_000);
	});
	try {
		result = engine.start({ cwd: root, agentDir: agent, sessionDir: sessions }).catch(error => error);
		await waiting; clearTimeout(timer); watcher.close();
		const file = join(sessions, readdirSync(sessions).find(file => file.endsWith(".jsonl")));
		let closed = false;
		closing = engine.close().then(() => { closed = true; });
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(closed, false);
		assert.throws(() => new SessionLease(file), /already|owned|busy|locked/i);
		writeFileSync(release, "go");
		await closing;
		assert.match((await result).message, /cancelled/);
		const lease = new SessionLease(file); lease.close();
	} finally {
		clearTimeout(timer); watcher?.close(); writeFileSync(release, "go");
		await result; await closing; await engine.close();
		if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

test("resumed history is readable while SDK extensions are still loading", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-history-start-")), agent = join(root, "agent");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	const entered = join(root, "entered"), release = join(root, "release"), file = join(root, "session.jsonl");
	const header = { type: "session", version: 3, id: "history-start", cwd: root, timestamp: new Date().toISOString() };
	const entries = Array.from({ length: 90 }, (_, i) => ({ type: "message", id: `entry${i}`,
		parentId: i ? `entry${i - 1}` : null, timestamp: header.timestamp,
		message: { role: "user", content: `Message ${i}`, timestamp: i } }));
	writeFileSync(file, [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n");
	writeFileSync(join(agent, "extensions", "gate.ts"), `import {existsSync,writeFileSync,watch} from "node:fs";
export default async function(){writeFileSync(${JSON.stringify(entered)},"ready");await new Promise(resolve=>{
 const watcher=watch(${JSON.stringify(root)},()=>{if(existsSync(${JSON.stringify(release)})){watcher.close();resolve()}});
});}`);
	const oldAgent = process.env.PI_CODING_AGENT_DIR, events = [], engine = new DeskEngine(event => events.push(event));
	let timer, watcher, result, closing;
	const waiting = new Promise((resolve, reject) => {
		watcher = watch(root, () => { if (existsSync(entered)) resolve(); });
		timer = setTimeout(() => reject(Error("Startup did not reach its gate")), 10_000);
	});
	try {
		result = engine.start({ cwd: root, agentDir: agent, sessionFile: file }).catch(error => error);
		await waiting; clearTimeout(timer); watcher.close();
		const generation = engine.presentation.generation;
		const tail = await engine.command(generation, { kind: "history" });
		assert.equal(tail.messages.length, 40);
		assert.equal(tail.messages.at(-1).entryId, "entry89");
		assert.equal(tail.before, "entry50");
		assert.ok(events.some(event => event.type === "history_ready" && event.generation === generation));
		assert.equal(events.some(event => event.type === "snapshot"), false);
		assert.equal((await engine.command(generation, { kind: "history", before: tail.before })).messages.length, 40);
		await assert.rejects(engine.command(generation, { kind: "prompt", text: "not yet" }), /unavailable/);
	} finally {
		clearTimeout(timer); watcher?.close();
		closing = engine.close();
		writeFileSync(release, "go");
		await result; await closing;
		if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

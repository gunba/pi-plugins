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

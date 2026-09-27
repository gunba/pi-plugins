import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskEngine } from "../src/host/engine.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { materializeSession } from "../src/host/session-storage.ts";

test("private extension records are not forwarded as browser events", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-records-"));
	const cwd = join(directory, "project"), agentDir = join(directory, "agent");
	mkdirSync(cwd); mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "private.ts"), `export default function(pi) {
		pi.on("session_start", () => pi.appendEntry("private-provider-state", {payload:"PRIVATE_RECORD_SENTINEL"}));
	}`);
	const previous = process.env.PI_CODING_AGENT_DIR, events = [];
	const engine = new DeskEngine(event => events.push(event));
	try {
		await engine.start({ cwd, agentDir });
		assert.ok(!JSON.stringify(events).includes("PRIVATE_RECORD_SENTINEL"));
	} finally {
		await engine.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("SDK fork and reload retain working native UI bindings", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-reload-"));
	const cwd = join(directory, "project"), agentDir = join(directory, "agent");
	mkdirSync(cwd); mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "question.ts"), `export default function(pi) {
		pi.on("session_start", (_, ctx) => {
			const request = {}; pi.events.emit("pi-ui/discover-v2", request);
			request.presentation.publish("probe", {kind:"details",title:"Probe",data:{},actions:[{id:"confirm",label:"Confirm"}]},
				{confirm:()=>ctx.ui.confirm("Reload check","Continue?")});
		});
	}`);
	const previous = process.env.PI_CODING_AGENT_DIR;
	const engine = new DeskEngine(() => {});
	try {
		const manager = SessionManager.create(cwd, join(directory, "sessions"));
		const lease = new SessionLease(manager.getSessionFile());
		let entry;
		try {
			entry = manager.appendMessage({ role: "user", content: "Fork draft", timestamp: Date.now() });
			materializeSession(manager);
		} finally { lease.close(); }
		await engine.start({ cwd, agentDir, sessionFile: manager.getSessionFile() });
		for (const operation of [{ kind: "fork", entry }, { kind: "reload" }]) {
			await engine.command(engine.presentation.generation, operation);
			if (operation.kind === "fork") assert.equal(engine.presentation.snapshot().editorText, "Fork draft");
			const view = engine.presentation.snapshot().views.find(view => view.id === "probe");
			const admission = await engine.command(engine.presentation.generation, { kind: "action", view: "probe", revision: view.revision, action: "confirm" });
			assert.deepEqual(admission, { accepted: true });
			const question = engine.presentation.snapshot().interactions[0];
			assert.ok(question, "the new extension must be able to ask through the native UI");
			engine.presentation.answer(question.id, { kind: "confirm", confirmed: true });
			await new Promise(setImmediate);
			assert.equal(engine.presentation.snapshot().interactions.length, 0);
			assert.equal(engine.presentation.snapshot().views.find(view => view.id === "probe").working, undefined);
		}
	} finally {
		await engine.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a registered command can wait for input without holding its admission response", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-command-"));
	const cwd = join(directory, "project"), agentDir = join(directory, "agent");
	mkdirSync(cwd); mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "question.ts"), `export default function(pi) {
		pi.registerCommand("sample", {handler: async (_, ctx) => { await ctx.ui.input("Response sample"); }});
	}`);
	const previous = process.env.PI_CODING_AGENT_DIR, engine = new DeskEngine(() => {});
	try {
		await engine.start({ cwd, agentDir });
		let receipt;
		const dispatched = engine.command(engine.presentation.generation, { kind: "prompt", text: "/sample" })
			.then(result => { receipt = result; });
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(receipt, { accepted: true });
		const question = engine.presentation.snapshot().interactions[0];
		assert.equal(question.form.title, "Response sample");
		engine.presentation.answer(question.id, { kind: "freeform", text: "A note" });
		await dispatched;
	} finally {
		await engine.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

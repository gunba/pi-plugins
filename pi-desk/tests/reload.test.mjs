import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
		const original = readFileSync(manager.getSessionFile());
		const exported = join(directory, "Native export.jsonl");
		await assert.rejects(engine.command(engine.presentation.generation, { kind: "prompt", text: "/export accidental-model-text" }), /Pi command, not a message/);
		assert.equal(await engine.command(engine.presentation.generation, { kind: "native_read", name: "copy", args: "" }), "");
		assert.equal((await engine.command(engine.presentation.generation, { kind: "native", name: "export", args: `"${exported}"` })).path, exported);
		assert.ok(readFileSync(exported, "utf8").includes("Fork draft"));
		await engine.command(engine.presentation.generation, { kind: "native", name: "clone", args: "" });
		assert.notEqual(engine.snapshot().file, manager.getSessionFile());
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
		const beforeImport = engine.snapshot().file;
		await engine.command(engine.presentation.generation, { kind: "native", name: "import", args: `"${exported}"` });
		assert.notEqual(engine.snapshot().file, beforeImport);
		assert.equal((await engine.command(engine.presentation.generation, { kind: "native_read", name: "session", args: "" })).sessionId, engine.snapshot().id);
		assert.deepEqual(readFileSync(manager.getSessionFile()), original, "the source history stays unchanged");
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

test("retrying extension loading after a resume timeout preserves the native conversation without sending a prompt", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-load-retry-"));
	const cwd = join(directory, "project"), agentDir = join(directory, "agent"), marker = join(directory, "available");
	mkdirSync(cwd); mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "identity.ts"), `import {existsSync} from "node:fs";
		export default function(pi) {
			if (!existsSync(${JSON.stringify(marker)})) throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {code:"ETIMEDOUT"});
			pi.registerCommand("loaded-proof", {handler: async () => {}});
		}`);
	const previous = process.env.PI_CODING_AGENT_DIR, engine = new DeskEngine(() => {});
	try {
		const manager = SessionManager.create(cwd, join(directory, "sessions")), file = manager.getSessionFile();
		const lease = new SessionLease(file);
		try {
			manager.appendMessage({ role: "user", content: "Saved conversation", timestamp: Date.now() });
			materializeSession(manager);
		} finally { lease.close(); }
		await engine.start({ cwd, agentDir, sessionFile: file });
		const before = engine.snapshot(), prefix = readFileSync(file);
		assert.equal(before.activity, "error");
		assert.match(before.extensions.find(extension => extension.error)?.error ?? "", /powershell.exe ETIMEDOUT/);
		assert.equal(before.commands.some(command => command.name === "loaded-proof"), false);
		engine.runtime.session.prompt = async () => assert.fail("recovery must not prompt the model");
		await assert.rejects(engine.command(engine.presentation.generation, { kind: "prompt", text: "Unsent draft" }), /extension load errors/);
		writeFileSync(marker, "");
		const after = await engine.command(engine.presentation.generation, { kind: "reload" });
		assert.equal(after.id, before.id);
		assert.equal(after.file, file);
		assert.equal(after.leaf, before.leaf);
		assert.equal(after.activity, "idle");
		assert.equal(after.extensions.some(extension => extension.error), false);
		assert.equal(after.commands.some(command => command.name === "loaded-proof"), true);
		assert.deepEqual(readFileSync(file), prefix, "loading again does not append messages or replace the saved branch");
	} finally {
		await engine.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

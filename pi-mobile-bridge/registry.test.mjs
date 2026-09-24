import assert from "node:assert/strict";
import { createServer } from "node:net";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { endpointPath, ensureRegistryDirectory, listSessions, removeSession, saveSession } from "./registry.ts";

test("registry updates do not replace a record held open by another process", async t => {
	const old = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-mobile-registry-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const server = createServer();
	t.after(async () => {
		if (server.listening) await new Promise(resolve => server.close(resolve));
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(agentDir, { recursive: true, force: true });
	});
	ensureRegistryDirectory();
	const id = "a".repeat(32);
	await new Promise((resolve, reject) => server.once("error", reject).listen(endpointPath(id), resolve));
	const record = state => ({ id, sessionId: "session-1", name: "Pi", cwd: agentDir, state, updatedAt: Date.now() });
	saveSession(record("idle"));
	const dir = join(agentDir, "mobile-bridge");
	const first = readdirSync(dir).find(name => name.endsWith(".json"));
	const held = openSync(join(dir, first), "r");
	try { saveSession(record("working")); }
	finally { closeSync(held); }
	assert.equal(listSessions()[0]?.state, "working");
	for (let i = 0; i < 9; i++) saveSession(record(i % 2 ? "idle" : "working"));
	assert.ok(readdirSync(dir).filter(name => name.endsWith(".json")).length <= 4);
	writeFileSync(join(dir, `${id}.zzzzzzzzzzzz.zzzzzzzz.ffffffff.json`), "{");
	assert.equal(listSessions()[0]?.state, "working", "an incomplete newest generation must not hide the last complete one");
	removeSession(id);
	assert.equal(listSessions().length, 0);
	assert.equal(readdirSync(dir).filter(name => name.endsWith(".json")).length, 0);
});

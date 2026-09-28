import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { launchOperation, operationStatus } from "../manage/operations.ts";
import { atomicJson, readControllerRelease, readRelease, readState, runtimeIdentity } from "../manage/store.ts";
import { activatePreparedRuntime } from "../manage/activate.ts";
import { DeskHost } from "../src/host/server.ts";
import { SessionCatalog } from "../src/host/session-files.ts";

for (const stop of [false, true]) test(stop
	? "confirmed update stops workers but retains conversations for Resume"
	: "automatic selection retains idle workers and preserves rollback after explicit close", async () => {
	const root = fs.mkdtempSync(join(tmpdir(), "desk-idle-update-")), home = join(root, "runtime"), directory = join(root, "data");
	fs.mkdirSync(home); fs.mkdirSync(directory);
	const ready = (digest, desk) => {
		const id = runtimeIdentity(digest, process.platform, process.arch, process.versions.modules);
		const version = join(home, "versions", id), host = join(version, "source", "pi-desk", "dist", "host");
		fs.mkdirSync(host, { recursive: true });
		for (const file of ["cli.js", "managed.js", "manage-cli.js"]) fs.writeFileSync(join(host, file), "");
		atomicJson(join(version, "runtime.json"), { format: 1, id, digest, platform: process.platform, arch: process.arch,
			node: process.versions.modules, source: root, readyAt: new Date().toISOString(), plugins: "0.25.0", desk, engine: "0.87.1" });
		return id;
	};
	const active = ready("a".repeat(64), "0.4.3"), pending = ready("b".repeat(64), "0.5.0");
	atomicJson(join(home, "state.json"), { format: 1, source: root, active, pending, autoApply: pending });
	atomicJson(join(home, "installation.json"), { format: 1, directory, agentDir: root, cwd: root, port: 0 });
	const host = new DeskHost({ cwd: root, agentDir: root, dataDir: directory, port: 0 });
	let stopped = 0;
	try {
		await host.start(); host.runtime = active;
		host.sessions.set("fixture", { view: { key: "fixture", cwd: root, state: "ready", created: 1,
			file: join(root, "session.jsonl"), name: "Session", snapshot: { activity: "idle" } },
			worker: { close: async () => { stopped++; } } });
		assert.deepEqual(await activatePreparedRuntime(home), { deferred: 1 });
		await assert.rejects(activatePreparedRuntime(home, "c".repeat(64)), /prepared update changed/);
		assert.equal(stopped, 0, "neither idle status nor stale approval authorizes stopping workers");
		assert.equal(readState(home).active, active);
		assert.equal(host.closing, false);
		if (!stop) host.sessions.delete("fixture");
		assert.deepEqual(await activatePreparedRuntime(home, stop ? pending : undefined), { release: "0.5.0", restart: true });
		assert.equal(stopped, Number(stop));
		const saved = new SessionCatalog(directory).read();
		assert.equal(saved.length, Number(stop));
		if (stop) {
			assert.equal(saved[0].interrupted, true);
			assert.equal(saved[0].file, join(root, "session.jsonl"));
			assert.equal(saved[0].key, "fixture");
			assert.equal(saved[0].name, "Session");
		}
		const selected = readState(home);
		assert.equal(selected.active, pending);
		assert.equal(selected.previous, active);
		assert.equal(selected.pending, undefined);
		assert.equal(selected.autoApply, undefined);
	} finally { host.sessions.clear(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("status re-reads completion after acquiring an operation lease instead of reporting a false interruption", t => {
	const home = fs.mkdtempSync(join(tmpdir(), "desk-operation-")), file = join(home, "operation.json");
	const running = { id: "fixture", action: "restart", phase: "running", message: "Starting" };
	const complete = { ...running, phase: "complete", message: "Ready" };
	atomicJson(file, running);
	const read = fs.readFileSync;
	let published = false;
	t.mock.method(fs, "readFileSync", (...args) => {
		const value = read(...args);
		if (String(args[0]) === file && !published) { published = true; atomicJson(file, complete); }
		return value;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); });
	assert.deepEqual(operationStatus(home), complete);
	atomicJson(file, running);
	assert.equal(operationStatus(home).phase, "interrupted");
});

test("a Node ABI change permits preparation control but not host activation", async t => {
	const home = fs.mkdtempSync(join(tmpdir(), "desk-node-change-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
	const digest = "a".repeat(64), node = "1";
	const id = createHash("sha256").update(JSON.stringify([1, digest, process.platform, process.arch, node])).digest("hex");
	const version = join(home, "versions", id), host = join(version, "source", "pi-desk", "dist", "host");
	fs.mkdirSync(host, { recursive: true });
	for (const name of ["cli.js", "managed.js"]) fs.writeFileSync(join(host, name), "");
	// Only the control process runs; real worker compatibility remains strict.
	fs.writeFileSync(join(host, "manage-cli.js"), `
		require("node:fs").writeFileSync(require("node:path").join(process.argv[2], "controller-node"), process.versions.modules);
		process.send({type: "accepted"}, () => process.disconnect());
	`);
	const release = { format: 1, id, digest, platform: process.platform, arch: process.arch, node,
		source: home, readyAt: new Date().toISOString(), plugins: "0.24.0", desk: "0.4.0", engine: "0.87.1" };
	atomicJson(join(version, "runtime.json"), release);
	atomicJson(join(home, "state.json"), { format: 1, source: home, active: id });
	assert.equal(readControllerRelease(home, id).node, node);
	assert.throws(() => readRelease(home, id), /different Node version/);
	await launchOperation(home, "stage");
	assert.equal(fs.readFileSync(join(home, "controller-node"), "utf8"), process.versions.modules);
	atomicJson(join(version, "runtime.json"), { ...release, node: process.versions.modules });
	assert.throws(() => readControllerRelease(home, id), /Runtime is invalid/);
});

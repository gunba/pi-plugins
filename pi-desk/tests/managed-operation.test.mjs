import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { launchOperation, operationStatus } from "../manage/operations.ts";
import { atomicJson, readControllerRelease, readRelease } from "../manage/store.ts";

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

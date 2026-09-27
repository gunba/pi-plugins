import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operationStatus } from "../manage/operations.ts";
import { atomicJson } from "../manage/store.ts";

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

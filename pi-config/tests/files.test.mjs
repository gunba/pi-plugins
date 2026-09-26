import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCheckedFile } from "../files.ts";

test("concurrent saves from the same snapshot cannot both overwrite a file", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-config-save-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "settings.json");
	for (const before of [undefined, "{}\n"]) {
		const results = await Promise.allSettled([
			writeCheckedFile(path, before, '{"theme":"dark"}\n'),
			writeCheckedFile(path, before, '{"theme":"light"}\n'),
		]);
		assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
		assert.match(results.find(result => result.status === "rejected").reason.message, /changed while/);
		const actual = await readFile(path, "utf8");
		assert.ok(actual === '{"theme":"dark"}\n' || actual === '{"theme":"light"}\n');
		await writeCheckedFile(path, actual, "{}\n");
	}
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneRuntimes } from "../manage/prune.ts";

const id = n => n.toString(16).padStart(64, "0");
const archive = n => `a${n.toString(16).padStart(63, "0")}`;

test("unused runtime slots and archives are removed; selected, rollback and actor-pinned slots stay", async () => {
	const root = await mkdtemp(join(tmpdir(), "desk-prune-")), home = join(root, "runtime"), data = join(root, "data");
	try {
		for (let n = 1; n <= 7; n++) {
			await mkdir(join(home, "versions", id(n), "source"), { recursive: true });
			await writeFile(join(home, "versions", id(n), "runtime.json"), JSON.stringify({ artifact: { dependencies: archive(n) } }));
		}
		await mkdir(join(home, "archives"), { recursive: true });
		for (let n = 1; n <= 7; n++) await writeFile(join(home, "archives", `${archive(n)}.tgz`), "");
		await writeFile(join(home, "archives", `${archive(9)}.tgz`), "");
		await mkdir(join(home, ".download-orphan"), { recursive: true });
		await writeFile(join(home, "state.json"), JSON.stringify({ format: 1, source: root, active: id(5), previous: id(4), pending: id(6) }));
		await writeFile(join(home, "installation.json"), JSON.stringify({ format: 1, directory: data, agentDir: root, cwd: root, port: 0 }));
		await mkdir(join(data, "workers", "live"), { recursive: true });
		await writeFile(join(data, "workers", "live", "worker.json"), JSON.stringify({ runtimeDirectory: join("/elsewhere/alias", id(2)) }));
		await mkdir(join(data, "workers", "starting"), { recursive: true });
		await writeFile(join(data, "workers", "starting", "bootstrap.json"), JSON.stringify({ options: { runtimeDirectory: join(home, "versions", id(3)) } }));

		const result = await pruneRuntimes(home, join(home, "archives", `${archive(9)}.tgz`));
		assert.deepEqual((await readdir(join(home, "versions"))).sort(), [2, 3, 4, 5, 6].map(id));
		assert.deepEqual((await readdir(join(home, "archives"))).sort(), [2, 3, 4, 5, 6, 9].map(n => `${archive(n)}.tgz`));
		assert.deepEqual(result.removed.sort(), [1, 7].map(id));
		assert.ok(!(await readdir(home)).some(name => name.startsWith(".download-")));
		assert.deepEqual(await readdir(join(home, ".trash")), []);

		await writeFile(join(data, "workers", "live", "worker.json"), "{");
		assert.match((await pruneRuntimes(home)).skipped ?? "", /JSON/);
		assert.equal((await readdir(join(home, "versions"))).length, 5);
	} finally { await rm(root, { recursive: true, force: true }); }
});

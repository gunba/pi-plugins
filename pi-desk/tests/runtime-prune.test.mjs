import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneRuntimes } from "../manage/prune.ts";
import { SessionLease } from "../../pi-session-ownership/lease.ts";

const id = n => String(n).repeat(64);
const archive = n => `a${n.toString(16).padStart(63, "0")}`;

test("unused runtime slots and archives are removed; selected, rollback, actor-pinned and listed slots stay", async () => {
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

		await writeFile(join(home, "keep"), "# external coordinator\r\n777777\n");
		const result = await pruneRuntimes(home, join(home, "archives", `${archive(9)}.tgz`));
		assert.deepEqual((await readdir(join(home, "versions"))).sort(), [2, 3, 4, 5, 6, 7].map(id));
		assert.deepEqual((await readdir(join(home, "archives"))).sort(), [2, 3, 4, 5, 6, 7, 9].map(n => `${archive(n)}.tgz`));
		assert.deepEqual(result.removed, [id(1)]);
		assert.ok(!(await readdir(home)).some(name => name.startsWith(".download-")));
		assert.deepEqual(await readdir(join(home, ".trash")), []);

		await writeFile(join(data, "workers", "live", "worker.json"), "{");
		assert.match((await pruneRuntimes(home)).skipped ?? "", /JSON/);
		assert.equal((await readdir(join(home, "versions"))).length, 6);
		await writeFile(join(data, "workers", "live", "worker.json"), "{}");
		await writeFile(join(home, "keep"), "not-an-id\n");
		assert.match((await pruneRuntimes(home)).skipped ?? "", /Invalid entry/);
		await writeFile(join(home, "keep"), "");

		// A live login supervisor runs the slot that was active when it started.
		const lease = new SessionLease(join(data, "supervisor")), supervisor = { version: 1, instance: "11111111-1111-1111-1111-111111111111",
			owner: "22222222-2222-2222-2222-222222222222", pid: process.pid, node: process.execPath, entry: join(home, "launch.mjs") };
		try {
			await writeFile(join(data, "supervisor.json"), JSON.stringify(supervisor));
			assert.match((await pruneRuntimes(home)).skipped ?? "", /supervisor/);
			assert.equal((await readdir(join(home, "versions"))).length, 6);
			await writeFile(join(data, "supervisor.json"), JSON.stringify({ ...supervisor, runtime: id(7) }));
			assert.deepEqual((await pruneRuntimes(home)).removed, [id(2)]);
			assert.ok((await readdir(join(home, "versions"))).includes(id(7)));
		} finally { lease.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

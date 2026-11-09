import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alive, judgement, launchRunner, parseTime, runnerFolder, stopCommand } from "../common.ts";

/** Commands are JavaScript run by Node, so they read the same on every platform. */
const node = { shell: process.execPath, args: ["-e"] };
const spec = (id, mode, command, extra = {}) => ({ id, mode, command, cwd: process.cwd(), created: Date.now(), computer: "test", ...extra });
const mark = (file, text) => `require("node:fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(text + "\n")})`;

/** Polls `check` until it returns something, and fails after `ms`. */
async function until(check, what, ms = 15_000) {
	for (const end = Date.now() + ms; ;) {
		const value = check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}
const json = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const exit = watch => until(() => json(watch.exit), `${watch.id}'s exit status`);

/** Removes the agent folder; its runner process leaves once the folder is gone. */
async function remove(dir, pid) {
	rmSync(dir, { recursive: true, force: true });
	if (pid) await until(() => !alive(pid), "the runner process to leave");
}

test("commands started by separate calls run in one runner process, and each stops on its own", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-watch-runner-")), runners = runnerFolder(dir), folder = join(dir, "watch", "conversation");
	const quick = spec("w1", "output", "console.log('done')");
	const endless = spec("w2", "output", "console.log('up'); setInterval(() => {}, 1000)");
	const repeated = spec("w3", "change", "console.log('same')", { every: 1 });
	try {
		for (const watch of [quick, endless, repeated]) await launchRunner(watch, folder, node, { runners });
		assert.deepEqual([endless.pid, repeated.pid], [quick.pid, quick.pid]);
		assert.equal(new Set([quick.run, endless.run, repeated.run]).size, 3);
		const ended = await exit(quick);
		assert.deepEqual([ended.code, ended.signal], [0, null]);
		assert.equal(readFileSync(quick.log, "utf8"), "done\n");
		await until(() => readFileSync(endless.log, "utf8") === "up\n", "w2's output");
		const change = await until(() => json(repeated.change), "w3's first change");
		assert.deepEqual([change.number, change.output, change.first], [1, "same", true]);
		stopCommand(endless);
		assert.equal((await exit(endless)).stopped, "stopped");
		assert.equal(existsSync(repeated.exit), false, "stopping one command leaves the others running");
		stopCommand(repeated);
		assert.equal((await exit(repeated)).stopped, "stopped");
		assert.equal(alive(quick.pid), true, "the runner process waits for more jobs");
	} finally { await remove(dir, quick.pid); }
});

test("a change carries the output before it, and the wake check puts both beside the condition", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-watch-runner-")), runners = runnerFolder(dir), folder = join(dir, "watch", "conversation");
	const count = join(dir, "count");
	writeFileSync(count, "0");
	const watch = spec("w4", "change", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(count)}, "utf8"))`, { every: 1 });
	try {
		await launchRunner(watch, folder, node, { runners });
		await until(() => json(watch.change)?.number === 1, "w4's first change");
		writeFileSync(count, "1");
		const change = await until(() => { const next = json(watch.change); return next?.number === 2 && next; }, "w4's second change");
		assert.deepEqual([change.output, change.before], ["1", "0"]);
		// A bare count was judged on its own, without the condition beside it, and "1" failed "output != '0'".
		assert.deepEqual(judgement(watch, "output != '0'", change.output, change.before).state,
			{ command: watch.command, condition: "output != '0'", "previous output": "0", "output now": "1" });
		stopCommand(watch);
		await exit(watch);
	} finally { await remove(dir, watch.pid); }
});

test("until refuses text that isn't a time rather than reading a date into it", () => {
	assert.throws(() => parseTime("output != '0'"), /output != '0' is not a time/);
	assert.equal(parseTime("2030-01-02T03:04:05Z"), Date.parse("2030-01-02T03:04:05Z"));
	assert.equal(parseTime("5m", 1_000), 301_000);
});

test("each command runs once when several calls start runner processes at the same time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-watch-runner-")), runners = runnerFolder(dir), folder = join(dir, "watch", "conversation");
	const marks = join(dir, "marks"), watches = Array.from({ length: 6 }, (_, n) => spec(`w${n + 1}`, "output", mark(marks, String(n))));
	try {
		await Promise.all(watches.map(watch => launchRunner(watch, folder, node, { runners })));
		for (const watch of watches) assert.equal((await exit(watch)).code, 0);
		assert.deepEqual(readFileSync(marks, "utf8").split("\n").filter(Boolean).sort(), ["0", "1", "2", "3", "4", "5"]);
		assert.equal(new Set(watches.map(watch => watch.pid)).size, 1, "one runner process took every job");
	} finally { await remove(dir, watches[0].pid); }
});

test("a command no runner process takes runs under a runner of its own, and only there", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-watch-runner-")), runners = runnerFolder(dir), folder = join(dir, "watch", "conversation");
	const marks = join(dir, "marks"), alone = spec("w1", "output", mark(marks, "alone")), later = spec("w2", "output", mark(marks, "later"));
	try {
		// A record of a running runner process that isn't one: nothing starts or takes the job.
		mkdirSync(runners, { recursive: true });
		writeFileSync(join(runners, "service.json"), JSON.stringify({ pid: process.pid }));
		await launchRunner(alone, folder, node, { runners, takeMs: 300 });
		assert.equal(alone.run, undefined);
		assert.notEqual(alone.pid, process.pid);
		assert.equal((await exit(alone)).code, 0);
		assert.deepEqual(readdirSync(join(runners, "jobs")), [], "the job was taken back");
		rmSync(join(runners, "service.json"));
		await launchRunner(later, folder, node, { runners });
		assert.equal((await exit(later)).code, 0);
		assert.deepEqual(readFileSync(marks, "utf8").split("\n").filter(Boolean), ["alone", "later"]);
	} finally { await remove(dir, later.pid); }
});

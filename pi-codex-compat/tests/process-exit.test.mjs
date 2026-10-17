import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExecRuntimeOwner, executeManagedExecCommand, executeWriteStdin, onBackgroundExit, shutdownExecSessions } from "../extensions/shell-runtime.ts";
import { exitNotice } from "../extensions/process-tools.ts";
import { recordRun, runHistory } from "../extensions/run-times.ts";

// Run times go to a scratch agent folder, not the real one.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "run-times-"));

test("a command left running reports its exit once; a poll that saw it, or an interrupt, does not", { timeout: 30_000 }, async t => {
	// 1,703 empty write_stdin polls since 26 Sep waited for processes that 1,449 times had already exited.
	const cwd = await mkdtemp(join(tmpdir(), "process-exit-")), owner = createExecRuntimeOwner(), exits = [];
	t.after(async () => { await shutdownExecSessions(owner); await rm(cwd, { recursive: true, force: true }); });
	onBackgroundExit(owner, exit => exits.push(exit));
	const node = cmd => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(cmd)}`;
	const left = await executeManagedExecCommand({ cmd: node("setTimeout(() => { console.log('built ok'); process.exit(3); }, 3000)"), yield_time_ms: 250 }, undefined, { cwd }, undefined, owner);
	assert.equal(left.details.running, true);
	for (let waited = 0; !exits.length && waited < 20_000; waited += 100) await delay(100);
	assert.equal(exits.length, 1);
	assert.equal(exits[0].exitCode, 3);
	assert.match(exitNotice(exits[0]), /^Background command finished: `.+` \(session \d+\) exited with code 3 after \d+s\.\n\nEnd of its output:\n[\s\S]*built ok$/);

	const polled = await executeManagedExecCommand({ cmd: node("setTimeout(() => process.exit(0), 3000)"), yield_time_ms: 250 }, undefined, { cwd }, undefined, owner);
	const result = await executeWriteStdin({ session_id: polled.details.session_id, yield_time_ms: 5000 }, undefined, undefined, owner);
	assert.equal(result.details.exit_code, 0);
	const stopped = await executeManagedExecCommand({ cmd: node("setTimeout(() => {}, 60000)"), yield_time_ms: 250 }, undefined, { cwd }, undefined, owner);
	await executeWriteStdin({ session_id: stopped.details.session_id, chars: "\u0003", yield_time_ms: 2000 }, undefined, undefined, owner);
	await delay(3000);
	assert.equal(exits.length, 1, "the poll and the interrupt reported their own outcomes");
});

test("a command that usually finishes quickly is waited for; one left running says how long it usually takes", { timeout: 30_000 }, async t => {
	const cwd = await mkdtemp(join(tmpdir(), "run-times-cwd-")), owner = createExecRuntimeOwner();
	t.after(async () => { await shutdownExecSessions(owner); await rm(cwd, { recursive: true, force: true }); });
	const quick = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('done'), 1500)"`;
	for (const seconds of [1.4, 1.5, 1.6]) recordRun(cwd, quick, seconds);
	assert.deepEqual(runHistory(cwd, quick), { runs: 3, median: 1.5, p95: 1.6 });
	const waited = await executeManagedExecCommand({ cmd: quick }, undefined, { cwd }, undefined, owner);
	assert.equal(waited.details.running, false, "no session and no poll");
	assert.equal(runHistory(cwd, quick).runs, 4, "the run itself is recorded");
	const slow = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 4000)"`;
	for (const seconds of [3, 3, 3]) recordRun(cwd, slow, seconds);
	const left = await executeManagedExecCommand({ cmd: slow, yield_time_ms: 250 }, undefined, { cwd }, undefined, owner);
	assert.equal(left.details.running, true);
	assert.match(left.content[0].text, /Usually takes 3s here \(3 runs\); it reports itself when it finishes\./);
});

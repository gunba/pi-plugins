import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExecRuntimeOwner, executeManagedExecCommand, executeWriteStdin, onBackgroundExit, shutdownExecSessions } from "../extensions/shell-runtime.ts";
import { exitNotice } from "../extensions/process-tools.ts";
import { recordRun, similarRuns } from "../extensions/run-times.ts";

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

test("a command left running says how long commands like it took here, even when it is not the same command", { timeout: 30_000 }, async t => {
	// Agents rarely repeat a command exactly (3,194 distinct among 3,211 runs in a week), so exact matches never had an answer.
	const cwd = await mkdtemp(join(tmpdir(), "run-times-cwd-")), owner = createExecRuntimeOwner();
	t.after(async () => { await shutdownExecSessions(owner); await rm(cwd, { recursive: true, force: true }); });
	for (const [file, seconds] of [["tests/alpha.test.mjs", 20], ["tests/beta.test.mjs", 41], ["tests/gamma.test.mjs", 33]])
		recordRun(cwd, `cd ${cwd} && node --test --test-timeout=120000 ${file}`, seconds);
	recordRun(cwd, `git status --short`, 2);
	const node = JSON.stringify(process.execPath);
	const left = await executeManagedExecCommand({ cmd: `cd ${cwd} && node --test --test-timeout=120000 tests/delta.test.mjs || ${node} -e "setTimeout(() => {}, 4000)"`, yield_time_ms: 250 }, undefined, { cwd }, undefined, owner);
	assert.equal(left.details.running, true, "nothing waits on the agent's behalf");
	assert.match(left.content[0].text, /Similar commands here took 20s–41s \(median 33s, 3 runs\)\. It reports itself when it finishes\./);
	assert.equal(similarRuns(cwd, "npm run build"), undefined, "an unrelated command has no estimate");
});

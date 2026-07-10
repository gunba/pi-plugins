import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";

import {
	executeManagedShellCommand,
	executeWriteStdin,
	resolveShellLaunch,
	shutdownShellSessions,
	terminateProcessTree,
	truncateShellOutput,
} from "../extensions/shell-runtime.ts";

after(async () => {
	await shutdownShellSessions();
});

test("shell launch uses Pi resolution by default and preserves explicit shell semantics", () => {
	let resolved = 0;
	assert.deepEqual(
		resolveShellLaunch(
			{ command: "echo hi", login: true },
			() => {
				resolved += 1;
				return { shell: "/configured/bash", args: ["-c"] };
			},
		),
		{ shell: "/configured/bash", args: ["-lc", "echo hi"], commandFromStdin: false },
	);
	assert.equal(resolved, 1);
	assert.deepEqual(
		resolveShellLaunch({ command: "Write-Output hi", shell: "pwsh.exe" }),
		{
			shell: "pwsh.exe",
			args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output hi"],
			commandFromStdin: false,
		},
	);
});

test("tail truncation reports when either the source buffer or result limit lost output", () => {
	assert.deepEqual(truncateShellOutput("a\nb\nc", 100), {
		output: "a\nb\nc",
		truncated: false,
	});
	const truncated = truncateShellOutput("abcdef", 3);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.output, "[output truncated; showing tail]\ndef");
	assert.equal(truncateShellOutput("tail", 100, true).truncated, true);
});

test("process tree termination uses taskkill /T on Windows and Unix process groups", () => {
	const taskkillCalls = [];
	terminateProcessTree(123, "SIGTERM", true, {
		platform: "win32",
		spawnTaskkill(command, args, options) {
			taskkillCalls.push({ command, args, options });
			return { unref() {} };
		},
		kill() {
			assert.fail("Windows should not call process.kill");
		},
	});
	assert.equal(taskkillCalls[0].command, "taskkill");
	assert.deepEqual(taskkillCalls[0].args, ["/PID", "123", "/T", "/F"]);

	const killed = [];
	terminateProcessTree(456, "SIGINT", false, {
		platform: "linux",
		spawnTaskkill() {
			assert.fail("Unix should not call taskkill");
		},
		kill(pid, signal) {
			killed.push([pid, signal]);
		},
	});
	assert.deepEqual(killed, [[-456, "SIGINT"]]);
});

test("managed shell execution emits throttled partial output updates", async () => {
	const updates = [];
	const result = await executeManagedShellCommand(
		{
			command:
				`node -e "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 180)"`,
			workdir: process.cwd(),
			yield_time_ms: 2_000,
		},
		undefined,
		{ cwd: process.cwd() },
		(update) => {
			const text = update.content?.find((item) => item.type === "text")?.text;
			if (text) updates.push(text);
		},
	);

	assert.equal(result.details.exit_code, 0);
	assert.equal(result.details.running, false);
	assert.match(result.content[0].text, /first[\s\S]*second/);
	assert.ok(updates.some((text) => text.includes("first")));
	assert.ok(updates.some((text) => text.includes("second")));
});

test("write_stdin emits updates and completes an interactive managed session", async () => {
	const initial = await executeManagedShellCommand(
		{
			command:
				`node -e "process.stdin.once('data', d => { process.stdout.write('got:' + d.toString()); process.exit(0); })"`,
			workdir: process.cwd(),
			yield_time_ms: 30,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(initial.details.running, true);
	assert.equal(typeof initial.details.session_id, "number");

	const updates = [];
	const completed = await executeWriteStdin(
		{ session_id: initial.details.session_id, chars: "hello\n", yield_time_ms: 2_000 },
		undefined,
		(update) => {
			const text = update.content?.find((item) => item.type === "text")?.text;
			if (text) updates.push(text);
		},
	);
	assert.equal(completed.details.exit_code, 0);
	assert.match(completed.content[0].text, /got:hello/);
	assert.ok(updates.some((text) => text.includes("got:hello")));
});

test("truncated managed output is preserved in a complete temporary log", async () => {
	const result = await executeManagedShellCommand(
		{
			command: `node -e "process.stdout.write('x'.repeat(6000))"`,
			workdir: process.cwd(),
			yield_time_ms: 2_000,
			max_output_tokens: 250,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	const fullOutputPath = result.details.full_output_path;
	assert.equal(result.details.truncated, true);
	assert.equal(typeof fullOutputPath, "string");
	assert.match(result.content[0].text, /Full output saved to:/);
	assert.equal((await readFile(fullOutputPath, "utf8")).length, 6000);
	await rm(dirname(fullOutputPath), { recursive: true, force: true });
});

test("timeouts terminate managed process trees", async () => {
	const result = await executeManagedShellCommand(
		{
			command: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			timeout_ms: 75,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.details.timed_out, true);
	assert.equal(result.details.running, false);
});

test("abort signals terminate managed process trees", async () => {
	const controller = new AbortController();
	const execution = executeManagedShellCommand(
		{
			command: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
		},
		controller.signal,
		{ cwd: process.cwd() },
	);
	setTimeout(() => controller.abort(), 75);
	const result = await execution;
	assert.equal(result.details.aborted, true);
	assert.equal(result.details.running, false);
});

test("explicit Ctrl-C and shutdown terminate managed process trees", async () => {
	const interruptedSession = await executeManagedShellCommand(
		{
			command: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			yield_time_ms: 30,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	const interrupted = await executeWriteStdin(
		{
			session_id: interruptedSession.details.session_id,
			chars: "\u0003",
			yield_time_ms: 2_000,
		},
		undefined,
	);
	assert.equal(interrupted.details.interrupted, true);
	assert.equal(interrupted.details.running, false);

	const shutdownSession = await executeManagedShellCommand(
		{
			command: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			yield_time_ms: 30,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	await shutdownShellSessions();
	const released = await executeWriteStdin(
		{ session_id: shutdownSession.details.session_id, chars: "" },
		undefined,
	);
	assert.equal(released.details.error, "session not found");
});

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	HeadTailBuffer,
	MAX_RETAINED_EXEC_LOGS,
	MAX_UNIFIED_EXEC_PROCESSES,
	UNIFIED_EXEC_OUTPUT_MAX_BYTES,
	createExecRuntimeOwner,
	createUnifiedExecEnvironment,
	effectiveExecCommandYieldMilliseconds,
	effectiveWriteStdinYieldMilliseconds,
	executeManagedExecCommand,
	executeWriteStdin,
	formatUnifiedExecOutput,
	resolveBackgroundTerminalMaxTimeoutMilliseconds,
	resolveShellLaunch,
	selectSessionIdToPrune,
	shutdownExecSessions,
	startExecSessionRuntime,
	terminateProcessTree,
	writeBufferFully,
} from "../extensions/shell-runtime.ts";

after(async () => {
	await shutdownExecSessions();
});

test("shell launch defaults to login semantics and preserves explicit shell behavior", () => {
	let resolved = 0;
	assert.deepEqual(
		resolveShellLaunch({ cmd: "echo hi" }, () => {
			resolved += 1;
			return { shell: "/configured/bash", args: ["-c"] };
		}),
		{
			shell: "/configured/bash",
			args: ["-lc", "echo hi"],
			commandFromStdin: false,
		},
	);
	assert.equal(resolved, 1);
	assert.deepEqual(
		resolveShellLaunch({
			cmd: "Write-Output hi",
			shell: "pwsh.exe",
			login: false,
		}),
		{
			shell: "pwsh.exe",
			args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output hi"],
			commandFromStdin: false,
		},
	);
	assert.deepEqual(
		resolveShellLaunch({ cmd: "echo legacy" }, () => ({
			shell: "C:/Windows/System32/bash.exe",
			args: ["-s"],
			commandTransport: "stdin",
		})),
		{
			shell: "C:/Windows/System32/bash.exe",
			args: ["-l", "-s"],
			commandFromStdin: true,
		},
	);
});

test("byte buffering is UTF-8 safe across chunks and symmetric truncation boundaries", () => {
	const split = new HeadTailBuffer();
	const encoded = Buffer.from("A🙂B", "utf8");
	split.append(encoded.subarray(0, 3));
	split.append(encoded.subarray(3, 5));
	split.append(encoded.subarray(5));
	assert.deepEqual(formatUnifiedExecOutput(split.snapshot(), 100), {
		output: "A🙂B",
		originalTokenCount: 2,
		truncated: false,
		omittedBytes: 0,
	});

	const bounded = new HeadTailBuffer(10);
	bounded.append(Buffer.from("αβγδεζηθ", "utf8"));
	const formatted = formatUnifiedExecOutput(bounded.snapshot(), 100);
	assert.equal(formatted.truncated, true);
	assert.equal(formatted.originalTokenCount, 4);
	assert.match(formatted.output, /^αβ\n\.\.\. 8 bytes omitted \.\.\.\nηθ$/);
	assert.doesNotMatch(formatted.output, /�/);
});

test("model-facing output strips terminal and unsafe control sequences", () => {
	const buffer = new HeadTailBuffer();
	const raw = Buffer.from(
		"safe\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u0000\r\u202E\u{E0061}end",
	);
	buffer.append(raw);
	assert.deepEqual(formatUnifiedExecOutput(buffer.snapshot(), 100), {
		output: "safelinkend",
		originalTokenCount: Math.ceil(raw.length / 4),
		truncated: false,
		omittedBytes: 0,
	});
});

test("complete-output writes handle partial progress and reject zero-progress writers", async () => {
	const written = [];
	await writeBufferFully(
		{
			async write(buffer, offset, length) {
				const bytesWritten = Math.min(3, length);
				written.push(
					Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
				);
				return { bytesWritten, buffer };
			},
		},
		Buffer.from("complete"),
	);
	assert.equal(Buffer.concat(written).toString("utf8"), "complete");
	await assert.rejects(
		writeBufferFully(
			{
				async write(buffer) {
					return { bytesWritten: 0, buffer };
				},
			},
			Buffer.from("stalled"),
		),
		/made no progress/,
	);
});

test("model output defaults to 10k tokens and preserves a UTF-8-safe head and tail", () => {
	assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 10_000);
	assert.equal(UNIFIED_EXEC_OUTPUT_MAX_BYTES, 1024 * 1024);
	const buffer = new HeadTailBuffer();
	buffer.append(Buffer.from(`HEAD${"x".repeat(49_992)}TAIL`, "utf8"));
	const formatted = formatUnifiedExecOutput(buffer.snapshot());
	assert.equal(formatted.originalTokenCount, 12_500);
	assert.equal(formatted.truncated, true);
	assert.match(
		formatted.output,
		/^Warning: truncated output \(original token count: 12500\)/,
	);
	assert.match(formatted.output, /HEAD/);
	assert.match(formatted.output, /TAIL$/);
	assert.match(formatted.output, /…2500 tokens truncated…/);
});

test("process tree termination uses taskkill /T on Windows and Unix process groups", async () => {
	const taskkillCalls = [];
	assert.equal(
		await terminateProcessTree(123, "SIGTERM", true, {
			platform: "win32",
			spawnTaskkill(command, args, options) {
				taskkillCalls.push({ command, args, options });
				return { unref() {} };
			},
			kill() {
				assert.fail("Windows should not call process.kill");
			},
		}),
		true,
	);
	assert.equal(taskkillCalls[0].command, "taskkill");
	assert.deepEqual(taskkillCalls[0].args, ["/PID", "123", "/T", "/F"]);

	const killed = [];
	assert.equal(
		await terminateProcessTree(456, "SIGINT", false, {
			platform: "linux",
			spawnTaskkill() {
				assert.fail("Unix should not call taskkill");
			},
			kill(pid, signal) {
				killed.push([pid, signal]);
			},
		}),
		true,
	);
	assert.deepEqual(killed, [[-456, "SIGINT"]]);
});

test("Windows taskkill failures are reported without unsafe PID fallback", async () => {
	for (const [event, value] of [
		["error", new Error("taskkill missing")],
		["exit", 1],
	]) {
		const listeners = new Map();
		const killed = [];
		const attempt = terminateProcessTree(789, "SIGTERM", true, {
			platform: "win32",
			spawnTaskkill() {
				return {
					once(name, listener) {
						listeners.set(name, listener);
					},
				};
			},
			kill(pid, signal) {
				killed.push([pid, signal]);
			},
		});
		listeners.get(event)(value);
		assert.equal(await attempt, false);
		assert.deepEqual(killed, []);
	}
});

test("a hanging Windows taskkill attempt is bounded and reported", async () => {
	let taskkillStopped = false;
	const success = await terminateProcessTree(790, "SIGTERM", true, {
		platform: "win32",
		taskkillTimeoutMs: 5,
		spawnTaskkill() {
			return {
				once() {},
				kill() {
					taskkillStopped = true;
				},
			};
		},
		kill() {
			assert.fail("must not fall back to a potentially reused PID");
		},
	});
	assert.equal(success, false);
	assert.equal(taskkillStopped, true);
});

test("Unified Exec timing policy clamps initial waits, writes, and empty polls", () => {
	assert.equal(
		effectiveExecCommandYieldMilliseconds(undefined, "linux"),
		10_000,
	);
	assert.equal(effectiveExecCommandYieldMilliseconds(1, "linux"), 250);
	assert.equal(effectiveExecCommandYieldMilliseconds(40_000, "linux"), 30_000);
	assert.equal(effectiveExecCommandYieldMilliseconds(1, "win32"), 2_000);
	assert.equal(effectiveExecCommandYieldMilliseconds(1_000, "win32"), 2_000);
	assert.equal(effectiveExecCommandYieldMilliseconds(40_000, "win32"), 30_000);

	assert.equal(effectiveWriteStdinYieldMilliseconds({ chars: "\u0003" }), 250);
	assert.equal(
		effectiveWriteStdinYieldMilliseconds({ chars: "\u0003", yield_time_ms: 1 }),
		250,
	);
	assert.equal(
		effectiveWriteStdinYieldMilliseconds({
			chars: "\u0003",
			yield_time_ms: 40_000,
		}),
		30_000,
	);

	assert.equal(effectiveWriteStdinYieldMilliseconds({ chars: "" }), 5_000);
	assert.equal(effectiveWriteStdinYieldMilliseconds({}), 5_000);
	assert.equal(
		effectiveWriteStdinYieldMilliseconds({ yield_time_ms: 1 }),
		5_000,
	);
	assert.equal(
		effectiveWriteStdinYieldMilliseconds({ yield_time_ms: 600_000 }),
		300_000,
	);
	assert.equal(
		effectiveWriteStdinYieldMilliseconds({ yield_time_ms: 600_000 }, 600_000),
		600_000,
	);
	assert.equal(resolveBackgroundTerminalMaxTimeoutMilliseconds(1_000), 5_000);
	assert.equal(
		resolveBackgroundTerminalMaxTimeoutMilliseconds("600000"),
		600_000,
	);
});

test("Codex noninteractive environment defaults override inherited terminal settings", () => {
	const env = createUnifiedExecEnvironment({
		PATH: "/test/bin",
		TERM: "xterm-256color",
		PAGER: "less",
	});
	assert.equal(env.PATH, "/test/bin");
	assert.equal(env.CDPATH, "");
	assert.deepEqual(
		Object.fromEntries(
			[
				"NO_COLOR",
				"TERM",
				"LANG",
				"LC_CTYPE",
				"LC_ALL",
				"COLORTERM",
				"PAGER",
				"GIT_PAGER",
				"GH_PAGER",
				"CODEX_CI",
			].map((key) => [key, env[key]]),
		),
		{
			NO_COLOR: "1",
			TERM: "dumb",
			LANG: "C.UTF-8",
			LC_CTYPE: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			COLORTERM: "",
			PAGER: "cat",
			GIT_PAGER: "cat",
			GH_PAGER: "cat",
			CODEX_CI: "1",
		},
	);
});

test("64-process pruning protects eight recent sessions and prefers exited LRU entries", () => {
	assert.equal(MAX_UNIFIED_EXEC_PROCESSES, 64);
	const meta = Array.from({ length: 12 }, (_, index) => ({
		id: index + 1,
		lastUsed: index + 1,
		exited: index === 2 || index === 3,
	}));
	assert.equal(selectSessionIdToPrune(meta), 3);
	assert.equal(
		selectSessionIdToPrune(meta.map((entry) => ({ ...entry, exited: false }))),
		1,
	);
});

test(
	"the 64-process cap remains atomic across concurrent launches",
	{ skip: process.platform === "win32" },
	async () => {
		const results = await Promise.all(
			Array.from({ length: MAX_UNIFIED_EXEC_PROCESSES + 1 }, () =>
				executeManagedExecCommand(
					{
						cmd: "exec sleep 30",
						workdir: process.cwd(),
						login: false,
						yield_time_ms: 1,
					},
					undefined,
					{ cwd: process.cwd() },
				),
			),
		);
		const ids = [
			...new Set(
				results.flatMap((result) =>
					typeof result.details.session_id === "number"
						? [result.details.session_id]
						: [],
				),
			),
		];
		assert.ok(ids.length >= MAX_UNIFIED_EXEC_PROCESSES);
		const stillRegistered = await Promise.all(
			ids.map(async (session_id) => {
				try {
					await executeWriteStdin(
						{ session_id, chars: "not-supported" },
						undefined,
					);
					return true;
				} catch (error) {
					return !String(error).includes("no unified exec session");
				}
			}),
		);
		assert.equal(
			stillRegistered.filter(Boolean).length,
			MAX_UNIFIED_EXEC_PROCESSES,
		);
		await shutdownExecSessions();
		await startExecSessionRuntime();
	},
);

test("runtime owners isolate sessions and shutdown", async (t) => {
	const ownerA = createExecRuntimeOwner();
	const ownerB = createExecRuntimeOwner();
	t.after(async () => {
		await Promise.allSettled([
			shutdownExecSessions(ownerA),
			shutdownExecSessions(ownerB),
		]);
	});
	await startExecSessionRuntime(ownerA);
	await startExecSessionRuntime(ownerB);
	const launch = (owner) =>
		executeManagedExecCommand(
			{
				cmd: `node -e "setInterval(() => {}, 1000)"`,
				workdir: process.cwd(),
				login: false,
				yield_time_ms: 1,
			},
			undefined,
			{ cwd: process.cwd() },
			undefined,
			owner,
		);
	const [sessionA, sessionB] = await Promise.all([
		launch(ownerA),
		launch(ownerB),
	]);
	assert.ok(sessionA.details.session_id >= 1_000);
	assert.ok(sessionA.details.session_id < 100_000);
	assert.ok(sessionB.details.session_id >= 1_000);
	assert.ok(sessionB.details.session_id < 100_000);
	await assert.rejects(
		executeWriteStdin(
			{ session_id: sessionA.details.session_id },
			undefined,
			undefined,
			ownerB,
		),
		/no unified exec session/,
	);
	await shutdownExecSessions(ownerA);
	const stillOwned = await executeWriteStdin(
		{
			session_id: sessionB.details.session_id,
			chars: "\u0003",
			yield_time_ms: 10_000,
		},
		undefined,
		undefined,
		ownerB,
	);
	assert.equal(stillOwned.details.running, false);
	await shutdownExecSessions(ownerB);
});

test("pre-aborted calls cannot launch shell side effects", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-codex-pre-abort-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const marker = join(cwd, "launched.txt");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		executeManagedExecCommand(
			{
				cmd: `echo launched > "${marker}"`,
				workdir: cwd,
				login: false,
			},
			controller.signal,
			{ cwd },
		),
		/aborted before the process was launched/,
	);
	await assert.rejects(access(marker), /ENOENT/);
});

test("provider integer fields reject fractional and negative values", async () => {
	await assert.rejects(
		executeManagedExecCommand(
			{
				cmd: "echo no",
				workdir: process.cwd(),
				yield_time_ms: 1.5,
			},
			undefined,
			{ cwd: process.cwd() },
		),
		/yield_time_ms must be a non-negative integer/,
	);
	await assert.rejects(
		executeWriteStdin({ session_id: 1, max_output_tokens: -1 }, undefined),
		/max_output_tokens must be a non-negative integer/,
	);
});

test("shutdown is a barrier against a concurrently starting session", async () => {
	const launch = Promise.allSettled([
		executeManagedExecCommand(
			{
				cmd: `node -e "setInterval(() => {}, 1000)"`,
				workdir: process.cwd(),
				login: false,
				yield_time_ms: 1,
			},
			undefined,
			{ cwd: process.cwd() },
		),
	]);
	try {
		await shutdownExecSessions();
		const launched = await launch;
		if (launched[0].status === "fulfilled") {
			await assert.rejects(
				executeWriteStdin(
					{ session_id: launched[0].value.details.session_id },
					undefined,
				),
				/no unified exec session|runtime is shut down/,
			);
		} else {
			assert.match(launched[0].reason.message, /runtime is shut down/);
		}
	} finally {
		await startExecSessionRuntime();
	}
});

test("managed execution emits updates and the Unified Exec result shape", async () => {
	const updates = [];
	const result = await executeManagedExecCommand(
		{
			cmd: `node -e "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 180)"`,
			workdir: process.cwd(),
			login: false,
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
	assert.match(result.details.chunk_id, /^[0-9a-f]{6}$/);
	assert.equal(result.details.original_token_count, 4);
	assert.equal(result.details.output, "first\nsecond\n");
	assert.match(result.content[0].text, /Process exited with code 0/);
	assert.match(
		result.content[0].text,
		/Original token count: 4\nOutput:\nfirst\nsecond/,
	);
	assert.ok(updates.some((text) => text.includes("first")));
	assert.ok(updates.some((text) => text.includes("second")));
	assert.ok(updates.every((text) => text.includes("Chunk ID:")));
});

test("managed launch failures reject as tool errors", async () => {
	await assert.rejects(
		executeManagedExecCommand(
			{
				cmd: "echo unreachable",
				shell: `pi-codex-missing-shell-${process.pid}`,
				workdir: process.cwd(),
				login: false,
			},
			undefined,
			{ cwd: process.cwd() },
		),
		/exec_command failed to launch:.*ENOENT/,
	);
});

test("tty:false closes stdin, rejects non-exact interrupts, and accepts exact Ctrl-C", async () => {
	const initial = await executeManagedExecCommand(
		{
			cmd: `node -e "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			login: false,
			yield_time_ms: 1,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(initial.details.running, true);
	const sessionId = initial.details.session_id;

	await assert.rejects(
		executeWriteStdin(
			{ session_id: sessionId, chars: "hello\n", yield_time_ms: 1 },
			undefined,
		),
		/stdin is closed.*exact Ctrl-C/,
	);
	await assert.rejects(
		executeWriteStdin(
			{ session_id: sessionId, chars: "x\u0003", yield_time_ms: 1 },
			undefined,
		),
		/stdin is closed.*exact Ctrl-C/,
	);

	const interrupted = await executeWriteStdin(
		{ session_id: sessionId, chars: "\u0003", yield_time_ms: 2_000 },
		undefined,
	);
	assert.equal(interrupted.details.running, false);
	await assert.rejects(
		executeWriteStdin({ session_id: sessionId, chars: "" }, undefined),
		/no unified exec session/,
	);
});

test("default empty polling drains only new output and releases completed sessions", async () => {
	const initialWaitMs = effectiveExecCommandYieldMilliseconds(1);
	const secondDelayMs = initialWaitMs + 1_000;
	const exitDelayMs = secondDelayMs + 250;
	const initial = await executeManagedExecCommand(
		{
			cmd: `node -e "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), ${secondDelayMs}); setTimeout(() => process.exit(0), ${exitDelayMs})"`,
			workdir: process.cwd(),
			login: false,
			yield_time_ms: 1,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(initial.details.running, true);
	assert.match(initial.details.output, /first/);

	const pollStartedAt = Date.now();
	const completed = await executeWriteStdin(
		{ session_id: initial.details.session_id, chars: "" },
		undefined,
	);
	assert.equal(completed.details.running, false);
	assert.equal(completed.details.exit_code, 0);
	assert.ok(Date.now() - pollStartedAt >= 800);
	assert.doesNotMatch(completed.details.output, /first/);
	assert.match(completed.details.output, /second/);

	await assert.rejects(
		executeWriteStdin(
			{ session_id: initial.details.session_id, chars: "" },
			undefined,
		),
		/no unified exec session/,
	);
});

test("truncated output keeps a complete temp log until extension shutdown", async () => {
	const totalOutputBytes = UNIFIED_EXEC_OUTPUT_MAX_BYTES + 32;
	const result = await executeManagedExecCommand(
		{
			cmd: `node -e "process.stdout.write('H' + 'x'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES + 30}) + 'T')"`,
			workdir: process.cwd(),
			login: false,
			yield_time_ms: 2_000,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	const fullOutputPath = result.details.full_output_path;
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.original_token_count, totalOutputBytes / 4);
	assert.equal(result.details.omitted_bytes, 32);
	assert.equal(typeof fullOutputPath, "string");
	assert.match(result.content[0].text, /Full output saved to:/);
	assert.match(result.details.output, /^Warning: truncated output/);
	assert.match(result.details.output, /\.\.\. 32 bytes omitted \.\.\./);
	const fullOutput = await readFile(fullOutputPath, "utf8");
	assert.equal(fullOutput.length, totalOutputBytes);
	assert.equal(fullOutput[0], "H");
	assert.equal(fullOutput.at(-1), "T");

	await shutdownExecSessions();
	await assert.rejects(readFile(fullOutputPath, "utf8"), /ENOENT/);
	await startExecSessionRuntime();
});

test("retained complete-output logs are bounded by an in-session LRU", async () => {
	const results = await Promise.all(
		Array.from({ length: MAX_RETAINED_EXEC_LOGS + 1 }, (_, index) =>
			executeManagedExecCommand(
				{
					cmd: `node -e "process.stdout.write('${index}' + 'x'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES}))"`,
					workdir: process.cwd(),
					login: false,
					yield_time_ms: 2_000,
				},
				undefined,
				{ cwd: process.cwd() },
			),
		),
	);
	const paths = results.map((result) => result.details.full_output_path);
	assert.equal(
		paths.every((path) => typeof path === "string"),
		true,
	);
	const existence = await Promise.all(
		paths.map(async (path) => {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		}),
	);
	assert.equal(existence.filter(Boolean).length, MAX_RETAINED_EXEC_LOGS);
	await shutdownExecSessions();
	await startExecSessionRuntime();
});

test("abort signals terminate managed process trees without a provider timeout field", async () => {
	const controller = new AbortController();
	const execution = executeManagedExecCommand(
		{
			cmd: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			login: false,
		},
		controller.signal,
		{ cwd: process.cwd() },
	);
	setTimeout(() => controller.abort(), 75);
	const result = await execution;
	assert.equal(result.details.aborted, true);
	assert.equal(result.details.running, false);
});

test(
	"Unix signal exits stay distinct from numeric exit codes",
	{ skip: process.platform === "win32" },
	async () => {
		const initial = await executeManagedExecCommand(
			{
				cmd: "exec sleep 30",
				workdir: process.cwd(),
				login: false,
				yield_time_ms: 1,
			},
			undefined,
			{ cwd: process.cwd() },
		);
		const interrupted = await executeWriteStdin(
			{
				session_id: initial.details.session_id,
				chars: "\u0003",
				yield_time_ms: 2_000,
			},
			undefined,
		);
		assert.equal(interrupted.details.signal, "SIGINT");
		assert.equal(interrupted.details.exit_code, undefined);
		assert.match(
			interrupted.content[0].text,
			/Process exited with signal SIGINT/,
		);
	},
);

test("shutdown terminates and releases running sessions", async () => {
	const running = await executeManagedExecCommand(
		{
			cmd: `node -e "setInterval(() => {}, 1000)"`,
			workdir: process.cwd(),
			login: false,
			yield_time_ms: 1,
		},
		undefined,
		{ cwd: process.cwd() },
	);
	await shutdownExecSessions();
	await assert.rejects(
		executeWriteStdin(
			{ session_id: running.details.session_id, chars: "" },
			undefined,
		),
		/runtime is shut down/,
	);
});

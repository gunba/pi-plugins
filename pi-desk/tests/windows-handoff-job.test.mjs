import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { windowsQuote } from "../src/host/login-manager.ts";
import { atomicJson } from "../manage/store.ts";

const root = () => mkdtempSync(join(tmpdir(), "desk-supervisor-"));

test("Windows kill-on-close Job preserves managed and native SDK handoffs", {
	skip: process.platform !== "win32", timeout: 300000,
}, async t => {
	const directory = root(), proof = join(directory, "proof");
	mkdirSync(proof);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const config = join(directory, "command.json"), script = fileURLToPath(new URL("./fixtures/windows-handoff-job.ps1", import.meta.url));
	const runner = fileURLToPath(new URL("./fixtures/windows-job-runner.mjs", import.meta.url));
	const cwd = fileURLToPath(new URL("../../", import.meta.url));
	const pattern = "^(a real managed wrapper.*|native SDK queues.*|registered SDK subagent.*)$";
	atomicJson(config, { node: process.execPath, arguments: [runner, config].map(windowsQuote).join(" "),
		cwd, proof, admission: join(directory, "assigned"), stdout: join(directory, "stdout.txt"), stderr: join(directory, "stderr.txt"),
		tests: ["--test", "--test-reporter=tap", "--test-concurrency=2", `--test-name-pattern=${pattern}`,
			"pi-desk/tests/login-supervisor.test.mjs", "pi-desk/tests/native-handoff.test.mjs"] });
	const child = spawn(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		["-NoProfile", "-NonInteractive", "-File", script, "-Mode", "Run", "-JobName", `pi-desk-fixture-${randomUUID()}`, "-CommandFile", config],
		{ cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "", stderr = "";
	child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
	const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	const logs = ["stdout.txt", "stderr.txt"].filter(name => existsSync(join(directory, name))).map(name => readFileSync(join(directory, name), "utf8")).join("\n");
	assert.equal(code, 0, (stderr + "\n" + logs).slice(-30000));
	assert.match(logs, /ok \d+ - a real managed wrapper/);
	assert.match(logs, /ok \d+ - native SDK queues/);
	assert.match(logs, /ok \d+ - registered SDK subagent/);
	assert.deepEqual(JSON.parse(stdout), { killOnClose: true, admission: "assigned-before-tests", activeAfter: 0, exitCode: 0 });
	for (const phase of ["managed-before", "managed-after", "native-before", "native-after", "subagent-before", "subagent-after"]) {
		const receipt = JSON.parse(readFileSync(join(proof, phase + ".json"), "utf8"));
		assert.equal(receipt.phase, phase); assert(receipt.members.length >= 3);
		assert(receipt.members.every(member => member.member));
	}
	t.diagnostic("Six native Job membership boundaries passed; all owned processes closed gracefully.");
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { windowsQuote } from "../src/host/login-manager.ts";
import { assertFixtureJobMembers } from "./fixtures/windows-job-members.mjs";
import test from "node:test";
import { atomicJson, readState, runtimeIdentity, versionDirectory } from "../manage/store.ts";
import { activatePreparedRuntime } from "../manage/activate.ts";
import { saveInstallation } from "../manage/installation.ts";
import { probeHost, stopHost } from "../src/host/lifecycle.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { SessionWorker } from "../src/host/worker-client.ts";
import { attachWorker, waitWorkerStopped, readWorkerRecord, workerDirectory } from "../src/host/worker-registry.ts";
import { RELEASE } from "../src/shared/release.ts";
import { InputLedger } from "../src/host/inputs.ts";
import { LoginSupervisor, liveSupervisor, waitHandoffSelection } from "../src/host/login-supervisor.ts";
import { runLogin } from "../src/host/login.ts";

const root = () => mkdtempSync(join(tmpdir(), "desk-supervisor-"));

test("the same login supervisor restarts only the host through its stable entry after verified selection", async () => {
	const directory = root(), home = join(directory, "runtime"), entry = join(directory, "launch.mjs");
	mkdirSync(home); writeFileSync(entry, "");
	const owner = randomUUID(), source = "a".repeat(64), target = "b".repeat(64);
	atomicJson(join(directory, "login.json"), { version: 1, owner, platform: process.platform,
		name: "pi-desk-0123456789abcdef", node: process.execPath, entry, directory, cwd: directory,
		arguments: ["--data-dir", directory], environment: {}, unit: join(directory, "fixture.service") });
	atomicJson(join(home, "state.json"), { format: 1, source: directory, active: source, pending: target });
	const ticket = { id: "handoff", source, target, state: "committed", created: Date.now(), workers: [], sessions: [] };
	const ledger = new InputLedger(directory); ledger.writeCheckpoint(ticket); ledger.close();
	let calls = 0, identity;
	try {
		await runLogin(directory, { runtime: () => ({ home }), start: async (data, cwd, args, options) => {
			calls++;
			assert.equal(data, directory); assert.equal(cwd, directory);
			assert.deepEqual(args, ["--data-dir", directory]); assert.equal(options.entry, entry);
			assert.equal(options.managed, true); assert.equal(options.waitForLaunch, 30_000);
			const supervisor = liveSupervisor(directory);
			assert.equal(supervisor.pid, process.pid);
			assert.equal(options.environment.PI_DESK_SUPERVISOR, supervisor.instance);
			if (calls === 1) {
				identity = supervisor.instance;
				atomicJson(join(home, "state.json"), { format: 1, source: directory, active: target, previous: source });
			} else assert.equal(supervisor.instance, identity, "the service/job wrapper never stopped");
			return { reused: false, host: { runtime: calls === 1 ? source : target }, exited: Promise.resolve(0) };
		} });
		assert.equal(calls, 2, "no handoff from the new host means explicit shutdown, not another restart");
		assert.equal(liveSupervisor(directory), undefined);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a supervisor restart cannot infer successful selection; source recovery requires a controller marker", async () => {
	const directory = root(), home = join(directory, "runtime"); mkdirSync(home);
	const source = "a".repeat(64), target = "b".repeat(64);
	atomicJson(join(home, "state.json"), { format: 1, source: directory, active: source });
	const ticket = { id: "handoff", source, target, state: "committed", created: 1, workers: [], sessions: [] };
	const ledger = new InputLedger(directory); ledger.writeCheckpoint(ticket); ledger.close();
	try {
		await assert.rejects(waitHandoffSelection(home, directory, ticket, new AbortController().signal, 0), /selection is unconfirmed/);
		const marked = new InputLedger(directory); marked.writeCheckpoint({ ...ticket, resumeSource: true }); marked.close();
		assert.equal(await waitHandoffSelection(home, directory, ticket, new AbortController().signal, 0), source);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("supervisor identity is lease-backed and concurrent wrappers cannot replace it", () => {
	const directory = root();
	const supervisor = new LoginSupervisor(directory, randomUUID(), process.execPath, join(directory, "launch.mjs"));
	try {
		assert.equal(liveSupervisor(directory).instance, supervisor.record.instance);
		assert.throws(() => new LoginSupervisor(directory, randomUUID(), process.execPath, join(directory, "launch.mjs")), /already open/);
		assert.equal(liveSupervisor(directory).instance, supervisor.record.instance);
	} finally { supervisor.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a real managed wrapper survives public host replacement with the same busy actor and OS child", { timeout: 120000 }, async t => {
	const directory = root(), data = join(directory, "desk"), home = join(directory, "runtime");
	mkdirSync(data); mkdirSync(home);
	const fixture = fileURLToPath(new URL("./fixtures/supervised-host.mjs", import.meta.url));
	const module = fileURLToPath(new URL("./fixtures/persistent-worker.mjs", import.meta.url));
	const ready = (digest, desk) => {
		const id = runtimeIdentity(digest, process.platform, process.arch, process.versions.modules);
		const entry = join(versionDirectory(home, id), "source", "pi-desk", "dist", "host"); mkdirSync(entry, { recursive: true });
		writeFileSync(join(entry, "package.json"), JSON.stringify({ type: "module" }));
		const code = `await import(${JSON.stringify(new URL("./fixtures/supervised-host.mjs", import.meta.url).href)});`;
		for (const name of ["cli.js", "managed.js", "manage-cli.js"]) writeFileSync(join(entry, name), code);
		atomicJson(join(versionDirectory(home, id), "runtime.json"), { format: 1, id, digest, source: directory,
			platform: process.platform, arch: process.arch, node: process.versions.modules,
			plugins: "0.29.3", desk, engine: RELEASE.engine, readyAt: new Date().toISOString() });
		return id;
	};
	const source = ready("a".repeat(64), "0.5.23"), target = ready("b".repeat(64), "0.5.24"), pin = versionDirectory(home, source);
	atomicJson(join(home, "state.json"), { format: 1, source: directory, active: source, pending: target, autoApply: target });
	saveInstallation(home, { format: 1, directory: data, cwd: directory, agentDir: directory, port: 0 });
	atomicJson(join(data, "login.json"), { version: 1, owner: randomUUID(), platform: process.platform,
		name: "pi-desk-0123456789abcdef", node: process.execPath, entry: join(home, "launch.mjs"), directory: data,
		cwd: directory, arguments: [], environment: { PI_OFFLINE: "1" }, unit: join(directory, "unregistered.service") });
	const key = randomUUID(), activation = randomUUID(), file = join(directory, "native.jsonl"), input = randomUUID();
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: directory, timestamp: new Date().toISOString() }) + "\n");
	const prefix = readFileSync(file);
	let entered;
	const accepted = new Promise(resolve => { entered = resolve; });
	const worker = new SessionWorker({ cwd: directory, agentDir: directory, sessionFile: file }, event => {
		if (event.type === "event") entered();
	}, { directory: data, key, module }, { attach: (...args) => attachWorker(...args.slice(0, 4), { ...args[4], runtimeDirectory: pin }), waitStopped: waitWorkerStopped });
	let wrapper, exit;
	t.after(async () => {
		try {
			if (wrapper && wrapper.exitCode === null) await stopHost(data);
			if (exit) await Promise.race([exit, delay(10000, undefined, { ref: false }).then(() => { throw new Error("Fixture wrapper did not stop"); })]);
		} finally {
			const record = readWorkerRecord(workerDirectory(data, key));
			if (record) {
				assert.equal(record.instance, worker.instance);
				const cleanup = new SessionWorker({ cwd: directory, agentDir: directory, sessionFile: file }, () => {},
					{ directory: data, key, adopt: record.instance });
				await cleanup.close();
			}
			await worker.detach(); rmSync(directory, { recursive: true, force: true });
		}
	});
	const snapshot = await worker.start();
	new SessionCatalog(data).write([{ key, activation, cwd: directory, created: Date.now(), state: "ready", file, snapshot }]);
	const ledger = new InputLedger(data);
	ledger.admit(key, { id: input, activation, generation: snapshot.ui.generation, command: { kind: "prompt", text: "Held during update" } });
	ledger.settle(key, input, "sending"); ledger.close();
	const pending = worker.command({ kind: "prompt", text: "Held during update" }, snapshot.ui.generation, input).catch(() => {});
	await accepted; await worker.detach(); await pending;
	const env = { ...process.env, PI_OFFLINE: "1" };
	for (const name of Object.keys(env)) if (name.startsWith("PI_") && name !== "PI_OFFLINE") delete env[name];
	wrapper = spawn(process.execPath, [fixture, "wrapper", data, home], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; wrapper.stdout.on("data", data => { output += data; }); wrapper.stderr.on("data", data => { output += data; });
	exit = new Promise((resolve, reject) => { wrapper.once("exit", code => resolve(code)); wrapper.once("error", reject); });
	const until = Date.now() + 90000;
	const waitHost = async runtime => {
		while (Date.now() < until) {
			assert.equal(wrapper.exitCode, null, output);
			const state = await probeHost(data);
			if (state.state === "running" && state.host.runtime === runtime && state.host.restore?.pending !== true && state.host.sessions.working === 1) return state.host;
			await delay(25);
		}
		assert.fail(`Fixture host did not become ready: ${output}`);
	};
	const first = await waitHost(source), supervisor = liveSupervisor(data);
	assert.equal(supervisor.pid, wrapper.pid); assert.equal(first.supervisor, supervisor.instance);
	await assertFixtureJobMembers([wrapper.pid, first.pid, snapshot.pid, snapshot.child], "managed-before");
	process.kill(snapshot.pid, 0); process.kill(snapshot.child, 0);
	assert.deepEqual(await activatePreparedRuntime(home, target, "supervised-handoff"), { release: "0.5.24", restart: true });
	const next = await waitHost(target);
	assert.notEqual(next.instance, first.instance); assert.notEqual(next.pid, first.pid);
	assert.equal(next.supervisor, supervisor.instance); assert.equal(liveSupervisor(data).pid, wrapper.pid);
	assert.equal(wrapper.exitCode, null);
	await assertFixtureJobMembers([wrapper.pid, next.pid, snapshot.pid, snapshot.child], "managed-after");
	assert.equal(readState(home).previous, source);
	process.kill(snapshot.pid, 0); process.kill(snapshot.child, 0);
	const token = JSON.parse(readFileSync(join(data, "access.json"), "utf8")).operator;
	const view = async () => {
		const response = await fetch(`${next.origin}/api/state`, { signal: AbortSignal.timeout(5000),
			headers: { Authorization: `Bearer ${token}`, "X-Pi-Desk-API": String(RELEASE.api) } });
		assert.equal(response.status, 200);
		return (await response.json()).sessions.find(view => view.key === key);
	};
	const owned = await view(), busy = owned.snapshot;
	assert.equal(owned.activation, activation); assert.equal(busy.runtimePin, pin);
	assert.equal(busy.activity, "running"); assert.equal(busy.writes, 0);
	assert.equal(busy.pid, snapshot.pid); assert.equal(busy.child, snapshot.child);
	assert.deepEqual(busy.accounts, snapshot.accounts);
	writeFileSync(join(directory, "allow-finish"), "");
	let current;
	for (;;) {
		current = (await view()).snapshot;
		if (current.activity === "idle") break;
		assert(Date.now() < until); await delay(25);
	}
	assert.equal(current.writes, 1);
	assert.deepEqual(readFileSync(file), prefix);
	const retained = new InputLedger(data);
	try {
		while (retained.read(key, input).status.state === "sending") {
			assert(Date.now() < until, "the replacement host must recover the original input receipt"); await delay(25);
		}
		assert.equal(retained.read(key, input).status.state, "accepted");
		assert.equal(retained.checkpoint().state, "complete");
	} finally { retained.close(); }
});

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
		tests: ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`,
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

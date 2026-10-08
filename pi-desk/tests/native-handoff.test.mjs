import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DeskHost } from "../src/host/server.ts";
import { SessionWorker } from "../src/host/worker-client.ts";
import { assertFixtureJobMembers } from "./fixtures/windows-job-members.mjs";
import { attachWorker, waitWorkerStopped } from "../src/host/worker-registry.ts";
import { atomicJson, runtimeIdentity, versionDirectory } from "../manage/store.ts";
import { activatePreparedRuntime } from "../manage/activate.ts";
import { RELEASE } from "../src/shared/release.ts";

const module = fileURLToPath(new URL("./fixtures/handoff-sdk-worker.mjs", import.meta.url));
const extension = fileURLToPath(new URL("./fixtures/handoff-sdk-extension.mjs", import.meta.url));
const waitSnapshot = async (worker, predicate) => {
	const until = Date.now() + 30_000;
	let last;
	while (Date.now() < until) {
		last = await worker.command({ kind: "snapshot" });
		if (predicate(last)) return last;
		await delay(25);
	}
	assert.fail(`Native fixture did not reach its boundary: ${JSON.stringify({ id: last?.id, activity: last?.activity, queue: last?.queue, ui: last?.ui })}`);
};

async function waitProcessExit(pid) {
	const until = Date.now() + 30_000;
	while (Date.now() < until) {
		try { process.kill(pid, 0); }
		catch (error) { if (error.code === "ESRCH") return; throw error; }
		await delay(25);
	}
	assert.fail(`Fixture actor ${pid} released its registry but did not exit`);
}

test("native SDK queues and a pending tool question survive a public host handoff without restarting the tool", { timeout: 120000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-native-handoff-")), data = join(root, "desk"), home = join(root, "runtime");
	mkdirSync(data); mkdirSync(home);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5",
		extensions: [extension], packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-offline-fixture" } }));
	const ready = (digest, desk) => {
		const id = runtimeIdentity(digest, process.platform, process.arch, process.versions.modules);
		const entry = join(versionDirectory(home, id), "source", "pi-desk", "dist", "host"); mkdirSync(entry, { recursive: true });
		for (const name of ["cli.js", "managed.js", "manage-cli.js"]) writeFileSync(join(entry, name), "");
		atomicJson(join(versionDirectory(home, id), "runtime.json"), { format: 1, id, digest, platform: process.platform,
			arch: process.arch, node: process.versions.modules, source: root, readyAt: new Date().toISOString(),
			plugins: "0.29.3", desk, engine: RELEASE.engine });
		return id;
	};
	const active = ready("a".repeat(64), "0.5.23"), target = ready("b".repeat(64), "0.5.24"), pin = versionDirectory(home, active);
	atomicJson(join(home, "state.json"), { format: 1, source: root, active, pending: target, autoApply: target });
	atomicJson(join(home, "installation.json"), { format: 1, directory: data, agentDir: root, cwd: root, port: 0 });
	const first = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	await first.start(); first.runtime = active; first.runtimeHome = home;
	const key = randomUUID(), activation = randomUUID(); let next;
	const worker = new SessionWorker({ cwd: root, agentDir: root, sessionDir: join(root, "sessions"), attachmentScope: key }, message => first.workerEvent(key, message),
		{ directory: data, key, module }, { attach: (...args) => attachWorker(...args.slice(0, 4), { ...args[4], runtimeDirectory: pin }), waitStopped: waitWorkerStopped });
	t.after(async () => { await next?.close(); await first.close(); await worker.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });
	const snapshot = await worker.start();
	assert.deepEqual(snapshot.extensions.filter(extension => extension.error), []);
	const managed = { worker, initialized: true, initialGeneration: snapshot.ui.generation,
		view: { key, activation, cwd: root, created: Date.now(), state: "ready", file: snapshot.file, agentId: snapshot.id, snapshot, ui: snapshot.ui } };
	first.sessions.set(key, managed); first.persist(true);
	await worker.command({ kind: "prompt", text: "Start offline fixture" });
	const asking = await waitSnapshot(worker, state => state.ui.interactions.length === 1);
	assert.equal(asking.ui.interactions[0].form.title, "Lifecycle fixture");
	await worker.command({ kind: "prompt", text: "Steering one", behavior: "steer" });
	await worker.command({ kind: "prompt", text: "Steering two", behavior: "steer" });
	await worker.command({ kind: "prompt", text: "Later follow-up", behavior: "followUp" });
	const queued = await waitSnapshot(worker, state => state.queue.steering.count === 2 && state.queue.followUp.count === 1);
	const child = JSON.parse(readFileSync(join(root, "child.json")));
	const before = readFileSync(snapshot.file), generation = worker.generation;
	const availability = await first.api("operator", { method: "POST", path: "/api/operator-availability", body: { mode: "away" } });
	assert.equal(availability.status, 200, JSON.stringify(availability.body));
	await assertFixtureJobMembers([process.pid, child.pid, child.owner], "native-before");
	assert.equal(first.state().operatorAvailability.mode, "away");
	first.persist(true);
	assert.deepEqual(await activatePreparedRuntime(home, target, "native-handoff"), { release: "0.5.24", restart: true });
	process.kill(child.pid, 0); process.kill(child.owner, 0);
	next = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	const recover = next.recoverUpdateReferences.bind(next);
	next.recoverUpdateReferences = () => { next.runtime = target; next.runtimeHome = home; return recover(); };
	next.scheduleUpdateCheck = () => {};
	await next.start();
	assert.equal(next.state().operatorAvailability.mode, "away");
	const adopted = await next.waitForSession(key); await next.restoreUpdateJob;
	const after = await adopted.worker.command({ kind: "snapshot" });
	assert.equal(after.id, snapshot.id); assert.equal(after.file, snapshot.file);
	assert.equal(adopted.view.activation, activation); assert.equal(adopted.worker.instance, worker.instance);
	assert.equal(adopted.worker.generation, generation); assert.equal(adopted.worker.runtimeDirectory, pin);
	assert.deepEqual(after.accounts, queued.accounts); assert.deepEqual(after.model, queued.model); assert.equal(after.thinking, queued.thinking);
	assert.deepEqual(after.queue, queued.queue); assert.deepEqual(after.ui.interactions, queued.ui.interactions);
	assert.deepEqual(readFileSync(snapshot.file).subarray(0, before.length), before);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "child.json"))), child, "the active native tool was not restarted");
	assert.equal(JSON.parse(readFileSync(join(root, "model-calls.json"))).length, 1, "host replacement cannot start another model turn");
	await assertFixtureJobMembers([process.pid, child.pid, child.owner], "native-after");
	await adopted.worker.command({ kind: "answer", id: after.ui.interactions[0].id, answer: { kind: "freeform", text: "Confirmed" } });
	await waitSnapshot(adopted.worker, state => state.activity === "idle" && !state.ui.interactions.length && !state.queue.steering.count && !state.queue.followUp.count);
	assert.equal(JSON.parse(readFileSync(join(root, "answer.json"))).answer, "Confirmed");
	const calls = JSON.parse(readFileSync(join(root, "model-calls.json")));
	assert.deepEqual(calls, [["Start offline fixture"], ["Start offline fixture", "Steering one", "Steering two"],
		["Start offline fixture", "Steering one", "Steering two", "Later follow-up"]]);
	assert.equal(next.inputs.checkpoint().state, "complete");
});

test("registered SDK subagent, queued follow-up and scoped question survive host replacement without recovery inference", { timeout: 120000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "desk-subagent-handoff-")), data = join(root, "desk"), home = join(root, "runtime");
	mkdirSync(data); mkdirSync(home); writeFileSync(join(root, "sdk-subagent-fixture"), "");
	const subagents = fileURLToPath(new URL("../../pi-subagents/extensions/subagents.ts", import.meta.url));
	const childModule = fileURLToPath(new URL("./fixtures/handoff-subagent-worker.mjs", import.meta.url));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5",
		extensions: [subagents, extension], packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-offline-fixture" } }));
	const ready = (digest, desk) => {
		const id = runtimeIdentity(digest, process.platform, process.arch, process.versions.modules);
		const entry = join(versionDirectory(home, id), "source", "pi-desk", "dist", "host"); mkdirSync(entry, { recursive: true });
		for (const name of ["cli.js", "managed.js", "manage-cli.js"]) writeFileSync(join(entry, name), "");
		atomicJson(join(versionDirectory(home, id), "runtime.json"), { format: 1, id, digest, platform: process.platform,
			arch: process.arch, node: process.versions.modules, source: root, readyAt: new Date().toISOString(), plugins: "0.29.3", desk, engine: RELEASE.engine });
		return id;
	};
	const active = ready("c".repeat(64), "0.5.23"), target = ready("d".repeat(64), "0.5.24"), pin = versionDirectory(home, active);
	atomicJson(join(home, "state.json"), { format: 1, source: root, active, pending: target, autoApply: target });
	atomicJson(join(home, "installation.json"), { format: 1, directory: data, agentDir: root, cwd: root, port: 0 });
	const first = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	await first.start(); first.runtime = active; first.runtimeHome = home;
	const key = randomUUID(), activation = randomUUID(); let next;
	let actorPid;
	const worker = new SessionWorker({ cwd: root, agentDir: root, sessionDir: join(root, "sessions"), attachmentScope: key }, message => first.workerEvent(key, message),
		{ directory: data, key, module: childModule }, { attach: async (...args) => {
			const connection = await attachWorker(...args.slice(0, 4), { ...args[4], runtimeDirectory: pin });
			actorPid = connection.record.pid;
			return connection;
		}, waitStopped: waitWorkerStopped });
	t.after(async () => {
		await next?.close(); await first.close(); await worker.close();
		// Registry release precedes process exit; Windows retains the actor's working directory until exit.
		if (actorPid) await waitProcessExit(actorPid);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
	});
	const snapshot = await worker.start();
	assert.deepEqual(snapshot.extensions.filter(extension => extension.error), []);
	assert.deepEqual(snapshot.accounts, { anthropic: "pi" });
	first.sessions.set(key, { worker, initialized: true, initialGeneration: snapshot.ui.generation,
		view: { key, activation, cwd: root, created: Date.now(), state: "ready", file: snapshot.file, agentId: snapshot.id, snapshot, ui: snapshot.ui } });
	first.persist(true);
	await worker.command({ kind: "prompt", text: "Spawn offline child fixture" });
	const asking = await waitSnapshot(worker, state => state.ui.interactions.length === 1 && state.ui.views.some(view => view.kind === "conversation" && view.data.active));
	const child = JSON.parse(readFileSync(join(root, "child.json"))), question = asking.ui.interactions[0];
	assert.notEqual(child.session, snapshot.id); assert.notEqual(child.file, snapshot.file);
	assert.equal(question.scope.id, child.session);
	const view = asking.ui.views.find(view => view.id === `agent:${child.session}`);
	assert.equal(view.kind, "conversation"); assert.equal(view.data.active, true);
	await worker.command({ kind: "action", view: view.id, revision: view.revision, action: "followup", value: "QUEUED CHILD FOLLOWUP" });
	const queued = await waitSnapshot(worker, state => state.ui.views.find(view => view.id === `agent:${child.session}`)?.data.fields.some(field => field.label === "Queued tasks" && field.value === "1"));
	const entries = () => readFileSync(child.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(entries().find(entry => entry.customType === "pi-desk/provider-accounts").data.selection, snapshot.accounts);
	const childBefore = readFileSync(child.file), rootBefore = readFileSync(snapshot.file);
	const callsBefore = readFileSync(join(root, "subagent-model-calls.json")), generation = worker.generation;
	await assertFixtureJobMembers([process.pid, child.pid, child.owner], "subagent-before");
	assert.equal((await first.api("operator", { method: "POST", path: "/api/operator-availability", body: { mode: "away" } })).status, 200);
	first.persist(true);
	assert.deepEqual(await activatePreparedRuntime(home, target, "subagent-handoff"), { release: "0.5.24", restart: true });
	process.kill(child.pid, 0); process.kill(child.owner, 0);
	next = new DeskHost({ cwd: root, agentDir: root, dataDir: data, port: 0 });
	const recover = next.recoverUpdateReferences.bind(next);
	next.recoverUpdateReferences = () => { next.runtime = target; next.runtimeHome = home; return recover(); };
	next.scheduleUpdateCheck = () => {};
	await next.start(); const adopted = await next.waitForSession(key); await next.restoreUpdateJob;
	const after = await adopted.worker.command({ kind: "snapshot" });
	assert.equal(adopted.worker.instance, worker.instance); assert.equal(adopted.worker.generation, generation);
	assert.equal(adopted.worker.runtimeDirectory, pin); assert.equal(adopted.view.activation, activation);
	assert.deepEqual(after.accounts, snapshot.accounts); assert.deepEqual(after.model, snapshot.model); assert.equal(after.thinking, snapshot.thinking);
	assert.deepEqual(after.ui.interactions, queued.ui.interactions);
	assert.equal(after.ui.views.find(item => item.id === view.id).data.fields.find(field => field.label === "Queued tasks").value, "1");
	assert.deepEqual(readFileSync(child.file), childBefore); assert.deepEqual(readFileSync(snapshot.file).subarray(0, rootBefore.length), rootBefore);
	assert.deepEqual(readFileSync(join(root, "subagent-model-calls.json")), callsBefore, "attachment cannot infer or restart child work");
	assert.deepEqual(JSON.parse(readFileSync(join(root, "child.json"))), child);
	await assertFixtureJobMembers([process.pid, child.pid, child.owner], "subagent-after");
	await adopted.worker.command({ kind: "answer", id: question.id, answer: { kind: "freeform", text: "Confirmed" } });
	await waitSnapshot(adopted.worker, state => state.activity === "idle" && !state.ui.interactions.length && !state.ui.views.some(view => view.kind === "conversation" && view.data.active));
	assert.equal(JSON.parse(readFileSync(join(root, "child-unavailable.json"))).code, "operator_unavailable");
	const calls = JSON.parse(readFileSync(join(root, "subagent-model-calls.json")));
	assert.equal(calls[snapshot.id].length, 2); assert.equal(calls[child.session].length, 2);
	assert.equal(JSON.stringify(calls[child.session].at(-1)).split("QUEUED CHILD FOLLOWUP").length - 1, 1);
	const delivery = entries().filter(entry => entry.customType === "pi-subagents/delivery-v1");
	const accepted = entries().filter(entry => entry.customType === "pi-subagents/inbox-v1" && entry.data.action === "accepted");
	const finished = delivery.filter(entry => entry.data.action === "finished");
	assert.equal(accepted.length, 2); assert.equal(finished.length, 1);
	assert.deepEqual(finished[0].data.consumedFollowups, [accepted[1].data.messageId]);
	assert.equal(next.inputs.checkpoint().state, "complete");
});

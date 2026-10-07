import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { WorkerEndpoint, WorkerChannel } from "../src/host/worker-channel.ts";
import { WorkerRequests } from "../src/host/worker-requests.ts";
import { StaleGeneration } from "../src/host/worker-errors.ts";

const identity = () => ({ instance: randomUUID(), secret: randomBytes(32).toString("hex") });
const command = (id, name = "Example") => ({ type: "command", id, generation: "generation", command: { kind: "name", name } });
function messages() {
	const waiting = new Map(), received = new Map();
	return {
		receive(message) {
			const waiter = waiting.get(message.id)?.shift();
			if (waiter) waiter(message);
			else { const queue = received.get(message.id) ?? []; queue.push(message); received.set(message.id, queue); }
		},
		wait(id) {
			const message = received.get(id)?.shift();
			if (message) return Promise.resolve(message);
			return new Promise(resolve => { const queue = waiting.get(id) ?? []; queue.push(resolve); waiting.set(id, queue); });
		},
	};
}

test("reconnecting recovers an accepted result without repeating work or losing the managed child", async t => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	t.after(async () => { const exit = once(child, "exit"); child.kill(); await exit; });
	let calls = 0, finish, admitted;
	const pending = new Promise(resolve => { finish = resolve; });
	const acceptance = new Promise(resolve => { admitted = resolve; });
	const receipts = new WorkerRequests(async () => { calls++; admitted(); return pending; });
	const endpoint = await WorkerEndpoint.listen(identity(), request => receipts.run(request),
		() => [{ type: "ui", snapshot: { generation: "same-generation" } }]);
	t.after(() => endpoint.close());
	const firstMessages = messages();
	const first = await WorkerChannel.connect(endpoint.address, firstMessages.receive, () => {});
	first.send(command("accepted"));
	await acceptance;
	await first.detach();
	assert.equal(child.exitCode, null);
	assert.equal(child.signalCode, null);
	process.kill(child.pid, 0);
	const secondMessages = messages();
	const second = await WorkerChannel.connect(endpoint.address, secondMessages.receive, () => {});
	t.after(() => second.detach());
	assert.equal((await secondMessages.wait(undefined)).snapshot.generation, "same-generation");
	second.send(command("accepted"));
	finish({ pid: child.pid, account: "retained-account" });
	const result = await secondMessages.wait("accepted");
	assert.deepEqual(result.value, { pid: child.pid, account: "retained-account" });
	assert.equal(calls, 1);
	second.send(command("accepted"));
	assert.deepEqual((await secondMessages.wait("accepted")).value, result.value);
	assert.equal(calls, 1);
	const thirdMessages = messages();
	await second.detach();
	const third = await WorkerChannel.connect(endpoint.address, thirdMessages.receive, () => {});
	t.after(() => third.detach());
	third.send(command("accepted", "Changed"));
	assert.equal((await thirdMessages.wait("accepted")).code, "receipt_conflict");
	assert.equal(calls, 1);
});

test("an unauthenticated peer cannot execute commands or evict the attached host", async t => {
	let calls = 0;
	const endpoint = await WorkerEndpoint.listen(identity(), async request => ({ type: "result", id: request.id, value: ++calls }));
	t.after(() => endpoint.close());
	const inbox = messages();
	const attached = await WorkerChannel.connect(endpoint.address, inbox.receive, () => {});
	t.after(() => attached.detach());
	await assert.rejects(WorkerChannel.connect({ ...endpoint.address, secret: "0".repeat(64) }, () => {}, () => {}), /authenticated/);
	await assert.rejects(WorkerChannel.connect({ ...endpoint.address, instance: "different-instance" }, () => {}, () => {}), /authenticated/);
	const raw = createConnection({ host: "127.0.0.1", port: endpoint.address.port });
	raw.on("error", () => {});
	await once(raw, "connect");
	const closed = new Promise(resolve => raw.once("close", resolve));
	raw.write(JSON.stringify(command("unauthenticated")) + "\n");
	await closed;
	attached.send(command("attached"));
	assert.equal((await inbox.wait("attached")).value, 1);
	assert.equal(calls, 1);
});

test("worker receipts retain failures, retire old writes and refresh reads", async () => {
	let reads = 0, writes = 0;
	const receipts = new WorkerRequests(async request => {
		if (request.type === "command" && ["snapshot", "native_read"].includes(request.command.kind)) return ++reads;
		writes++;
		if (request.id === "failure") throw new StaleGeneration();
		return writes;
	});
	assert.equal((await receipts.run(command("failure"))).code, "stale_generation");
	assert.equal((await receipts.run(command("failure"))).code, "stale_generation");
	assert.equal(writes, 1);
	for (let i = 0; i < 256; i++) await receipts.run(command(`write-${i}`));
	assert.equal((await receipts.run(command("failure"))).code, "receipt_conflict");
	const snapshot = { type: "command", id: "read", generation: "generation", command: { kind: "snapshot" } };
	assert.equal((await receipts.run(snapshot)).value, 1);
	assert.equal((await receipts.run(snapshot)).value, 2);
	const opening = { type: "command", id: "open-file", generation: "generation", command: { kind: "file", operation: "open", id: "fixture", origin: {} } };
	const beforeOpen = writes;
	await receipts.run(opening); await receipts.run(opening);
	assert.equal(writes, beforeOpen + 1, "lost acknowledgement must not reopen a file twice");
	const nativeRead = { ...snapshot, id: "native-read", command: { kind: "native_read", name: "session", args: "" } };
	assert.equal((await receipts.run(nativeRead)).value, 3);
	assert.equal((await receipts.run(nativeRead)).value, 4, "native read adapters remain fresh");
});

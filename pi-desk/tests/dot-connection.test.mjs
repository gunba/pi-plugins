import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DotConnection } from "../src/host/dot.ts";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "desk-dot-direct-connection-"));
	const opened = [], posts = [], callbacks = [], clients = [];
	let selected, failing = false, uncertain = false;
	const options = { account(id) { selected = id; return { path: join(directory, id), name: "Fixture account" }; },
		client(_authorize, changed) {
			const account = selected, read = { dot: "fixture-dot", room: "room", name: "Fixture", path: "/dots/thread", paused: false, entries: [] };
			const client = { identity: { accountId: account, userId: "owner", accountUserId: "owner" }, connected: true, writing: false, avatarView: {}, closed: false,
				async open(pin) { opened.push({ account, pin }); if (failing) throw Error("Fixture sign-in unavailable"); return read; },
				async read() { return read; }, async history() { return { entries: [] }; }, close() { this.closed = true; },
				async send(id, text, files, dispatch) { dispatch(); posts.push({ id, text, files, account }); if (uncertain) throw Error("Fixture reply lost");
					return { message: { id: `remote-${id}` }, requestId: id, files: [] }; },
				async attach(_file, _path, dispatch) { dispatch(); return "remote-file"; },
			}; callbacks.push(changed); clients.push(client); return client;
		} };
	const dot = new DotConnection(directory, directory, options);
	t.after(async () => { await dot.close(); rmSync(directory, { recursive: true, force: true }); });
	return { dot, options, directory, opened, posts, callbacks, clients, fail(value) { failing = value; }, uncertain(value) { uncertain = value; } };
}

test("a direct connection changes only after candidate confirmation and scopes future inputs to its account", async t => {
	const f = fixture(t), first = randomUUID(), second = randomUUID();
	await f.dot.connect(first); const before = await f.dot.view();
	assert.equal(before.transport, "direct"); assert.equal(before.account, first); assert.match(before.connection, /^[a-f0-9]{64}$/);
	f.fail(true); await assert.rejects(f.dot.connect(second), /unavailable/);
	assert.equal((await f.dot.view()).account, first); assert.equal(f.clients[0].closed, false); assert.equal(f.clients[1].closed, true);
	f.fail(false); await f.dot.connect(second); const after = await f.dot.view();
	assert.equal(after.id, before.id); assert.notEqual(after.connection, before.connection); assert.equal(f.clients[0].closed, true);
	assert.throws(() => f.dot.send(randomUUID(), after.id, "Old account", [], before.connection), /account or conversation changed/);
	assert.equal(f.posts.length, 0);
	const id = randomUUID(); f.dot.send(id, after.id, "Current account", [], after.connection); await f.dot.work;
	assert.equal((await f.dot.input(id)).state, "accepted"); assert.equal(f.posts[0].account, second);
});

test("unconfirmed direct delivery survives restart and stale account events never accept another connection's input", async t => {
	const f = fixture(t), first = randomUUID(), second = randomUUID(); f.uncertain(true);
	await f.dot.connect(first); const before = await f.dot.view(), id = randomUUID();
	f.dot.send(id, before.id, "One attempt", [], before.connection); await f.dot.work;
	assert.equal((await f.dot.input(id)).state, "unknown"); assert.equal(f.posts.length, 1);
	await f.dot.connect(second);
	f.callbacks[0]({ type: "receipt", request: id, message: "late-old-client" });
	f.callbacks.at(-1)({ type: "receipt", request: id, message: "wrong-account" });
	assert.equal((await f.dot.input(id)).state, "unknown");
	assert.equal(f.dot.send(id, before.id, "One attempt", [], before.connection).state, "unknown"); assert.equal(f.posts.length, 1);
	await f.dot.close();
	const restored = new DotConnection(f.directory, f.directory, f.options);
	try { assert.equal((await restored.input(id)).state, "unknown"); assert.equal(restored.send(id, before.id, "One attempt", [], before.connection).state, "unknown"); }
	finally { await restored.close(); }
	assert.equal(f.posts.length, 1);
});

test("uploaded files are bound to the connection and removed only after durable acceptance", async t => {
	const f = fixture(t); await f.dot.connect(randomUUID()); const view = await f.dot.view(), file = randomUUID();
	assert.throws(() => f.dot.stageFile(file, view.id, "file.txt", "text/plain", 4, "f".repeat(64)), /changed/);
	f.dot.stageFile(file, view.id, "file.txt", "text/plain", 4, view.connection); f.dot.appendFile(file, 0, Buffer.from("data").toString("base64"));
	const id = randomUUID(); f.dot.send(id, view.id, "File", [file], view.connection); await f.dot.work;
	assert.equal((await f.dot.input(id)).state, "accepted"); assert.equal(f.dot.files.get(file), undefined);
	assert.deepEqual(f.posts[0].files, ["remote-file"]);
});

test("the existing root delivery ledger fences accepted and interrupted sends after the transport changes", async t => {
 const f = fixture(t); await f.dot.close();
 const accepted = { id: randomUUID(), dot: "legacy-dot", text: "Already sent", state: "accepted", created: "2026-01-01T00:00:00Z", messageId: "remote" };
 const interrupted = { ...accepted, id: randomUUID(), text: "Unconfirmed", state: "sending", messageId: undefined };
 for (const input of [accepted, interrupted]) writeFileSync(join(f.directory, "dot", `${input.id}.json`), JSON.stringify(input));
 const original = readFileSync(join(f.directory, "dot", `${accepted.id}.json`), "utf8");
 const restored = new DotConnection(f.directory, f.directory, f.options);
 try {
  assert.equal((await restored.input(accepted.id))?.state, "accepted");
  assert.equal((await restored.input(interrupted.id))?.state, "unknown");
  assert.equal(restored.send(accepted.id, accepted.dot, accepted.text, []).state, "accepted");
  assert.equal(restored.send(interrupted.id, interrupted.dot, interrupted.text, []).state, "unknown");
  assert.equal(f.posts.length, 0);
  assert.equal(readFileSync(join(f.directory, "dot", `${accepted.id}.json`), "utf8"), original);
  assert.equal(JSON.parse(readFileSync(join(f.directory, "dot", `${interrupted.id}.json`))).state, "unknown");
  assert.equal(existsSync(join(f.directory, "dot", "inputs")), false);
 } finally { await restored.close(); }
});

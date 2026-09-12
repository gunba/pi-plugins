import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { PartyStore, LEASE_MS } from "./store.ts";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-test-"));
	let time = 1_000_000;
	const a = new PartyStore(directory, () => time);
	const b = new PartyStore(directory, () => time);
	t.after(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); });
	return { a, b, directory, advance: ms => { time += ms; } };
}

test("two database connections exchange messages only after explicit membership", t => {
	const { a, b } = fixture(t);
	a.join("first", "owner-a", "1", "Studio topics");
	assert.throws(() => b.send("second", "owner-b", "first", "hello", true), /membership/);
	b.join("second", "owner-b", "1", "Studio skills");
	a.join("unrelated", "owner-c", "2", "Other client");
	assert.equal(a.members("first", "owner-a").length, 2);
	assert.throws(() => a.send("first", "owner-a", "unrelated", "no", true), /member ID/);
	const [sent] = a.send("first", "owner-a", "sec", "Check the revised topic", true);
	assert.equal(b.pending("second", "owner-b")[0].id, sent.id);
	assert.equal(b.pending("second", "owner-b")[0].sender_label, "Studio topics");
	b.admit("second", "owner-b", [sent.id]);
	assert.deepEqual(b.pending("second", "owner-b"), []);
});

test("owner leases fence duplicate processes and preserve inbox across reconnect", t => {
	const { a, b, advance } = fixture(t);
	a.join("first", "a", "one", "First");
	b.join("second", "b", "one", "Second");
	const [sent] = a.send("first", "a", "second", "Waiting", false);
	assert.throws(() => a.join("second", "replacement", "one", "Second"), /another Pi process/);
	advance(LEASE_MS + 1);
	const oldEpoch = b.member("second").epoch;
	a.join("second", "replacement", "one", "Second");
	assert.equal(a.member("second").epoch, oldEpoch);
	assert.equal(a.pending("second", "replacement")[0].id, sent.id);
	assert.throws(() => b.send("second", "b", "first", "stale", true), /owned/);
	b.release("second", "b");
	assert.equal(a.member("second").owner, "replacement");
});

test("leave and room switching revoke queued deliveries rather than leaking into rejoined sessions", t => {
	const { a, b } = fixture(t);
	a.join("first", "a", "one", "First");
	b.join("second", "b", "one", "Second");
	a.send("first", "a", "second", "old room", true);
	b.leave("second", "b");
	b.join("second", "b", "one", "Second");
	assert.deepEqual(b.pending("second", "b"), []);
	a.send("first", "a", "second", "sender leaving", true);
	a.join("first", "a", "two", "First");
	assert.deepEqual(b.pending("second", "b"), []);
	assert.equal(b.members("second", "b").length, 1);
});

test("broadcast delivery is atomic when any inbox is full", t => {
	const { a } = fixture(t);
	for (const id of ["first", "second", "third"]) a.join(id, id, "1", id);
	for (let i = 0; i < 64; i++) a.send("first", "first", "third", `message ${i}`, false);
	assert.throws(() => a.send("first", "first", "all", "broadcast", false), /full/);
	assert.equal(a.pending("second", "second").length, 0);
	assert.equal(a.pending("third", "third").length, 64);
});

test("automatic wake budget is bounded across database connections and reconnects", t => {
	const { a, b } = fixture(t);
	a.join("first", "owner", "1", "First");
	for (let i = 0; i < 8; i++) assert.equal(a.reserveWake("first", "owner"), true);
	assert.equal(b.reserveWake("first", "owner"), false);
	a.release("first", "owner");
	b.join("first", "new", "1", "First");
	assert.equal(b.reserveWake("first", "new"), false);
	b.resetWakes("first", "new");
	assert.equal(b.reserveWake("first", "new"), true);
});

test("room and message validation, ambiguity, and receipt ownership", t => {
	const { a } = fixture(t);
	assert.throws(() => a.join("x", "x", "../secrets", "x"), /Party IDs/);
	for (const id of ["first", "peer-a", "peer-b"]) a.join(id, id, "CASE", id);
	assert.equal(a.member("first").room, "case");
	assert.throws(() => a.send("first", "first", "peer", "ambiguous", false), /unambiguous/);
	for (const text of ["", " \t\n"]) {
		assert.throws(() => a.send("first", "first", "all", text, false), /non-whitespace/);
	}
	const [sent] = a.send("first", "first", "peer-a", "private", false);
	a.admit("peer-b", "peer-b", [sent.id]);
	assert.equal(a.pending("peer-a", "peer-a").length, 1);
});

test("large Unicode messages survive broadcast and independent database reads intact", t => {
	const { a, b } = fixture(t);
	for (const id of ["first", "second", "third"]) a.join(id, id, "1", id);
	const text = "Detailed findings 🧪\n".repeat(10_000);
	const sent = a.send("first", "first", "all", text, false);
	assert.equal(sent.length, 2);
	for (const recipient of ["second", "third"]) {
		const [message] = b.pending(recipient, recipient);
		assert.equal(message.text, text);
		assert.equal(message.wake, 0);
		b.admit(recipient, recipient, [message.id]);
		assert.deepEqual(b.pending(recipient, recipient), []);
	}
});

test("independent Node processes commit messages through the shared SQLite store", { timeout: 30000 }, async t => {
	const { a, directory } = fixture(t);
	a.join("recipient", "parent", "ipc", "Recipient");
	const source = new URL("./store.ts", import.meta.url).href;
	const code = `import { PartyStore } from ${JSON.stringify(source)};
		const db = new PartyStore(process.argv[1]);
		const id = process.argv[2];
		db.join(id, id, "ipc", id);
		for (let i = 0; i < 10; i++) db.send(id, id, "recipient", id + ":" + i, false);
		db.release(id, id); db.close();`;
	await Promise.all(["sender-a", "sender-b"].map(id => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code, directory, id], { stdio: ["ignore", "ignore", "pipe"] });
		t.after(() => { if (child.exitCode === null) child.kill(); });
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(Error(stderr)));
	})));
	const messages = a.pending("recipient", "parent");
	assert.equal(messages.length, 20);
	assert.equal(new Set(messages.map(message => message.id)).size, 20);
	assert.equal(messages.filter(message => message.sender === "sender-a").length, 10);
	assert.equal(messages.filter(message => message.sender === "sender-b").length, 10);
	a.admit("recipient", "parent", messages.map(message => message.id));
	assert.deepEqual(a.pending("recipient", "parent"), []);
});

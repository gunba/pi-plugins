import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { PartyStore, LEASE_MS } from "./store.ts";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-test-"));
	let time = 1_000_000;
	const a = new PartyStore(directory, () => time);
	const b = new PartyStore(directory, () => time);
	t.after(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); });
	return { a, b, directory, advance: ms => { time += ms; } };
}

test("registered agents exchange direct messages across party boundaries", t => {
	const { a, b } = fixture(t);
	a.join("first", "owner-a", "1", "Studio topics");
	assert.throws(() => b.send("second", "owner-b", "first", "hello", true), /registration/);
	b.join("second", "owner-b", "1", "Studio skills");
	a.join("unrelated", "owner-c", "2", "Other client");
	assert.equal(a.members("first", "owner-a").length, 2);
	a.send("first", "owner-a", "unrelated", "Direct coordination", true);
	assert.equal(a.pending("unrelated", "owner-c")[0].room, "");
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
	assert.throws(() => a.register("second", "replacement", "Second"), /another Pi process/);
	advance(LEASE_MS + 1);
	const oldEpoch = b.member("second").epoch;
	a.register("second", "replacement", "Second");
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
	a.send("first", "a", "all", "old room", true);
	b.leave("second", "b");
	b.join("second", "b", "one", "Second");
	assert.deepEqual(b.pending("second", "b"), []);
	a.send("first", "a", "all", "sender leaving", true);
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
	b.register("first", "new", "First");
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

test("history pages are complete, ordered, room-scoped and cannot admit or wake recipients", t => {
	const { a, b } = fixture(t);
	a.join("first", "a", "chat", "Studio cleanup");
	b.join("second", "b", "chat", "Copilot Skills");
	a.join("other", "c", "elsewhere", "Other room");
	a.join("other-peer", "d", "elsewhere", "Other peer");
	a.send("other", "c", "all", "Private to another room", true);
	const messages = Array.from({ length: 53 }, (_, i) => a.send("first", "a", "all", i === 0 ? "Long Unicode 🧪\n".repeat(10000) : `Message ${i}`, true)[0]);
	b.admit("second", "b", messages.slice(0, 25).map(message => message.id));
	const state = JSON.stringify([b.member("second"), b.pending("second", "b")]);
	const latest = b.history("second", "b");
	assert.equal(latest.messages.length, 20);
	assert.equal(latest.hasOlder, true);
	assert.equal(latest.hasNewer, false);
	const middle = b.history("second", "b", { before: latest.messages[0] });
	const first = b.history("second", "b", { before: middle.messages[0] });
	const all = [...first.messages, ...middle.messages, ...latest.messages];
	assert.equal(all.length, 53);
	assert.equal(new Set(all.map(message => message.id)).size, 53);
	assert.deepEqual(all.map(message => message.id), messages.map(message => message.id).sort());
	assert.equal(all.find(message => message.id === messages[0].id).text, messages[0].text);
	assert.ok(all.every(message => message.sender_label === "Studio cleanup" && message.recipient_label === "Copilot Skills"));
	assert.equal(all.filter(message => message.admitted).length, 25);
	assert.equal(first.hasOlder, false);
	assert.equal(first.hasNewer, true);
	assert.deepEqual(b.history("second", "b", { oldest: true }).messages.map(message => message.id), all.slice(0, 20).map(message => message.id));
	assert.deepEqual(b.history("second", "b", { after: middle.messages.at(-1) }).messages, latest.messages);
	assert.equal(JSON.stringify([b.member("second"), b.pending("second", "b")]), state);
	assert.throws(() => b.history("second", "wrong-owner"), /owned/);
	b.touch("second", "b", "idle", "Renamed conversation");
	assert.equal(a.history("first", "a").messages[0].recipient_label, "Renamed conversation");
	b.admit("second", "b", messages.map(message => message.id));
	b.leave("second", "b");
	assert.equal(a.history("first", "a").messages[0].recipient_label, "Former member");
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

test("discovery registers ungrouped agents, searches metadata, and excludes expired leases", t => {
	const { a, b, advance } = fixture(t);
	a.register("a", "a", "Wire transport", "C:/repo", "session");
	b.register("b", "b", "Untitled", "C:/repo/tests", "child");
	b.profile("b", "b", "Investigating WebSocket disconnects");
	assert.equal(a.member("a").room, "");
	assert.deepEqual(a.discover("websocket").agents.map(x => x.session), ["b"]);
	assert.deepEqual(a.discover("C:/repo").agents.map(x => x.session), ["a", "b"]);
	assert.equal(a.discover("b").agents[0].kind, "child");
	advance(LEASE_MS + 1);
	a.touch("a", "a", "working");
	assert.deepEqual(a.discover().agents.map(x => x.session), ["a"]);
	assert.equal(a.discover("", true).agents.length, 2);
	b.release("b", "b");
	assert.equal(a.discover().agents.length, 1);
	for (let i = 0; i < 55; i++) a.register(`peer-${i.toString().padStart(2, "0")}`, "owner", "peer");
	const first = a.discover(), next = a.discover("", false, first.nextOffset);
	assert.equal(first.agents.length, 50);
	assert.equal(next.agents.length, 6);
	assert.equal(new Set([...first.agents, ...next.agents].map(x => x.session)).size, 56);
	assert.equal(next.nextOffset, undefined);
});

test("invitations are direct messages, never implicit membership changes", t => {
	const { a, b } = fixture(t);
	a.join("a", "a", "research", "Research");
	b.join("b", "b", "other", "Implementation");
	a.register("c", "c", "Observer");
	const epoch = b.member("b").epoch;
	const [invitation] = a.send("a", "a", "b", "Compare transport findings?", true, "research");
	assert.equal(invitation.kind, "invite");
	assert.equal(invitation.invite_room, "research");
	assert.equal(b.member("b").room, "other");
	assert.equal(b.member("b").epoch, epoch);
	assert.equal(b.pending("b", "b")[0].id, invitation.id);
	assert.equal(a.history("a", "a").messages.length, 0);
	assert.equal(a.history("c", "c", undefined, true).messages.length, 0);
	b.join("b", "b", invitation.invite_room, "Implementation");
	assert.equal(b.members("b", "b").length, 2);
	assert.equal(b.pending("b", "b")[0].id, invitation.id, "joining does not discard direct messages");
});

test("any member can remove a peer without removing its registration or direct inbox", t => {
	const { a, b } = fixture(t);
	a.join("a", "a", "team", "A"); b.join("b", "b", "team", "B");
	a.join("c", "c", "elsewhere", "C");
	const [group] = a.send("a", "a", "all", "Room-only", true);
	const [direct] = a.send("a", "a", "b", "Private", true);
	const old = b.member("b");
	assert.throws(() => a.remove("c", "c", "b"), /unambiguous/);
	assert.throws(() => a.remove("a", "wrong", "b"), /owned/);
	a.remove("a", "a", "b");
	assert.equal(b.member("b").room, "");
	assert.equal(b.member("b").owner, old.owner);
	assert.equal(b.member("b").agent_epoch, old.agent_epoch);
	assert.notEqual(b.member("b").epoch, old.epoch);
	assert.equal(b.isCurrent("b", "b", group.id), false);
	assert.deepEqual(b.pending("b", "b").map(x => x.id), [direct.id]);
	b.join("b", "b", "team", "B");
	b.remove("b", "b", "a");
	assert.equal(a.member("a").room, "");
	assert.equal(b.history("b", "b", undefined, true).messages[0].id, direct.id);
});

test("direct history is participant-only and exact IDs take precedence over prefixes", t => {
	const { a } = fixture(t);
	for (const id of ["a", "peer", "peer-long", "observer"]) a.join(id, id, "team", id);
	a.send("a", "a", "peer", "Private note", false);
	assert.equal(a.pending("peer", "peer").length, 1);
	assert.equal(a.pending("peer-long", "peer-long").length, 0);
	assert.equal(a.history("observer", "observer", undefined, true).messages.length, 0);
	assert.equal(a.history("observer", "observer").messages.length, 0);
	a.leave("peer", "peer");
	assert.equal(a.history("peer", "peer").messages[0].text, "Private note");
	assert.throws(() => a.send("peer", "peer", "all", "no room", true), /requires a party/);
	assert.throws(() => a.send("a", "a", "a", "self", true), /unambiguous/);
});

test("upgrading the original database preserves membership, inbox and admitted receipts", t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-upgrade-"));
	const old = new DatabaseSync(join(directory, "party.sqlite"));
	old.exec(`CREATE TABLE members (session TEXT PRIMARY KEY,room TEXT NOT NULL,epoch TEXT NOT NULL,label TEXT NOT NULL,owner TEXT NOT NULL,heartbeat INTEGER NOT NULL,state TEXT NOT NULL,wakes INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE messages (id TEXT PRIMARY KEY,room TEXT NOT NULL,sender TEXT NOT NULL,sender_epoch TEXT NOT NULL,sender_label TEXT NOT NULL,recipient TEXT NOT NULL,recipient_epoch TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,wake INTEGER NOT NULL,admitted INTEGER NOT NULL DEFAULT 0);
		INSERT INTO members VALUES ('a','team','ea','A','a',0,'offline',0),('b','team','eb','B','b',0,'offline',7);
		INSERT INTO messages VALUES ('pending','team','a','ea','A','b','eb','Old pending',1,1,0),('done','team','a','ea','A','b','eb','Old delivered',2,0,1);`);
	old.close();
	const db = new PartyStore(directory);
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	db.register("b", "new-owner", "B");
	assert.equal(db.member("b").epoch, "eb");
	assert.equal(db.member("b").wakes, 7);
	assert.deepEqual(db.pending("b", "new-owner").map(x => x.id), ["pending"]);
	assert.equal(db.history("b", "new-owner").messages.length, 2);
	db.admit("b", "new-owner", ["pending"]);
	assert.equal(db.pending("b", "new-owner").length, 0);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { PartyStore, LEASE_MS } from "./store.ts";
import { PartyOperations } from "./operations.ts";
import { randomUUID } from "node:crypto";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-test-"));
	let time = 1_000_000;
	const a = new PartyStore(directory, () => time);
	const b = new PartyStore(directory, () => time);
	t.after(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); });
	return { a, b, directory, advance: ms => { time += ms; } };
}

test("late lifecycle results cannot overwrite a stopped controller's receipt", async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-controller-test-"));
	const store = new PartyStore(directory), operations = new PartyOperations(directory);
	t.after(() => { operations.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
	operations.startHost();
	const sender = randomUUID(), owner = randomUUID();
	store.register(sender, owner, sender);
	const request = operations.queue(store, sender, owner, { kind: "create", cwd: directory, task: "Start", label: "New" });
	let finish;
	const pending = operations.receive("local", request, () => new Promise(resolve => { finish = resolve; }));
	operations.startHost();
	finish({ session: randomUUID(), state: "queued" });
	assert.match((await pending).error, /host stopped/);
	const repeated = await operations.receive("local", request, () => assert.fail("Must not replay an interrupted operation"));
	assert.match(repeated.error, /host stopped/);
	assert.match(operations.recent(sender).find(row => row.id === request.id).response.error, /host stopped/);
});
test("registered agents exchange direct messages", t => {
	const { a, b } = fixture(t);
	a.register("first", "owner-a", "Studio topics");
	assert.throws(() => b.send("second", "owner-b", "first", "hello", true), /registration/);
	b.register("second", "owner-b", "Studio skills");
	a.register("unrelated", "owner-c", "Other client");
	const sent = a.send("first", "owner-a", "sec", "Check the revised topic", true);
	assert.equal(b.pending("second", "owner-b")[0].id, sent.id);
	assert.equal(b.pending("second", "owner-b")[0].sender_label, "Studio topics");
	assert.deepEqual(a.pending("unrelated", "owner-c"), []);
	b.admit("second", "owner-b", [sent.id]);
	assert.deepEqual(b.pending("second", "owner-b"), []);
});
test("owner leases fence duplicate processes and preserve inbox across reconnect", t => {
	const { a, b, advance } = fixture(t);
	a.register("first", "a", "First");
	b.register("second", "b", "Second");
	const sent = a.send("first", "a", "second", "Waiting", false);
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

test("automatic wake budget is bounded across database connections and reconnects", t => {
	const { a, b } = fixture(t);
	a.register("first", "owner", "First");
	for (let i = 0; i < 8; i++) assert.equal(a.reserveWake("first", "owner"), true);
	assert.equal(b.reserveWake("first", "owner"), false);
	a.release("first", "owner");
	b.register("first", "new", "First");
	assert.equal(b.reserveWake("first", "new"), false);
	b.resetWakes("first", "new");
	assert.equal(b.reserveWake("first", "new"), true);
});

test("message validation, ambiguity, full inboxes and receipt ownership", t => {
	const { a } = fixture(t);
	for (const id of ["first", "peer-a", "peer-b"]) a.register(id, id, id);
	assert.throws(() => a.send("first", "first", "peer", "ambiguous", false), /unambiguous/);
	for (const text of ["", " \t\n"]) assert.throws(() => a.send("first", "first", "peer-a", text, false), /non-whitespace/);
	const sent = a.send("first", "first", "peer-a", "private", false);
	a.admit("peer-b", "peer-b", [sent.id]);
	assert.equal(a.pending("peer-a", "peer-a").length, 1);
	for (let i = 1; i < 64; i++) a.send("first", "first", "peer-a", `message ${i}`, false);
	assert.throws(() => a.send("first", "first", "peer-a", "overflow", false), /full/);
});
test("large Unicode messages survive independent database reads intact", t => {
	const { a, b } = fixture(t);
	for (const id of ["first", "second"]) a.register(id, id, id);
	const text = "Detailed findings 🧪\n".repeat(10_000);
	a.send("first", "first", "second", text, false);
	const [message] = b.pending("second", "second");
	assert.equal(message.text, text);
	assert.equal(message.wake, 0);
	b.admit("second", "second", [message.id]);
	assert.deepEqual(b.pending("second", "second"), []);
});
test("history pages are complete, ordered, participant-scoped and cannot admit or wake recipients", t => {
	const { a, b } = fixture(t);
	a.register("first", "a", "Studio cleanup");
	b.register("second", "b", "Copilot Skills");
	a.register("other", "c", "Other");
	a.register("other-peer", "d", "Other peer");
	a.send("other", "c", "other-peer", "Private to others", true);
	const messages = Array.from({ length: 53 }, (_, i) => a.send("first", "a", "second", i === 0 ? "Long Unicode 🧪\n".repeat(10000) : `Message ${i}`, true));
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
});

test("independent Node processes commit messages through the shared SQLite store", { timeout: 30000 }, async t => {
	const { a, directory } = fixture(t);
	a.register("recipient", "parent", "Recipient");
	const source = new URL("./store.ts", import.meta.url).href;
	const code = `import { PartyStore } from ${JSON.stringify(source)};
		const db = new PartyStore(process.argv[1]);
		const id = process.argv[2];
		db.register(id, id, id);
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

test("network discovery retains active agents beyond a large archived registry", t => {
	const { a } = fixture(t);
	for (let i = 0; i < 700; i++) {
		const id = `00000000-0000-4000-a000-${i.toString(16).padStart(12, "0")}`;
		a.register(id, "owner", "Archived"); a.release(id, "owner");
	}
	const live = "ffffffff-ffff-4fff-afff-ffffffffffff";
	a.register(live, "live-owner", "Active");
	const directory = a.networkDirectory();
	assert.equal(directory.length, 1, "released agents are not advertised to other computers");
	assert.equal(directory.find(peer => peer.session === live)?.state, "idle");
	assert.ok(directory.every(peer => !("owner" in peer) && !("heartbeat" in peer)));
});

test("direct history is participant-only and exact IDs take precedence over prefixes", t => {
	const { a } = fixture(t);
	for (const id of ["a", "peer", "peer-long", "observer"]) a.register(id, id, id);
	a.send("a", "a", "peer", "Private note", false);
	assert.equal(a.pending("peer", "peer").length, 1);
	assert.equal(a.pending("peer-long", "peer-long").length, 0);
	assert.equal(a.history("observer", "observer").messages.length, 0);
	assert.equal(a.history("peer", "peer").messages[0].text, "Private note");
	assert.throws(() => a.send("a", "a", "a", "self", true), /unambiguous/);
});
test("upgrading a party database keeps direct messages and receipts and drops group state", t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-upgrade-"));
	const old = new DatabaseSync(join(directory, "party.sqlite"));
	old.exec(`CREATE TABLE members (session TEXT PRIMARY KEY,room TEXT NOT NULL,epoch TEXT NOT NULL,label TEXT NOT NULL,owner TEXT NOT NULL,heartbeat INTEGER NOT NULL,state TEXT NOT NULL,wakes INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE messages (id TEXT PRIMARY KEY,room TEXT NOT NULL,sender TEXT NOT NULL,sender_epoch TEXT NOT NULL,sender_label TEXT NOT NULL,recipient TEXT NOT NULL,recipient_epoch TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,wake INTEGER NOT NULL,admitted INTEGER NOT NULL DEFAULT 0);
		INSERT INTO members VALUES ('a','team','ea','A','a',0,'offline',0),('b','team','eb','B','b',0,'offline',7);
		INSERT INTO messages VALUES ('pending','','a','ea','A','b','eb','Old pending',1,1,0),('done','','a','ea','A','b','eb','Old delivered',2,0,1),
			('broadcast','team','a','ea','A','b','eb','Old broadcast',3,1,0);`);
	old.close();
	const db = new PartyStore(directory);
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	db.register("b", "new-owner", "B");
	assert.equal(db.member("b").room, "");
	assert.equal(db.member("b").wakes, 0, "legacy batch counts cannot represent autonomous idle starts");
	assert.deepEqual(db.pending("b", "new-owner").map(x => x.id), ["pending"]);
	assert.equal(db.history("b", "new-owner").messages.length, 2);
	db.admit("b", "new-owner", ["pending"]);
	assert.equal(db.pending("b", "new-owner").length, 0);
});

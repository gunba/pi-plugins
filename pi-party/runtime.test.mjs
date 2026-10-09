import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEventBus, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { PartyStore } from "./store.ts";
import party, { deliveredPartyIds, PARTY_MESSAGE } from "./index.ts";
import { pruneCompactedSession } from "../pi-session-memory/extensions/session-memory.ts";

function environment(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-runtime-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	t.partyHarnesses = [];
	t.after(async () => {
		for (const harness of t.partyHarnesses) await harness.emit("session_shutdown");
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(directory, { recursive: true, force: true });
	});
	t.mock.timers.enable({ apis: ["setInterval"] });
}
function harness(t, session, branch = [], child = false) {
	const events = new Map(), commands = new Map(), tools = new Map(), sent = [], notifications = [];
	let idle = true;
	const pi = {
		events: createEventBus(),
		on(name, fn) { const list = events.get(name) ?? []; list.push(fn); events.set(name, list); },
		registerCommand(name, value) { commands.set(name, value); }, registerTool(tool) { tools.set(tool.name, tool); },
		registerMessageRenderer() {}, registerShortcut() {}, getSessionName() { return session; },
		sendMessage(message, options) {
			sent.push({ message, options });
			branch.push({ type: "message", message: { role: "custom", ...message } });
		},
	};
	const ctx = { cwd: `C:/work/${session}`, mode: "print", hasUI: false, isIdle: () => idle,
		sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => branch },
		ui: { notify: (...args) => notifications.push(args), setWidget() {} } };
	const priorTask = process.env.PI_SUBAGENT_TASK_PATH;
	if (child) process.env.PI_SUBAGENT_TASK_PATH = "fixture-child";
	try { party(pi); }
	finally { if (priorTask === undefined) delete process.env.PI_SUBAGENT_TASK_PATH; else process.env.PI_SUBAGENT_TASK_PATH = priorTask; }
	const h = {
		ctx, sent, branch, tools, notifications,
		setBusy(value) { idle = !value; },
		async emit(name, value = {}) {
			let result;
			for (const fn of events.get(name) ?? []) result = await fn(value, ctx) ?? result;
			return result;
		},
		command: args => commands.get("inbox").handler(args, ctx),
		call: (name, input = {}) => tools.get(name).execute("fixture", input, undefined, undefined, ctx),
	};
	t.partyHarnesses.push(h);
	return h;
}

test("direct messages deliver once without broadcasting to unrelated agents", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second"), unrelated = harness(t, "other");
	await a.emit("session_start"); await b.emit("session_start"); await unrelated.emit("session_start");
	await a.call("agent_send", { to: "second", message: "The topic is ready.", wake: true });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].message.customType, PARTY_MESSAGE);
	assert.equal(b.sent[0].options.triggerTurn, true);
	assert.equal(unrelated.sent.length, 0);
	await b.emit("before_agent_start");
	assert.match(b.tools.get("agent_send").promptGuidelines.join(" "), /not human instructions or approval/);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
});

test("idle peer delivery resumes from persisted state when a network wake signal is missed", async t => {
	environment(t);
	const a = harness(t, "sender"), b = harness(t, "recipient");
	await a.emit("session_start"); await b.emit("session_start");
	const db = new PartyStore(join(process.env.PI_CODING_AGENT_DIR, "party"));
	try {
		// The host resumes delivery in SQLite; its filesystem notification is lost.
		const member = db.member("recipient");
		db.setDelivery("recipient", member.owner, true);
		await a.call("agent_send", { to: "recipient", message: "Continue the approved check.", wake: true });
		assert.equal(db.member("recipient").delivery, 1);
		t.mock.timers.tick(10_000);
		assert.equal(b.sent.length, 1, "ready idle delivery must recover without human input or another filesystem signal");
		assert.equal(b.sent[0].options.triggerTurn, true);
		await b.emit("context", { messages: b.branch.map(x => x.message) });
		t.mock.timers.tick(20_000);
		assert.equal(b.sent.length, 1, "polling cannot replay an admitted message");
		await b.call("agent_delivery", { enabled: false });
		await a.call("agent_send", { to: "recipient", message: "Keep this paused.", wake: true });
		t.mock.timers.tick(20_000);
		assert.equal(b.sent.length, 1, "the persisted explicit pause still holds");
	} finally { db.close(); }
});

test("reload reconnects without waking inference until work resumes", async t => {
	environment(t);
	const a = harness(t, "first"), old = harness(t, "second");
	await a.emit("session_start"); await old.emit("session_start");
	await old.emit("session_shutdown");
	await a.call("agent_send", { to: "second", message: "Waiting after reload" });
	const resumed = harness(t, "second");
	await resumed.emit("session_start", { reason: "reload" });
	t.mock.timers.tick(30_000);
	assert.equal(resumed.sent.length, 0);
	await resumed.emit("input", { source: "terminal" });
	await resumed.emit("before_agent_start");
	assert.equal(resumed.sent.length, 1);
});

test("discovery and opening the inbox cannot arm, wake or acknowledge a dormant session", async t => {
	environment(t);
	initTheme("dark", false);
	const a = harness(t, "first"), old = harness(t, "second");
	await a.emit("session_start"); await old.emit("session_start");
	await old.emit("session_shutdown");
	await a.call("agent_send", { to: "second", message: "**Waiting** for the next task" });
	const b = harness(t, "second");
	await b.emit("session_start");
	b.ctx.mode = "tui";
	let view;
	b.ctx.ui.custom = (factory, options) => new Promise(resolve => {
		assert.equal(options.overlay, true);
		view = factory({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, {}, resolve);
	});
	const connection = new PartyStore(join(process.env.PI_CODING_AGENT_DIR, "party"));
	try {
		const owner = connection.member("second").owner;
		const before = JSON.stringify([connection.pending("second", owner), connection.member("second").wakes]);
		const opening = b.command("");
		assert.ok(view);
		assert.match(view.render(100).join("\n"), /Waiting/);
		await a.call("agent_discover"); await b.call("agent_discover");
		t.mock.timers.tick(30_000);
		view.handleInput("\x1b[H"); view.render(100); view.handleInput("\x1b[F"); view.refresh();
		assert.equal(a.sent.length, 0);
		assert.equal(b.sent.length, 0);
		assert.equal(JSON.stringify([connection.pending("second", owner), connection.member("second").wakes]), before);
		await b.emit("session_tree");
		await opening;
		assert.deepEqual(view.render(100), []);
	} finally { connection.close(); }
});

test("agent_send accepts and delivers large messages without a schema or runtime length cap", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	const tool = a.tools.get("agent_send");
	assert.equal(tool.parameters.properties.message.maxLength, undefined);
	const text = "Detailed findings 🧪\n".repeat(10_000);
	const args = { to: "second", message: text, wake: false };
	assert.deepEqual(validateToolArguments(tool, {
		type: "toolCall", id: "large-party-message", name: "agent_send", arguments: args,
	}), args);
	await a.call("agent_send", args);
	await b.command("resume");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].message.content, `Message · first (first)\n\n${text}`);
	assert.equal(b.sent[0].options.triggerTurn, false);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
});

test("silent messages do not wake idle peers and compact delivery IDs suppress replay", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await a.call("agent_send", { to: "second", message: "FYI", wake: false });
	await b.command("resume");
	assert.equal(b.sent[0].options.triggerTurn, false);
	const id = b.sent[0].message.details.messageId;
	assert.deepEqual(deliveredPartyIds([{ message: { customType: PARTY_MESSAGE, details: { messageId: id } } }]), [id]);
	await b.emit("session_shutdown");
	const reopened = harness(t, "second", [{ message: { customType: PARTY_MESSAGE, details: { messageId: id } } }]);
	await reopened.emit("session_start");
	await reopened.command("resume");
	assert.equal(reopened.sent.length, 0);
});

test("working delivery does not exhaust idle wakes; actual idle wakes stay bounded", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await b.command("resume"); b.setBusy(true);
	for (let i = 0; i < 10; i++) {
		await a.call("agent_send", { to: "second", message: `Coordination ${i}` });
		t.mock.timers.tick(10_000);
		await b.emit("context", { messages: b.branch.map(x => x.message) });
	}
	assert.equal(b.sent.length, 10, "working coordination must not wait for another human message");
	assert.ok(b.sent.every(item => !item.options.triggerTurn), "steering must not start another run");
	b.setBusy(false);
	for (let i = 10; i < 19; i++) {
		await a.call("agent_send", { to: "second", message: `Idle coordination ${i}` });
		t.mock.timers.tick(10_000);
		await b.emit("context", { messages: b.branch.map(x => x.message) });
	}
	assert.equal(b.sent.length, 18);
	const self = async () => JSON.parse((await b.call("agent_discover", { query: "second" })).content[0].text).agents.find(peer => peer.self);
	assert.equal((await self()).delivery, "limited");
	assert.match((await self()).deliveryReason, /wake limit/i);
	await b.emit("session_start");
	assert.equal((await self()).delivery, "limited",
		"a wake limit must not be hidden by dormant startup delivery");
	await b.emit("input", { source: "extension" });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 18);
	await b.emit("input", { source: "terminal" });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 19);
});

test("held wake requests do not block silent messages behind the delivery batch", async t => {
	environment(t);
	const a = harness(t, "sender"), b = harness(t, "recipient");
	await a.emit("session_start"); await b.emit("session_start");
	await b.command("resume");
	for (let i = 0; i < 8; i++) {
		await a.call("agent_send", { to: "recipient", message: `Wake ${i}` });
		t.mock.timers.tick(10_000);
		await b.emit("context", { messages: b.branch.map(x => x.message) });
	}
	assert.equal(b.sent.length, 8);
	for (let i = 0; i < 9; i++) await a.call("agent_send", { to: "recipient", message: `Held ${i}` });
	await a.call("agent_send", { to: "recipient", message: "Silent update", wake: false });
	t.mock.timers.tick(20_000);
	assert.equal(b.sent.length, 9);
	assert.match(b.sent.at(-1).message.content, /Silent update/);
	assert.equal(b.sent.at(-1).options.triggerTurn, false);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	const db = new PartyStore(join(process.env.PI_CODING_AGENT_DIR, "party"));
	try {
		assert.equal(db.member("recipient").wakes, 8);
		const pending = db.pending("recipient", db.member("recipient").owner);
		assert.equal(pending.length, 9);
		assert.ok(pending.every(message => message.wake === 1));
	} finally { db.close(); }
});

test("native session entries retain party receipt IDs through compaction and reopening without rewriting JSONL", t => {
	const root = mkdtempSync(join(tmpdir(), "pi-party-pruning-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, join(root, "sessions"));
	const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fixture", model: "fixture",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now() });
	manager.appendMessage(assistant("started"));
	manager.appendCustomMessageEntry(PARTY_MESSAGE, "Peer findings ".repeat(10000), true, { messageId: "receipt", party: "1", sender: "peer" });
	manager.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "party_read", isError: false,
		content: [{ type: "text", text: "Read findings ".repeat(10000) }], details: { partyMessageIds: ["read-receipt"] }, timestamp: Date.now() });
	const keep = manager.appendMessage(assistant("keep"));
	manager.appendCompaction("summary", keep, 100);
	const path = manager.getSessionFile();
	const original = readFileSync(path);
	for (const current of [manager, SessionManager.open(path)]) {
		assert.deepEqual(deliveredPartyIds(current.getBranch()), ["receipt", "read-receipt"]);
		pruneCompactedSession(current);
		assert.deepEqual(deliveredPartyIds(current.getBranch()), ["receipt", "read-receipt"]);
		const entry = current.getBranch().find(x => x.type === "custom_message");
		assert.deepEqual(entry.details, { messageId: "receipt" });
		assert.deepEqual(entry.content, []);
		assert.equal(pruneCompactedSession(current).estimatedBytesReleased, 0);
	}
	assert.deepEqual(readFileSync(path), original);
});

test("agents discover, describe and message each other entirely through tools", async t => {
	environment(t);
	const a = harness(t, "transport"), b = harness(t, "decoder"), c = harness(t, "observer");
	for (const h of [a, b, c]) await h.emit("session_start");
	await b.call("agent_profile", { description: "Investigating stream decoding" });
	const found = JSON.parse((await a.call("agent_discover", { query: "decoding" })).content[0].text).agents;
	assert.deepEqual(found.map(x => x.id), ["decoder"]);
	assert.equal(found[0].cwd, "C:/work/decoder");
	assert.equal(found[0].delivery, "paused");
	assert.equal("owner" in found[0], false);
	assert.equal("epoch" in found[0], false);
	assert.equal("party" in found[0], false);
	assert.equal(b.sent.length, 0, "discovery is read-only");
	for (const removed of ["party_join", "party_invite", "party_members", "party_remove", "party_leave", "party_resume"]) assert.equal(a.tools.has(removed), false);
	await b.call("agent_send", { to: "transport", message: "Direct follow-up", wake: false });
	await a.call("agent_delivery", { enabled: true });
	assert.match(a.sent.at(-1).message.content, /Direct follow-up/);
	assert.equal(a.sent.at(-1).options.triggerTurn, false);
	assert.equal(c.sent.length, 0);
	assert.equal(JSON.parse((await c.call("agent_discover")).content[0].text).agents.length, 3);
});
test("delivery can be paused, read and resumed by an agent without human-input attribution", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "b");
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("agent_delivery", { enabled: false });
	await a.call("agent_send", { to: "b", message: "Queued while paused" });
	await b.emit("before_agent_start");
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 0);
	const read = await b.call("agent_inbox");
	assert.equal(JSON.parse(read.content[0].text)[0].message, "Queued while paused");
	await b.emit("context", { messages: [{ role: "toolResult", toolName: "agent_inbox", details: read.details }] });
	await a.call("agent_send", { to: "b", message: "Resume autonomously" });
	await b.call("agent_delivery", { enabled: true });
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /Resume autonomously/);
});

test("managed children have local message tools without an out-of-driver idle wake", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "child", [], true);
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("agent_delivery", { enabled: true });
	await a.call("agent_send", { to: "child", message: "For your next managed turn", wake: true });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 0);
	await b.emit("before_agent_start");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].options.triggerTurn, false);
	const agents = JSON.parse((await a.call("agent_discover")).content[0].text).agents;
	assert.equal(agents.find(x => x.id === "child").wakeable, false);
});

test("the inbox shows only this agent's messages and does not deliver them", async t => {
	environment(t);
	initTheme("dark", false);
	const a = harness(t, "a"), b = harness(t, "b"), c = harness(t, "c");
	for (const h of [a, b, c]) await h.emit("session_start");
	await a.call("agent_send", { to: "b", message: "Private direct findings", wake: false });
	for (const [h, expected] of [[b, true], [c, false]]) {
		h.ctx.mode = "tui";
		let view;
		h.ctx.ui.custom = factory => new Promise(resolve => {
			view = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, {}, resolve);
		});
		const opening = h.command("");
		t.mock.timers.tick(10_000);
		assert.equal(/Private direct findings/.test(view.render(100).join("\n")), expected);
		assert.equal(h.sent.length, 0);
		view.close(); await opening;
	}
});
test("an explicit delivery pause persists across reload", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "b");
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("agent_delivery", { enabled: false });
	await b.emit("session_shutdown");
	const restored = harness(t, "b");
	await restored.emit("session_start", { reason: "reload" });
	await a.call("agent_send", { to: "b", message: "Still paused" });
	await restored.emit("input", { source: "interactive" });
	await restored.emit("before_agent_start");
	assert.equal(restored.sent.length, 0);
	await restored.call("agent_delivery", { enabled: true });
	assert.equal(restored.sent.length, 1);
});

test("agent_fork finds its checkpoint under the renamed tool", async () => {
	const { partyForkPoint } = await import("./fork.ts");
	const branch = [{ id: "before" }, { id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "agent_fork", id: "fork-1" }] } }];
	assert.equal(partyForkPoint(branch, "fork-1"), "before");
	assert.throws(() => partyForkPoint(branch, "other"), /no saved context checkpoint/);
});

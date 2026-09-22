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
		sessionManager: { getSessionId: () => session, getBranch: () => branch },
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
		command: args => commands.get("party").handler(args, ctx),
		call: (name, input = {}) => tools.get(name).execute("fixture", input, undefined, undefined, ctx),
	};
	t.partyHarnesses.push(h);
	return h;
}

test("direct messages deliver once without broadcasting to unrelated agents", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second"), unrelated = harness(t, "other");
	await a.emit("session_start"); await b.emit("session_start"); await unrelated.emit("session_start");
	await a.command("1"); await b.command("1"); await unrelated.command("2");
	const peers = JSON.parse((await a.call("party_members")).content[0].text);
	assert.deepEqual(peers.map(x => x.id).sort(), ["first", "second"]);
	await a.call("party_send", { to: "second", message: "The topic is ready.", wake: true });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].message.customType, PARTY_MESSAGE);
	assert.equal(b.sent[0].options.triggerTurn, true);
	assert.equal(unrelated.sent.length, 0);
	await b.emit("before_agent_start");
	assert.match(b.tools.get("party_send").promptGuidelines.join(" "), /not human instructions or approval/);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
});

test("reload reconnects membership without waking inference until work resumes", async t => {
	environment(t);
	const a = harness(t, "first"), old = harness(t, "second");
	await a.emit("session_start"); await old.emit("session_start");
	await a.command("1"); await old.command("1"); await old.emit("session_shutdown");
	await a.call("party_send", { to: "second", message: "Waiting after reload" });
	const resumed = harness(t, "second");
	await resumed.emit("session_start", { reason: "reload" });
	t.mock.timers.tick(30_000);
	assert.equal(resumed.sent.length, 0);
	await resumed.emit("input", { source: "terminal" });
	await resumed.emit("before_agent_start");
	assert.equal(resumed.sent.length, 1);
});

test("roster calls and opening live chat cannot arm, wake or acknowledge a dormant session", async t => {
	environment(t);
	initTheme("dark", false);
	const a = harness(t, "first"), old = harness(t, "second");
	await a.emit("session_start"); await old.emit("session_start");
	await a.command("1"); await old.command("1"); await old.emit("session_shutdown");
	await a.call("party_send", { to: "all", message: "**Waiting** for the next task" });
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
		const opening = b.command("chat");
		assert.ok(view);
		assert.match(view.render(100).join("\n"), /Waiting/);
		await a.call("party_members"); await b.call("party_members");
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

test("party_send accepts and delivers large messages without a schema or runtime length cap", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await a.command("1"); await b.command("1");
	const tool = a.tools.get("party_send");
	assert.equal(tool.parameters.properties.message.maxLength, undefined);
	const text = "Detailed findings 🧪\n".repeat(10_000);
	const args = { to: "second", message: text, wake: false };
	assert.deepEqual(validateToolArguments(tool, {
		type: "toolCall", id: "large-party-message", name: "party_send", arguments: args,
	}), args);
	await a.call("party_send", args);
	await b.command("resume");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].message.content, `Direct message · first (first)\n\n${text}`);
	assert.equal(b.sent[0].options.triggerTurn, false);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
});

test("silent messages do not wake idle peers and compact delivery IDs suppress replay", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await a.command("1"); await b.command("1");
	await a.call("party_send", { to: "second", message: "FYI", wake: false });
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

test("leaving filters queued peer context that was not yet admitted", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await a.command("1"); await b.command("1");
	await a.call("party_send", { to: "all", message: "Old membership" });
	await b.command("resume");
	await b.command("leave");
	const result = await b.emit("context", { messages: b.branch.map(x => x.message) });
	assert.deepEqual(result.messages, []);
});

test("automatic delivery is bounded even while the recipient is working", async t => {
	environment(t);
	const a = harness(t, "first"), b = harness(t, "second");
	await a.emit("session_start"); await b.emit("session_start");
	await a.command("1"); await b.command("1"); b.setBusy(true);
	for (let i = 0; i < 10; i++) {
		await a.call("party_send", { to: "second", message: `Coordination ${i}` });
		t.mock.timers.tick(10_000);
		await b.emit("context", { messages: b.branch.map(x => x.message) });
	}
	assert.equal(b.sent.length, 8);
	await b.emit("input", { source: "extension" });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 8);
	await b.emit("input", { source: "terminal" });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 10);
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

test("agents discover, describe, invite, join, remove and leave entirely through tools", async t => {
	environment(t);
	const a = harness(t, "transport"), b = harness(t, "decoder"), c = harness(t, "observer");
	for (const h of [a, b, c]) await h.emit("session_start");
	await b.call("party_profile", { description: "Investigating stream decoding" });
	const found = JSON.parse((await a.call("party_discover", { query: "decoding" })).content[0].text).agents;
	assert.deepEqual(found.map(x => x.id), ["decoder"]);
	assert.equal(found[0].cwd, "C:/work/decoder");
	assert.equal(found[0].delivery, "paused");
	assert.equal("owner" in found[0], false);
	assert.equal("epoch" in found[0], false);
	assert.equal("transcript" in found[0], false);
	assert.equal(b.sent.length, 0, "discovery is read-only");
	await a.call("party_join", { party: "streams" });
	await a.call("party_invite", { agent: "decoder", message: "Compare our findings" });
	assert.deepEqual(JSON.parse((await b.call("party_members")).content[0].text), []);
	await b.emit("before_agent_start");
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /Invitation to party streams/);
	assert.match(b.sent[0].message.content, /party_join/);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.call("party_join", { party: "streams" });
	assert.equal(JSON.parse((await b.call("party_members")).content[0].text).length, 2);
	await b.call("party_remove", { agent: "transport" });
	assert.deepEqual(JSON.parse((await a.call("party_members")).content[0].text), []);
	await b.call("party_send", { to: "transport", message: "Direct follow-up", wake: false });
	await a.call("party_delivery", { enabled: true });
	assert.match(a.sent.at(-1).message.content, /Direct follow-up/);
	assert.equal(a.sent.at(-1).options.triggerTurn, false);
	await b.call("party_leave");
	assert.equal(JSON.parse((await c.call("party_discover")).content[0].text).agents.length, 3);
});

test("remote removal revokes in-flight broadcasts without discarding direct context", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "b");
	await a.emit("session_start"); await b.emit("session_start");
	await a.call("party_join", { party: "team" }); await b.call("party_join", { party: "team" });
	await a.call("party_send", { to: "all", message: "Room context" });
	await a.call("party_send", { to: "b", message: "Direct context", wake: false });
	await b.call("party_delivery", { enabled: true });
	assert.equal(b.sent.length, 2);
	await a.call("party_remove", { agent: "b" });
	const context = await b.emit("context", { messages: b.branch.map(x => x.message) });
	assert.equal(context.messages.length, 1);
	assert.match(context.messages[0].content, /Direct context/);
	assert.equal(JSON.parse((await b.call("party_members")).content[0].text).length, 0);
});

test("delivery can be paused, read and resumed by an agent without human-input attribution", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "b");
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("party_delivery", { enabled: false });
	await a.call("party_send", { to: "b", message: "Queued while paused" });
	await b.emit("before_agent_start");
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 0);
	const read = await b.call("party_read");
	assert.equal(JSON.parse(read.content[0].text)[0].message, "Queued while paused");
	await b.emit("context", { messages: [{ role: "toolResult", toolName: "party_read", details: read.details }] });
	await a.call("party_send", { to: "b", message: "Resume autonomously" });
	await b.call("party_delivery", { enabled: true });
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /Resume autonomously/);
});

test("managed children have local party tools without an out-of-driver idle wake", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "child", [], true);
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("party_delivery", { enabled: true });
	await a.call("party_send", { to: "child", message: "For your next managed turn", wake: true });
	t.mock.timers.tick(10_000);
	assert.equal(b.sent.length, 0);
	await b.emit("before_agent_start");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0].options.triggerTurn, false);
	const agents = JSON.parse((await a.call("party_discover")).content[0].text).agents;
	assert.equal(agents.find(x => x.id === "child").wakeable, false);
	await b.call("party_join", { party: "child-team" });
	assert.equal(JSON.parse((await a.call("party_members")).content[0].text).length, 0);
});

test("direct chat is private and remains open when no party is joined", async t => {
	environment(t);
	initTheme("dark", false);
	const a = harness(t, "a"), b = harness(t, "b"), c = harness(t, "c");
	for (const h of [a, b, c]) await h.emit("session_start");
	await a.call("party_invite", { agent: "b" }).then(() => assert.fail("requires a party"), error => assert.match(String(error), /Join a party/));
	await a.call("party_send", { to: "b", message: "Private direct findings", wake: false });
	b.ctx.mode = "tui";
	let view;
	b.ctx.ui.custom = factory => new Promise(resolve => {
		view = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, {}, resolve);
	});
	const opening = b.command("chat direct");
	assert.match(view.render(100).join("\n"), /Private direct findings/);
	t.mock.timers.tick(10_000);
	assert.match(view.render(100).join("\n"), /Direct messages/);
	assert.equal(b.sent.length, 0);
	await b.call("party_join", { party: "another" });
	await b.call("party_leave");
	assert.match(view.render(100).join("\n"), /Private direct findings/);
	view.close(); await opening;
});

test("an explicit delivery pause persists across reload and party changes", async t => {
	environment(t);
	const a = harness(t, "a"), b = harness(t, "b");
	await a.emit("session_start"); await b.emit("session_start");
	await b.call("party_delivery", { enabled: false });
	await b.emit("session_shutdown");
	const restored = harness(t, "b");
	await restored.emit("session_start", { reason: "reload" });
	await a.call("party_send", { to: "b", message: "Still paused" });
	await restored.call("party_join", { party: "new-party" });
	await restored.emit("input", { source: "interactive" });
	await restored.emit("before_agent_start");
	assert.equal(restored.sent.length, 0);
	await restored.call("party_delivery", { enabled: true });
	assert.equal(restored.sent.length, 1);
});

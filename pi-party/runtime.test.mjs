import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
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
function harness(t, session, branch = []) {
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
	const ctx = { mode: "print", hasUI: false, isIdle: () => idle,
		sessionManager: { getSessionId: () => session, getBranch: () => branch },
		ui: { notify: (...args) => notifications.push(args), setWidget() {} } };
	party(pi);
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

test("independent main sessions exchange explicit peer messages without exposing other rooms", async t => {
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
	const guidance = await b.emit("before_agent_start");
	assert.match(guidance.message.content, /not human instructions or approval/);
	await b.emit("context", { messages: b.branch.map(x => x.message) });
	await b.command("resume");
	assert.equal(b.sent.length, 1);
});

test("reload reconnects membership but cannot wake inference until the human rearms it", async t => {
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
	assert.equal(b.sent[0].message.content, `Party 1 · first (first)\n\n${text}`);
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
	await a.call("party_send", { to: "second", message: "Old membership" });
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

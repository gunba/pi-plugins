import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DotApi } from "../src/host/dot-api.ts";
import { dotEntry, dotRoom } from "../src/host/dot-wire.ts";

const identity = { accountId: "account", userId: "owner", accountUserId: "owner" };
const profile = { id: "dot", display_name: "Fixture Dot", messaging_room_id: "room", active_root_thread_id: null, status: "active", is_paused: false };
const room = { id: "room", aeon_id: "dot", name: "Fixture Dot", type: "DM", app_source: "chatgpt:messaging",
	members: [{ account_user_id: "owner", name: "Owner" }, { account_user_id: "bot", aeon_id: "dot", name: "Fixture Dot" }] };
const row = (id, sender, body, request_id) => ({ id, role: "user", account_user_id: sender, content: { text: body }, request_id, created_at: "2026-01-01T00:00:00Z" });
class Socket extends EventEmitter {
	commands = [];
	send(text) { const commands = JSON.parse(text); this.commands.push(...commands);
		queueMicrotask(() => this.emit("message", JSON.stringify([{ id: 2, reply: { type: "subscribe", topic_id: "calpico-chatgpt-messaging", recovered: false, last_offset: "one" } }]))); }
	close() { this.emit("close"); }
	terminate() { this.close(); }
}
function fixture(t, transform = value => value) {
	const requests = [], events = [], socket = new Socket();
	const http = { async json(method, path, options) {
		requests.push({ method, path, body: options?.body }); options?.onDispatch?.();
		if (path === "/tbo/by-thread/thread") return profile;
		if (path === "/messaging/rooms/room") return room;
		if (path === "/celsius/ws/user") return { websocket_url: "wss://ws.chatgpt.com/fixture" };
		if (path.startsWith("/messaging/rooms/room/messages?")) return { items: [row("one", "owner", "Hi"), row("two", "bot", "Hello")], prev_cursor: null };
		if (method === "POST" && path === "/messaging/rooms/room/messages") return transform(row("sent", "owner", options.body.content.text, options.body.request_id));
		throw Error(`Unexpected fixture request ${method} ${path}`);
	}, socket() { queueMicrotask(() => socket.emit("open")); return socket; }, close() {} };
	const api = new DotApi(async () => ({ token: "fixture", identity }), event => events.push(event), undefined, http);
	t.after(() => api.close()); return { api, requests, events, socket };
}

test("direct Dot reads and live receipts work without a browser renderer", async t => {
	const { api, requests, events, socket } = fixture(t);
	const view = await api.open({ dot: "dot", path: "/dots/thread", room: "room" });
	assert.deepEqual(view.entries.map(entry => [entry.message.author, entry.message.text]), [["owner", "Hi"], ["dot", "Hello"]]);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(api.connected, true); assert.equal(view.path, "/dots/thread");
	assert.equal(socket.commands[0].command.presence.state, "background");
	const emit = room_id => socket.emit("message", JSON.stringify([{ type: "message", topic_id: "calpico-chatgpt-messaging", offset: "two",
		payload: { type: "calpico-message-add", payload: { room_id, message: { request_id: "request", id: "sent" } } } }]));
	emit("another-room"); assert.equal(events.filter(event => event.type === "receipt").length, 0);
	emit("room"); assert.deepEqual(events.find(event => event.type === "receipt"), { type: "receipt", request: "request", message: "sent" });
	assert.ok(requests.every(request => request.method === "GET"));
});

test("direct Dot sends retain one request identity and never retry an unconfirmed reply", async t => {
	const { api, requests } = fixture(t, value => ({ ...value, request_id: "different-request" }));
	await api.open({ dot: "dot", path: "/dots/thread" });
	let dispatched = 0;
	await assert.rejects(api.send("request", "Hello", [], () => dispatched++), /did not confirm/);
	assert.equal(dispatched, 1);
	const posts = requests.filter(request => request.method === "POST");
	assert.equal(posts.length, 1);
	assert.deepEqual(posts[0].body, { content: { text: "Hello" }, request_id: "request", idempotency_token: "request" });
});

test("direct history keeps internal assistant content out of displayed messages", () => {
	const parsedRoom = dotRoom(room, { id: "dot", room: "room", name: "Fixture Dot" });
	const message = (body, extra = {}) => ({ author: { role: "assistant" }, content: { content_type: "text", parts: [body] }, ...extra });
	const entry = dotEntry({ id: "raw", created_at: "2026-01-01T00:00:00Z", raw_messages: [
		message("private analysis", { channel: "analysis" }), message("hidden", { metadata: { is_hidden: true } }),
		message("tool arguments", { recipient: "browser" }), message("::SKIP_COMPLETION::"), message("Visible answer"),
	] }, parsedRoom, identity);
	assert.equal(entry.message.text, "Visible answer"); assert.equal(entry.message.author, "dot");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { ClientHandshake, verifyHostAdmission } from "../src/shared/account-channel.ts";
import { newSecret, PROTOCOL_VERSION } from "../src/shared/secure-channel.ts";
import { API_VERSION } from "../src/shared/release.ts";
import { accountFixture } from "./account-fixture.mjs";

async function relayPeer(t, input = () => {}) {
	const server = createServer(), sockets = new WebSocketServer({ server });
	let connector, channel;
	t.after(async () => {
		connector?.close(); channel?.close();
		for (const socket of sockets.clients) socket.terminate();
		sockets.close(); await new Promise(resolve => server.close(resolve));
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const fixture = await accountFixture({ relayOrigin: origin });
	const host = await fixture.device("host"), browser = await fixture.device("browser");
	const handshake = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	const peer = crypto.randomUUID(), nonce = newSecret();
	let publish, ready, closed, failed;
	const available = new Promise(resolve => { ready = resolve; });
	const disconnection = new Promise((resolve, reject) => { closed = resolve; failed = reject; });
	sockets.on("connection", socket => {
		socket.send(JSON.stringify({ type: "admission", protocol: PROTOCOL_VERSION, nonce }));
		socket.on("message", raw => {
			void (async () => {
				const message = JSON.parse(raw.toString());
				if (message.credential && !message.type) {
					await verifyHostAdmission(message, origin, nonce, host.device.id, fixture.verifier);
					socket.send(JSON.stringify({ type: "admitted", protocol: PROTOCOL_VERSION }));
					socket.send(JSON.stringify({ type: "opened", peer }));
					socket.send(JSON.stringify({ type: "frame", peer, frame: JSON.stringify(handshake.offer) }));
					return;
				}
				if (message.type === "close") { closed(message.code); return; }
				if (message.type !== "frame") return;
				if (!channel) {
					const session = await handshake.finish(JSON.parse(message.frame), {
						output: frame => socket.send(JSON.stringify({ type: "frame", peer, frame })),
						input, failed,
					});
					channel = session.channel;
					await channel.send({ type: "hello", api: API_VERSION });
				} else channel.receive(message.frame);
			})().catch(failed);
		});
	});
	connector = new RelayConnector({
		appOrigin: "https://app.example", account: {
			...host, config: fixture.config, verifier: () => fixture.verifier, heartbeat: async () => {},
			lease: async peers => ({ allowed: peers.map(peer => peer.id), expires: Math.floor(Date.now() / 1000) + 60 }),
		},
		status: () => {}, request: async () => ({ status: 200, body: {} }),
		watch: handler => { publish = handler; ready(); return () => {}; },
	});
	connector.start(); await Promise.race([available, disconnection.then(code => { throw new Error(`Disconnected before ready: ${code}`); })]);
	return { publish: event => publish(event), disconnection, send: message => channel.send(message) };
}

test("a backed-up relay peer disconnects without reporting that its account access was revoked", { timeout: 5000 }, async t => {
	const { publish, disconnection } = await relayPeer(t);
	for (let index = 0; index < 40; index++) publish({
		type: "worker", key: "sample", message: { type: "chat", generation: "g", message: {
			id: String(index), role: "assistant", order: index, revision: index, timestamp: 0,
			blocks: [{ type: "text", text: "x".repeat(1024 * 1024) }],
		} },
	});
	assert.equal(await disconnection, 1013);
});

test("replaceable session snapshots coalesce instead of disconnecting a slow display", { timeout: 15_000 }, async t => {
	const received = [];
	let delivered, blocked, finished;
	const latest = new Promise(resolve => { delivered = resolve; });
	const waitingForCredit = new Promise(resolve => { blocked = resolve; });
	const drained = new Promise(resolve => { finished = resolve; });
	let distinct = 0, acknowledge = false;
	const peer = await relayPeer(t, packet => {
		if (packet.type !== "event") return;
		received.push(packet);
		if (packet.event.session?.name === "79") delivered();
		if (packet.event.session?.key.startsWith("distinct:")) {
			if (++distinct === 13) blocked();
			if (acknowledge) void peer.send({ type: "events_ack", sequence: packet.sequence });
			if (distinct === 14) finished();
		}
	});
	for (let index = 0; index < 80; index++) {
		peer.publish({ type: "session", session: { key: "sample", name: String(index), error: "x".repeat(624_000),
			controls: index < 40 ? [] : [{ id: "kept", state: index === 40 ? "running" : "completed" }] } });
		if (index === 40) peer.publish({ type: "worker", key: "sample", message: { type: "control", control: { id: "kept", state: "completed" } } });
	}
	await Promise.race([latest, peer.disconnection.then(code => {
		throw new Error(`Replaceable panel refreshes closed the connection: ${code}`);
	})]);
	assert.equal(received.at(-1)?.event.session.name, "79");
	assert.deepEqual(received.filter(packet => packet.event.type === "worker").map(packet => packet.event.message.control.id), ["kept"]);
	assert.deepEqual(received.filter(packet => packet.event.session?.controls?.length)
		.map(packet => packet.event.session.controls[0].state), ["running", "completed"]);
	assert.ok(received.length <= 6, "superseded snapshots must not reach the wire");
	await peer.send({ type: "events_ack", sequence: received.at(-1).sequence });
	for (let index = 0; index < 14; index++) peer.publish({ type: "session", session: {
		key: `distinct:${index}`, name: String(index), error: "x".repeat(624_000),
	} });
	await Promise.race([waitingForCredit, peer.disconnection.then(code => { throw new Error(`Credit exhaustion closed the connection: ${code}`); })]);
	acknowledge = true;
	await peer.send({ type: "events_ack", sequence: received.at(-1).sequence });
	await Promise.race([drained, peer.disconnection.then(code => { throw new Error(`Credit resume closed the connection: ${code}`); })]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { ClientHandshake, verifyHostAdmission } from "../src/shared/account-channel.ts";
import { newSecret, PROTOCOL_VERSION } from "../src/shared/secure-channel.ts";
import { API_VERSION } from "../src/shared/release.ts";
import { accountFixture } from "./account-fixture.mjs";

test("a backed-up relay peer disconnects without reporting that its account access was revoked", { timeout: 5000 }, async t => {
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
						input: () => {}, failed,
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
	for (let index = 0; index < 40; index++) publish({
		type: "worker", key: "sample", message: { type: "chat", generation: "g", message: {
			id: String(index), role: "assistant", order: index, revision: index, timestamp: 0,
			blocks: [{ type: "text", text: "x".repeat(1024 * 1024) }],
		} },
	});
	assert.equal(await disconnection, 1013);
});

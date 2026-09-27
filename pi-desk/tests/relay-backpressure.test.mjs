import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AccessStore } from "../src/host/access.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { SecureChannel, newSecret, PROTOCOL_VERSION } from "../src/shared/secure-channel.ts";
import { API_VERSION } from "../src/shared/release.ts";

test("a backed-up relay peer disconnects without reporting that its valid pairing was revoked", { timeout: 5000 }, async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-backpressure-"));
	const server = createServer(), sockets = new WebSocketServer({ server });
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const access = new AccessStore(directory), invitation = access.inviteRemote(), key = newSecret();
	access.claimRemote(invitation.id, invitation.key, key, "Sample");
	const peer = crypto.randomUUID(), nonce = newSecret();
	let channel, publish, ready, closed;
	const available = new Promise(resolve => { ready = resolve; });
	const disconnection = new Promise(resolve => { closed = resolve; });
	sockets.on("connection", socket => {
		socket.send(JSON.stringify({ type: "opened", peer }));
		socket.send(JSON.stringify({ type: "frame", peer, frame: JSON.stringify({
			type: "identify", protocol: PROTOCOL_VERSION, api: API_VERSION, nonce, device: invitation.id,
		}) }));
		socket.on("message", async raw => {
			const message = JSON.parse(raw.toString());
			if (message.type === "close") { closed(message.code); return; }
			if (message.type !== "frame") return;
			const frame = JSON.parse(message.frame);
			if (frame.type === "challenge") {
				channel = await SecureChannel.create({
					secret: key, challenge: frame.nonce, clientNonce: nonce, host: access.hostId, device: invitation.id, role: "client",
				}, frame => { socket.send(JSON.stringify({ type: "frame", peer, frame })); }, () => {}, () => {});
				await channel.send({ type: "hello", api: API_VERSION, label: "Sample" });
			} else channel?.receive(message.frame);
		});
	});
	const connector = new RelayConnector({
		origin, token: newSecret(), access, status: () => {}, request: async () => ({ status: 200, body: {} }),
		watch: handler => { publish = handler; ready(); return () => {}; },
	});
	t.after(async () => {
		connector.close(); channel?.close();
		for (const socket of sockets.clients) socket.terminate();
		sockets.close(); await new Promise(resolve => server.close(resolve));
		rmSync(directory, { recursive: true, force: true });
	});
	connector.start(); await available;
	for (let index = 0; index < 40; index++) publish({
		type: "worker", key: "sample", message: { type: "chat", generation: "g", message: {
			id: String(index), role: "assistant", order: index, revision: index, timestamp: 0,
			blocks: [{ type: "text", text: "x".repeat(1024 * 1024) }],
		} },
	});
	assert.equal(await disconnection, 1013);
	assert.equal(access.remote(invitation.id).key, key);
});

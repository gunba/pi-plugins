import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { DeskHost } from "../src/host/server.ts";
import { AccessStore } from "../src/host/access.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { API_HEADER, API_VERSION, RELEASE } from "../src/shared/release.ts";
import { SecureChannel, newSecret, PROTOCOL_VERSION } from "../src/shared/secure-channel.ts";

test("missing or incompatible local API versions cannot read state, mutate a session or consume an invitation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-api-"));
	const host = new DeskHost({ cwd: directory, agentDir: directory, dataDir: directory, port: 0 });
	try {
		const { origin, pairingUrl } = await host.start();
		const operator = JSON.parse(readFileSync(join(directory, "access.json"))).operator;
		const key = crypto.randomUUID(); let mutations = 0;
		host.sessions.set(key, { view: { key, state: "ready", cwd: directory, created: 0 },
			worker: { command: async () => { mutations++; }, close: async () => {} } });
		const headers = { Authorization: `Bearer ${operator}`, "Content-Type": "application/json" };
		for (const version of [undefined, "999"]) {
			const provided = { ...headers, ...(version ? { [API_HEADER]: version } : {}) };
			const read = await fetch(`${origin}/api/state`, { headers: provided });
			assert.equal(read.status, 426); await read.text();
			const mutate = await fetch(`${origin}/api/sessions/${key}/command`, { method: "POST", headers: provided,
				body: JSON.stringify({ id: crypto.randomUUID(), generation: "sample", command: { kind: "name", name: "Changed" } }) });
			assert.equal(mutate.status, 426); await mutate.text();
		}
		assert.equal(mutations, 0);
		const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("pair");
		const pair = version => fetch(`${origin}/api/pair`, { method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin, [API_HEADER]: version },
			body: JSON.stringify({ token, label: "Sample" }) });
		let response = await pair("999"); assert.equal(response.status, 426); await response.text();
		response = await pair(String(API_VERSION)); assert.equal(response.status, 200); await response.text();
		response = await fetch(`${origin}/api/state`, { headers: { ...headers, [API_HEADER]: String(API_VERSION) } });
		assert.equal(response.status, 200); assert.deepEqual((await response.json()).release, RELEASE);
	} finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const stage of ["identify", "hello"]) test(`incompatible remote ${stage} is an upgrade error, not a consumed pairing`, { timeout: 5000 }, async t => {
	const directory = mkdtempSync(join(tmpdir(), "desk-remote-api-"));
	const server = createServer(), sockets = new WebSocketServer({ server });
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const access = new AccessStore(directory), invitation = access.inviteRemote(), peer = crypto.randomUUID(), nonce = newSecret();
	let channel, signal, reject, announced = false, watches = 0;
	const closed = new Promise((resolve, fail) => { signal = resolve; reject = fail; });
	sockets.on("connection", socket => {
		socket.send(JSON.stringify({ type: "opened", peer }));
		socket.send(JSON.stringify({ type: "frame", peer, frame: JSON.stringify({
			type: "identify", protocol: PROTOCOL_VERSION, api: stage === "identify" ? 999 : API_VERSION,
			nonce, device: invitation.id,
		}) }));
		socket.on("message", raw => {
			void (async () => {
				const message = JSON.parse(raw.toString());
				if (message.type === "close") { signal(message.code); return; }
				if (message.type !== "frame") return;
				const frame = JSON.parse(message.frame);
				if (frame.type === "upgrade-required") { announced = true; return; }
				if (frame.type === "challenge") {
					channel = await SecureChannel.create({ secret: invitation.key, challenge: frame.nonce, clientNonce: nonce,
						host: access.hostId, device: invitation.id, role: "client" },
					frame => socket.send(JSON.stringify({ type: "frame", peer, frame })),
					message => { if (message.type === "upgrade-required") announced = true; }, reject);
					await channel.send({ type: "hello", api: 999, label: "Sample", key: newSecret() });
				} else channel?.receive(message.frame);
			})().catch(reject);
		});
	});
	const connector = new RelayConnector({ origin: `http://127.0.0.1:${server.address().port}`, appOrigin: "https://app.example", token: newSecret(),
		access, status: () => {}, request: async () => { throw Error("No request should be admitted"); },
		watch: () => { watches++; return () => {}; } });
	t.after(async () => {
		connector.close(); channel?.close(); for (const socket of sockets.clients) socket.terminate();
		sockets.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true });
	});
	connector.start();
	assert.equal(await closed, 4003);
	assert.equal(watches, 0);
	assert.ok(access.remote(invitation.id).expires);
	assert.equal(access.remote(invitation.id).key, invitation.key);
	// Plain upgrade notices arrive before close; encrypted decoding may finish later.
	if (stage === "identify") assert.equal(announced, true);
});

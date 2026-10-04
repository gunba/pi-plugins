import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DeskHost } from "../src/host/server.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { RelayServer } from "../src/host/relay-server.ts";
import { API_HEADER, API_VERSION, RELEASE } from "../src/shared/release.ts";
import { ClientHandshake } from "../src/shared/account-channel.ts";
import { accountFixture } from "./account-fixture.mjs";

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
		for (const version of [undefined, String(API_VERSION - 1), "999"]) {
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

for (const stage of ["offer", "hello"]) test(`incompatible authenticated remote ${stage} is an upgrade error`, { timeout: 5000 }, async t => {
	const fixture = await accountFixture(), host = await fixture.device("host"), browser = await fixture.device("browser");
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin: "https://app.example", account: fixture.config, verifier: fixture.verifier });
	let channel, connector, socket, watches = 0;
	t.after(async () => {
		connector?.close(); channel?.close(); socket?.terminate(); await relay.close();
	});
	await relay.start(0);
	fixture.config.relayOrigin = relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	let online;
	const available = new Promise(resolve => { online = resolve; });
	connector = new RelayConnector({
		appOrigin: "https://app.example", account: host,
		status: status => { if (status.state === "online") online(); },
		request: async () => { throw Error("No request should be admitted"); },
		watch: () => { watches++; return () => {}; },
	});
	connector.start();
	await available;
	const handshake = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	if (stage === "offer") {
		const data = JSON.parse(Buffer.from(handshake.offer.proof.split(".")[1], "base64url"));
		data.api = 999;
		handshake.offer.proof = await browser.signProof(new TextEncoder().encode(JSON.stringify(data)), "pi-desk-client-hello+jws");
	}
	socket = new WebSocket(`${relay.origin.replace("http:", "ws:")}/connect?host=${host.device.id}`, { headers: { Origin: "https://app.example" } });
	let announced, failed;
	const notice = new Promise((resolve, reject) => { announced = resolve; failed = reject; });
	socket.on("message", raw => {
		void (async () => {
			if (channel) { channel.receive(raw.toString()); return; }
			const message = JSON.parse(raw.toString());
			if (message.type === "upgrade-required") { announced(); return; }
			const session = await handshake.finish(message, {
				output: frame => socket.send(frame),
				input: message => { if (message.type === "upgrade-required") announced(); }, failed,
			});
			channel = session.channel;
			await channel.send({ type: "hello", api: 999 });
		})().catch(failed);
	});
	await once(socket, "open", { signal: t.signal });
	const closed = once(socket, "close", { signal: t.signal });
	socket.send(JSON.stringify(handshake.offer));
	assert.equal((await closed)[0], 4003);
	await notice;
	assert.equal(watches, 0);
});

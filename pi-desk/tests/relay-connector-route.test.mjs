import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RelayServer } from "../src/host/relay-server.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { accountFixture } from "./account-fixture.mjs";

test("the relay forwards a Dot connector request to the host holding its secret, and only that", { timeout: 10000 }, async t => {
	const fixture = await accountFixture();
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin: "https://app.example", account: fixture.config, verifier: fixture.verifier });
	await relay.start(0);
	const origin = relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	const host = await fixture.device("host"), secret = "s".repeat(43);
	let key = createHash("sha256").update(secret).digest("hex");
	const connector = new RelayConnector({ appOrigin: "https://app.example", status: () => {}, watch: () => () => {},
		request: async () => ({ status: 200, body: {} }),
		account: { ...host, config: { ...fixture.config, relayOrigin: origin }, verifier: () => fixture.verifier, heartbeat: async () => {},
			lease: async peers => ({ allowed: peers.map(peer => peer.id), expires: Math.floor(Date.now() / 1000) + 60 }) },
		connector: { key: () => key, handle: async body => ({ status: 200, body: JSON.stringify({ echoed: JSON.parse(body).method }) }) } });
	t.after(async () => { connector.close(); await relay.close(); });
	connector.start();
	const post = (path, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') => fetch(origin + path, { method: "POST", body, headers: { "Content-Type": "application/json" } });
	for (let i = 0; i < 100 && (await post(`/connector/${secret}`)).status !== 200; i++) await delay(50);
	const response = await post(`/connector/${secret}`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { echoed: "tools/list" });
	assert.equal((await post(`/connector/${"x".repeat(43)}`)).status, 404, "an unknown secret reaches no host");
	assert.equal((await fetch(origin + `/connector/${secret}`)).status, 405);
	assert.equal((await post("/health")).status, 403, "other routes stay read-only");
	key = undefined; connector.connectorChanged(); await delay(100);
	assert.equal((await post(`/connector/${secret}`)).status, 404, "disabling removes the route");
});

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RelayServer } from "../src/host/relay-server.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { accountFixture } from "./account-fixture.mjs";

test("the relay forwards connector requests only to an opted-in host and passes its OAuth headers", { timeout: 10000 }, async t => {
	const fixture = await accountFixture();
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin: "https://app.example", account: fixture.config, verifier: fixture.verifier });
	await relay.start(0);
	const origin = relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	const host = await fixture.device("host"), seen = [];
	let enabled = true;
	const connector = new RelayConnector({ appOrigin: "https://app.example", status: () => {}, watch: () => () => {},
		request: async () => ({ status: 200, body: {} }),
		account: { ...host, config: { ...fixture.config, relayOrigin: origin }, verifier: () => fixture.verifier, heartbeat: async () => {},
			lease: async peers => ({ allowed: peers.map(peer => peer.id), expires: Math.floor(Date.now() / 1000) + 60 }) },
		connector: { enabled: () => enabled, handle: async request => { seen.push(request);
			return request.path === "" && !request.headers.authorization
				? { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"', "set-cookie": "a=b" }, body: "{}" }
				: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ path: request.path }) }; } } });
	t.after(async () => { connector.close(); await relay.close(); });
	connector.start();
	const base = `${origin}/connector/${host.device.id}`;
	for (let i = 0; i < 100 && (await fetch(base, { method: "POST", body: "{}" })).status !== 401; i++) await delay(50);

	const unauthorized = await fetch(base, { method: "POST", body: '{"id":1}', headers: { "Content-Type": "application/json" } });
	assert.equal(unauthorized.status, 401);
	assert.equal(unauthorized.headers.get("www-authenticate"), 'Bearer resource_metadata="x"');
	assert.equal(unauthorized.headers.get("set-cookie"), null, "only allowlisted headers pass through");
	const authorized = await fetch(base, { method: "POST", body: "{}", headers: { Authorization: "Bearer token-value-abcdefghijkl" } });
	assert.equal(authorized.status, 200);
	assert.equal(seen.at(-1).headers.authorization, "Bearer token-value-abcdefghijkl");
	assert.deepEqual(await (await fetch(`${base}/authorize?client_id=c&state=s`)).json(), { path: "/authorize" });
	assert.equal(seen.at(-1).query, "?client_id=c&state=s");
	assert.deepEqual(await (await fetch(`${origin}/.well-known/oauth-authorization-server/connector/${host.device.id}`)).json(),
		{ path: "/.well-known/oauth-authorization-server" }, "RFC 8414 path-inserted discovery reaches the host");
	assert.equal((await fetch(`${origin}/connector/${crypto.randomUUID()}`, { method: "POST", body: "{}" })).status, 404, "unknown computers are not routed");
	assert.equal((await fetch(base, { method: "DELETE" })).status, 405);
	assert.equal((await fetch(`${origin}/health`, { method: "POST" })).status, 403, "other routes stay read-only");
	enabled = false; connector.connectorChanged(); await delay(100);
	assert.equal((await fetch(base, { method: "POST", body: "{}" })).status, 404, "turning access off removes the route");
});

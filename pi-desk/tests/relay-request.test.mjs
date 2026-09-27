import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { RelayServer } from "../src/host/relay-server.ts";
import { newSecret } from "../src/shared/secure-channel.ts";
import { hostAdmission } from "../src/shared/account-channel.ts";
import { accountFixture } from "./account-fixture.mjs";

test("malformed HTTP and upgrade targets cannot crash the relay", { timeout: 5000 }, async t => {
	const fixture = await accountFixture();
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin: "https://app.example",
		account: fixture.config, verifier: fixture.verifier });
	await relay.start(0);
	t.after(() => relay.close());
	const port = relay.server.address().port;
	const get = (path, upgrade = false) => new Promise((resolve, reject) => {
		const req = request({
			hostname: "127.0.0.1", port, path, signal: t.signal,
			headers: { Host: "127.0.0.1:1", ...(upgrade ? {
				Connection: "Upgrade", Upgrade: "websocket",
				"Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			} : {}) },
		}, response => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		req.on("error", reject);
		req.end();
	});
	for (const upgrade of [false, true]) {
		assert.equal(await get("//[", upgrade), 400);
		assert.equal(await get("//elsewhere.invalid/health", upgrade), 400);
		assert.equal(await get("/health"), 200);
	}
});

test("the broker cannot supply the app and accepts only its separately configured app origin", { timeout: 5000 }, async t => {
	const appOrigin = "https://app.example", fixture = await accountFixture();
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin,
		account: fixture.config, verifier: fixture.verifier });
	await relay.start(0);
	t.after(() => relay.close());
	relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	for (const path of ["/", "/index.html", "/sw.js", "/assets/app.js", "/api/transport", "/desk-account.json"]) {
		const response = await fetch(relay.origin + path, { signal: t.signal });
		assert.equal(response.status, 404);
		await response.arrayBuffer();
	}
	const host = await fixture.device("host");
	const connect = (path, headers, message) => new Promise((resolve, reject) => {
		const socket = new WebSocket(`${relay.origin.replace("http:", "ws:")}${path}?host=${host.device.id}`, { headers, handshakeTimeout: 2000 });
		if (message) socket.on("message", raw => { void message(socket, JSON.parse(raw.toString())).catch(reject); });
		socket.on("error", reject);
		socket.once("open", () => resolve({ status: 101, socket }));
		socket.once("unexpected-response", (_, response) => {
			response.resume(); socket.terminate(); resolve({ status: response.statusCode });
		});
	});
	assert.equal((await connect("/host", { Authorization: `Bearer ${newSecret()}` })).status, 403);
	assert.equal((await connect("/host", { Origin: appOrigin })).status, 403);
	let admitted;
	const admission = new Promise(resolve => { admitted = resolve; });
	const registered = await connect("/host", {}, async (socket, message) => {
		if (message.type === "admission") socket.send(JSON.stringify(await hostAdmission(host, relay.origin, message.nonce)));
		else if (message.type === "admitted") admitted();
	});
	assert.equal(registered.status, 101);
	await admission;
	for (const Origin of [relay.origin, "https://elsewhere.example", "null"]) {
		assert.equal((await connect("/connect", { Origin })).status, 403);
	}
	const opened = once(registered.socket, "message", { signal: t.signal });
	assert.equal((await connect("/connect", { Origin: appOrigin })).status, 101);
	assert.equal(JSON.parse((await opened)[0].toString()).type, "opened");
});

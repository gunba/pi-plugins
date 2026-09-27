import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { RelayServer } from "../src/host/relay-server.ts";
import { newSecret } from "../src/shared/secure-channel.ts";

test("malformed HTTP and upgrade targets cannot crash the relay", { timeout: 5000 }, async t => {
	const relay = new RelayServer({ origin: "http://127.0.0.1:1", appOrigin: "https://app.example", token: newSecret() });
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
	const appOrigin = "https://app.example", token = newSecret();
	const relay = new RelayServer({ origin: "http://127.0.0.1:1", appOrigin, token });
	await relay.start(0);
	t.after(() => relay.close());
	relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	for (const path of ["/", "/index.html", "/sw.js", "/assets/app.js", "/api/transport", "/desk-transport.json"]) {
		const response = await fetch(relay.origin + path, { signal: t.signal });
		assert.equal(response.status, 404);
		await response.arrayBuffer();
	}
	const host = crypto.randomUUID();
	const connect = (path, headers) => new Promise((resolve, reject) => {
		const socket = new WebSocket(`${relay.origin.replace("http:", "ws:")}${path}?host=${host}`, { headers, handshakeTimeout: 2000 });
		socket.on("error", reject);
		socket.once("open", () => resolve({ status: 101, socket }));
		socket.once("unexpected-response", (_, response) => {
			response.resume(); socket.terminate(); resolve({ status: response.statusCode });
		});
	});
	const credentials = { Authorization: `Bearer ${token}`, "X-Pi-Desk-App-Origin": appOrigin };
	assert.equal((await connect("/host", { ...credentials, "X-Pi-Desk-App-Origin": relay.origin })).status, 403);
	const registered = await connect("/host", credentials);
	assert.equal(registered.status, 101);
	for (const Origin of [relay.origin, "https://elsewhere.example", "null"]) {
		assert.equal((await connect("/connect", { Origin })).status, 403);
	}
	const opened = once(registered.socket, "message", { signal: t.signal });
	assert.equal((await connect("/connect", { Origin: appOrigin })).status, 101);
	assert.equal(JSON.parse((await opened)[0].toString()).type, "opened");
});

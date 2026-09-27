import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { RelayServer } from "../src/host/relay-server.ts";
import { newSecret } from "../src/shared/secure-channel.ts";

test("malformed HTTP and upgrade targets cannot crash the relay", { timeout: 5000 }, async t => {
	const relay = new RelayServer({ origin: "http://127.0.0.1:1", token: newSecret() });
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

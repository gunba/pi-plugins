import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { RemoteClient } from "../src/client/remote.ts";
import { connectionLabel } from "../src/client/connection-state.ts";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { RelayServer } from "../src/host/relay-server.ts";
import { accountFixture } from "./account-fixture.mjs";

const deferred = () => {
	let resolve;
	return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};
function state(client, expected) {
	if (client.state === expected) return Promise.resolve();
	return new Promise(resolve => {
		let stop;
		stop = client.subscribe(() => {}, () => {
			if (client.state === expected) { queueMicrotask(() => stop()); resolve(); }
		});
	});
}

test("tab suspension is not a PC outage; visible interruptions reconnect without replaying accepted input", { timeout: 15_000 }, async t => {
	const fixture = await accountFixture(), host = await fixture.device("host"), browser = await fixture.device("browser");
	const relay = new RelayServer({ origin: fixture.config.relayOrigin, appOrigin: "https://app.example",
		account: fixture.config, verifier: fixture.verifier });
	const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false }), navigator = { onLine: true };
	const globals = {
		document, navigator, addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
		WebSocket: class extends WebSocket { constructor(url) { super(url, { headers: { Origin: "https://app.example" } }); } },
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	let client, connector;
	const admitted = deferred(), release = deferred(), available = deferred();
	let commands = 0;
	t.after(async () => {
		release.resolve(); client?.close(); connector?.close(); await relay.close();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
		}
	});
	await relay.start(0);
	fixture.config.relayOrigin = relay.origin = `http://127.0.0.1:${relay.server.address().port}`;
	connector = new RelayConnector({
		appOrigin: "https://app.example", account: host,
		status: value => { if (value.state === "online") available.resolve(); },
		request: async () => { commands++; admitted.resolve(); await release.promise; return { status: 200, body: { accepted: true } }; },
		watch: () => () => {},
	});
	connector.start(); await available.promise;
	client = new RemoteClient(browser, host.device);
	assert.equal(client.state, "connecting");
	await state(client, "connected");
	assert.equal(client.connected, true);
	const presence = { online: true, seen: Date.now(), checked: Date.now() };
	const pending = client.request({ method: "POST", path: "/api/example", body: { text: "Once" } }).catch(error => error);
	await admitted.promise;
	document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
	assert.equal(client.state, "paused");
	assert.equal(connectionLabel({ connection: client.state, presence }), "App paused");
	assert.equal(client.connected, false);
	assert.equal(connector.status.state, "online", "the native host stays connected while this browser is paused");
	assert.match((await pending).message, /uncertain/);
	assert.equal(client.diagnostics.interruptions, 0, "intentional tab suspension is not an unexplained interruption");
	release.resolve();
	document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
	assert.equal(client.state, "reconnecting");
	await state(client, "connected");
	assert.equal(commands, 1, "reconnecting never replays an earlier request");

	client.backoff = 0;
	const interrupted = state(client, "reconnecting");
	client.socket.terminate();
	await interrupted;
	assert.equal(connectionLabel({ connection: client.state, presence }), "Reconnecting");
	assert.equal(client.diagnostics.interruptions, 1);
	assert.equal(client.diagnostics.last.code, 1006);
	await state(client, "connected");
	assert.equal(commands, 1);

	navigator.onLine = false; window.dispatchEvent(new Event("offline"));
	assert.equal(client.state, "network-offline");
	assert.equal(client.connected, false);
	navigator.onLine = true; window.dispatchEvent(new Event("online"));
	await state(client, "connected");
	client.leaseUntil = performance.now() - 1;
	assert.equal(client.connected, false, "reported PC presence cannot override an expired membership lease");
	await assert.rejects(client.request({ method: "POST", path: "/api/example" }), /authorization expired/);
	assert.equal(commands, 1);

	browser.lease = async () => ({ allowed: [], expires: Math.floor(Date.now() / 1000) + 60 });
	client.reconnect();
	await state(client, "denied");
	assert.equal(client.connected, false);
	await assert.rejects(client.request({ method: "POST", path: "/api/example" }), /no longer in your account/);
});

test("a stale directory cannot turn a reconnect into a claim that the PC is offline", () => {
	const now = Date.now(), presence = { online: false, checked: now, seen: now - 120_000 };
	assert.equal(connectionLabel({ connection: "connecting", presence }, now), "Connecting");
	assert.equal(connectionLabel({ connection: "reconnecting", presence }, now), "Waiting for computer");
	assert.equal(connectionLabel({ connection: "reconnecting", presence: { ...presence, checked: now - 90_001 } }, now), "Reconnecting");
	assert.equal(connectionLabel({ connection: "connected", presence }, now), "Connected");
});

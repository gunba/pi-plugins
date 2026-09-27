import assert from "node:assert/strict";
import test from "node:test";
import { ClientHandshake, acceptChannelOffer } from "../src/shared/account-channel.ts";
import { accountFixture } from "./account-fixture.mjs";

test("a relay cannot replay an old host challenge and acknowledgement to a fresh browser", async () => {
	const fixture = await accountFixture(), host = await fixture.device("host"), browser = await fixture.device("browser");
	const original = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	let captured;
	const server = await acceptChannelOffer(original.offer, host.device.id, host, fixture.verifier, async () => {}, {
		output: wire => { captured = wire; }, input: () => {}, failed: error => { throw error; },
	});
	let delivered, rejected;
	const delivery = new Promise(resolve => { delivered = resolve; });
	const rejection = new Promise(resolve => { rejected = resolve; });
	const oldBrowser = await original.finish(server.accept, { output: () => {}, input: delivered, failed: error => { throw error; } });
	await server.channel.send({ type: "ready" });
	oldBrowser.channel.receive(captured);
	assert.deepEqual(await delivery, { type: "ready" });
	const replayTarget = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	await assert.rejects(replayTarget.finish(server.accept, { output: () => {}, input: () => {}, failed: () => {} }),
		/does not authorize this handshake/);
	const fresh = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	const freshServer = await acceptChannelOffer(fresh.offer, host.device.id, host, fixture.verifier, async () => {},
		{ output: () => {}, input: () => {}, failed: () => {} });
	const freshBrowser = await fresh.finish(freshServer.accept,
		{ output: () => {}, input: () => rejected(new Error("Replay accepted")), failed: rejected });
	freshBrowser.channel.receive(captured);
	assert.notEqual((await rejection).message, "Replay accepted");
	for (const connection of [server, oldBrowser, freshServer, freshBrowser]) connection.channel.close();
});

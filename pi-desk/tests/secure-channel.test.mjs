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

// Delivery is asynchronous (decryption, decompression): wait for it rather than for a fixed time.
const arrival = async delivered => { for (let turn = 0; turn < 2000 && !delivered.length; turn++) await new Promise(resolve => setTimeout(resolve, 5)); };
const pair = async (fixture, host, browser, wires) => {
	const handshake = await ClientHandshake.create(host.device.id, browser, fixture.verifier);
	let received; const delivered = [];
	const server = await acceptChannelOffer(handshake.offer, host.device.id, host, fixture.verifier, async () => {}, {
		output: wire => { wires.push(wire); }, input: () => {}, failed: error => { received = error; },
	});
	const client = await handshake.finish(server.accept, { output: () => {}, input: message => delivered.push(message), failed: error => { received = error; } });
	return { server, client, delivered, failure: () => received };
};
// The shape of host state: one conversation's entry repeated with small differences.
const state = () => ({ sessions: Array.from({ length: 30 }, (_, index) => ({ key: `session-${index}`, cwd: `/home/jordan/project-${index}`,
	snapshot: { tools: Array.from({ length: 90 }, (_, tool) => ({ name: `tool_${tool}`, description: `Does task ${tool} for the agent, reading its arguments and returning text.` })) } })) });

test("a computer's state crosses the relay compressed, at a fraction of its size; a computer on an older Desk still gets the old format", async () => {
	// On plane Wi-Fi a page took 43 s or more to show a conversation: 0.7 to 1.3 MB of relay data, base64-encoded twice and never compressed.
	const fixture = await accountFixture(), host = await fixture.device("host"), browser = await fixture.device("browser");
	const message = state(), size = JSON.stringify(message).length;
	const wires = [], fresh = await pair(fixture, host, browser, wires);
	await fresh.server.channel.send(message);
	for (const wire of wires) fresh.client.channel.receive(wire);
	await arrival(fresh.delivered);
	assert.deepEqual(fresh.delivered[0], message);
	const sent = wires.reduce((sum, wire) => sum + wire.length, 0);
	assert.ok(sent < size * 0.35, `sent ${sent} bytes for ${size} bytes of state`);
	// An end that offers no features (an older Desk) gets the old format, which it can read.
	const { CHANNEL_FEATURES } = await import("../src/shared/secure-channel.ts");
	const features = [...CHANNEL_FEATURES]; CHANNEL_FEATURES.length = 0;
	const oldWires = [];
	let old;
	try { old = await pair(fixture, host, browser, oldWires); } finally { CHANNEL_FEATURES.push(...features); }
	await old.server.channel.send(message);
	for (const wire of oldWires) old.client.channel.receive(wire);
	await arrival(old.delivered);
	assert.deepEqual(old.delivered[0], message);
	assert.ok(oldWires.reduce((sum, wire) => sum + wire.length, 0) > size, "the old format is unchanged");
	for (const connection of [fresh.server, fresh.client, old.server, old.client]) connection.channel.close();
});

test("a long message that keeps arriving on a slow link is delivered; one that stops for a minute fails", async t => {
	// It had to arrive whole within 30 s of its first chunk, which a slow link cannot do.
	const fixture = await accountFixture(), host = await fixture.device("host"), browser = await fixture.device("browser");
	const wires = [], link = await pair(fixture, host, browser, wires);
	const noise = Array.from({ length: 200_000 }, () => Math.random().toString(36)[2]).join("");
	await link.server.channel.send({ noise });
	assert.ok(wires.length >= 3, "several chunks");
	t.mock.timers.enable({ apis: ["setTimeout"] });
	// Each chunk is taken in (decryption is asynchronous) before the clock moves on 45 s: 90 s or more in all.
	const taken = index => link.delivered.length || (link.client.channel.assembly?.next ?? 0) > index;
	for (const [index, wire] of wires.entries()) {
		link.client.channel.receive(wire);
		for (let turn = 0; turn < 1000 && !taken(index); turn++) await new Promise(resolve => setImmediate(resolve));
		t.mock.timers.tick(45_000);
	}
	for (let index = 0; index < 20 && !link.delivered.length; index++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(link.failure(), undefined);
	assert.equal(link.delivered[0]?.noise, noise);
	// A message that stops arriving for over a minute is abandoned.
	wires.length = 0;
	await link.server.channel.send({ noise });
	link.client.channel.receive(wires[0]);
	for (let turn = 0; turn < 1000 && !link.client.channel.assembly; turn++) await new Promise(resolve => setImmediate(resolve));
	t.mock.timers.tick(61_000);
	assert.match(link.failure()?.message ?? "", /Incomplete encrypted message/);
	t.mock.timers.reset();
	link.server.channel.close(); link.client.channel.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { SecureChannel, newSecret } from "../src/shared/secure-channel.ts";

test("a relay cannot replay an old host challenge and acknowledgement to a fresh browser", async () => {
	const original = { secret: newSecret(), challenge: newSecret(), clientNonce: newSecret(),
		host: crypto.randomUUID(), device: crypto.randomUUID() };
	let captured;
	const host = await SecureChannel.create({ ...original, role: "host" },
		wire => { captured = wire; }, () => {}, error => { throw error; });
	await host.send({ type: "ready" });
	let delivered, rejected;
	const delivery = new Promise(resolve => { delivered = resolve; });
	const rejection = new Promise(resolve => { rejected = resolve; });
	const oldBrowser = await SecureChannel.create({ ...original, role: "client" }, () => {}, delivered, error => { throw error; });
	oldBrowser.receive(captured);
	assert.deepEqual(await delivery, { type: "ready" });
	const freshBrowser = await SecureChannel.create({ ...original, clientNonce: newSecret(), role: "client" },
		() => {}, () => rejected(new Error("Replay accepted")), rejected);
	freshBrowser.receive(captured);
	assert.notEqual((await rejection).message, "Replay accepted");
	host.close(); oldBrowser.close(); freshBrowser.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { deviceKey } from "../src/shared/account.ts";
import { accountClockLead, accountNow, measureAccountClock } from "../src/shared/account-clock.ts";
import { AccountProofs, sendWithProof } from "../src/shared/account-proof.ts";
import { membershipDeadline } from "../src/shared/membership.ts";
import { accountFixture } from "./account-fixture.mjs";

const trueNow = Date.now.bind(Date);

/**
 * A device whose clock is `lead` ms ahead of the account service's. Both run in this process, so the returned
 * `service` runs its argument by the true clock. The service's Date header is `new Date()`, which does not read Date.now.
 */
function deviceClock(t, lead) {
	let current = lead;
	t.mock.method(Date, "now", () => trueNow() + current);
	t.after(() => { t.mock.restoreAll(); measureAccountClock(new Date().toUTCString()); });
	return async run => { current = 0; try { return await run(); } finally { current = lead; } };
}

/** The account service's check of a signed request, answering as the service does. */
async function signedRequest() {
	const pair = await generateKeyPair("ES256", { extractable: true }), key = (await deviceKey(await exportJWK(pair.publicKey))).key;
	const request = { id: crypto.randomUUID(), method: "POST", url: "https://account.example/enrolments", body: "{}", accessToken: "" };
	const proofs = new AccountProofs(), statuses = [];
	const answer = async proof => {
		const date = new Date().toUTCString();
		try { await proofs.verify(proof, request, key); statuses.push(202); return { status: 202, date }; }
		catch { statuses.push(403); return { status: 403, error: "invalid_device_proof", date }; }
	};
	return { request, key: pair.privateKey, answer, statuses };
}

for (const [lead, direction] of [[136_000, "ahead of"], [-136_000, "behind"]]) {
	test(`a device whose clock is 136 s ${direction} the account service's is refused once, then signs by the service's clock`, async t => {
		const service = deviceClock(t, lead), { request, key, answer, statuses } = await signedRequest();
		const reply = await sendWithProof(request, key, proof => service(() => answer(proof)));
		assert.deepEqual(statuses, [403, 202]);
		assert.equal(reply.status, 202);
		assert.ok(Math.abs(accountClockLead() - lead) <= 1000, `measured a lead of ${accountClockLead()} ms`);
		assert.ok(Math.abs(accountNow() - trueNow()) <= 1000);
		// The measurement holds: the next request is accepted as first sent.
		const next = await signedRequest();
		await sendWithProof(next.request, next.key, proof => service(() => next.answer(proof)));
		assert.deepEqual(next.statuses, [202]);
	});
}

test("a device with the right clock sends once and keeps its own time", async t => {
	const service = deviceClock(t, 0), { request, key, answer, statuses } = await signedRequest();
	await sendWithProof(request, key, proof => service(() => answer(proof)));
	assert.deepEqual(statuses, [202]);
	assert.equal(accountClockLead(), 0);
});

test("a refusal that the clock does not explain is returned, not repeated", async t => {
	const service = deviceClock(t, 0), { request, answer, statuses } = await signedRequest();
	const other = await generateKeyPair("ES256", { extractable: true });
	const reply = await sendWithProof(request, other.privateKey, proof => service(() => answer(proof)));
	assert.deepEqual(statuses, [403]);
	assert.equal(reply.error, "invalid_device_proof");
});

test("a device 136 s ahead still has the whole of a 60 s lease", async t => {
	const service = deviceClock(t, 136_000);
	assert.equal(measureAccountClock(await service(() => new Date().toUTCString())), true);
	const lease = { allowed: [], expires: Math.floor(trueNow() / 1000) + 60 };
	const left = membershipDeadline(lease, performance.now()) - performance.now();
	assert.ok(left > 57_000 && left <= 60_000, `${left} ms left`);
});

test("a device 136 s behind accepts a credential the account service has just issued", async t => {
	const fixture = await accountFixture(), host = await fixture.device("host"), credential = await host.certificate();
	deviceClock(t, -136_000);
	assert.equal(measureAccountClock(new Date().toUTCString()), true);
	assert.equal((await fixture.verifier.verify(credential, "host")).id, host.device.id);
});

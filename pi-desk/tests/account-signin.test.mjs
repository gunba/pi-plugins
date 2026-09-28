import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NativeAccountIdentity } from "../src/host/account-identity.ts";
import { BrowserAccount } from "../src/client/account.ts";
import { ServerError } from "@azure/msal-node";
import { RelayConnector } from "../src/host/relay-connector.ts";
import { AccountSignInRequired } from "../src/host/account-errors.ts";

const config = {
	origin: "https://account.example", relayOrigin: "https://relay.example", appOrigins: ["https://desk.example"],
	tenantId: randomUUID(), ownerObjectId: randomUUID(), clientId: randomUUID(),
};
const owner = { tenantId: config.tenantId, localAccountId: config.ownerObjectId };
const other = { tenantId: config.tenantId, localAccountId: randomUUID() };
const result = account => ({ account, accessToken: "fixture-token" });
function native(application) {
	return Object.assign(Object.create(NativeAccountIdentity.prototype), { config, application });
}

test("native sign-in reuses its cache without opening another login", async () => {
	const identity = native({
		getTokenCache: () => ({ getAllAccounts: async () => [owner] }),
		acquireTokenSilent: async () => result(owner),
		acquireTokenInteractive: async () => { assert.fail("Unexpected interactive login"); },
	});
	await identity.signIn(async () => assert.fail("Unexpected browser open"));
});
test("native sign-in allows Microsoft SSO and only selects an account after an owner mismatch", async () => {
	for (const first of [owner, other]) {
		const requests = [];
		const identity = native({
			getTokenCache: () => ({ getAllAccounts: async () => [] }),
			acquireTokenInteractive: async request => {
				requests.push(request); return result(requests.length === 1 ? first : owner);
			},
		});
		await identity.signIn(async () => {});
		assert.equal(Object.hasOwn(requests[0], "prompt"), false);
		assert.equal(requests.length, first === owner ? 1 : 2);
		if (first === other) assert.equal(requests[1].prompt, "select_account");
	}
});
test("native cache network failure does not provoke another login", async () => {
	const identity = native({
		getTokenCache: () => ({ getAllAccounts: async () => [owner] }),
		acquireTokenSilent: async () => { throw new Error("offline"); },
		acquireTokenInteractive: async () => assert.fail("Unexpected interactive login"),
	});
	await assert.rejects(identity.signIn(async () => {}), /temporarily unavailable/);
});
for (const code of ["530035", 530035]) test(`explicit native sign-in can recover a refresh blocked by security defaults (${typeof code})`, async () => {
	let interactive = 0;
	const identity = native({
		getTokenCache: () => ({ getAllAccounts: async () => [owner] }),
		acquireTokenSilent: async () => {
			throw new ServerError("invalid_request", "fixture-correlation", "Blocked by security defaults", "", code);
		},
		acquireTokenInteractive: async () => { interactive++; return result(owner); },
	});
	identity.device = { id: randomUUID() };
	await assert.rejects(identity.certificate(), /security defaults.*530035/);
	assert.equal(interactive, 0, "background refresh must not open a login");
	await identity.signIn(async () => {});
	assert.equal(interactive, 1);
});
test("connector reports required sign-in without exposing arbitrary account errors", async () => {
	for (const error of [new AccountSignInRequired("Microsoft security defaults blocked authorization (AADSTS530035)."), new Error("private diagnostic")]) {
		let observed;
		const offline = new Promise(resolve => { observed = resolve; });
		const connector = new RelayConnector({
			appOrigin: config.appOrigins[0],
			account: { config, certificate: async () => { throw error; }, verifier: () => ({}) },
			status: status => { if (status.state === "offline") observed(status); },
			request: async () => { assert.fail("Unexpected host request"); },
			watch: () => { assert.fail("Unexpected subscription"); },
		});
		try {
			connector.start();
			const status = await offline;
			assert.equal(status.error, error instanceof AccountSignInRequired ? error.message
				: "Account access is unavailable. Check sign-in, the account service, proxy and network policy.");
		} finally { connector.close(); }
	}
});
test("browser login leaves SSO available and selects an account only for a cached mismatch", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { removeItem() {} } });
	try {
		for (const active of [null, owner, other]) {
			let request;
			const identity = Object.assign(Object.create(BrowserAccount.prototype), {
				config, logoutKey: "fixture:logout", application: {
					getActiveAccount: () => active, getAllAccounts: () => active ? [active] : [],
					loginRedirect: async value => { request = value; },
				},
			});
			await identity.signIn();
			assert.equal(request.prompt, active === other ? "select_account" : undefined);
		}
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete globalThis.localStorage;
	}
});

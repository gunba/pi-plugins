import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { Logins } from "../src/host/logins.ts";

const settled = async logins => {
	for (let i = 0; i < 20; i++) {
		await setImmediate();
		if (!(await logins.snapshot()).signIns.some(operation => operation.state === "starting")) return;
	}
	throw Error("Sign-in fixture did not settle");
};
const signIn = async (logins, id) => (await logins.snapshot()).signIns.find(operation => operation.id === id);
const fixture = (t, descriptor, login) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-logins-"));
	writeFileSync(join(directory, "auth.json"), "{}\n");
	const logins = new Logins(directory, async options => ({ getProviders: () => [descriptor], getProvider: () => descriptor,
		login: (...args) => login(options, ...args), logout: async () => {} }));
	t.after(async () => { await logins.close(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, logins };
};

test("Codex sign-in chooses the device flow and saves Pi's login, never exposing tokens", async t => {
	const approvals = [], descriptor = { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } };
	const { directory, logins } = fixture(t, descriptor, async (options, provider, type, interaction) => {
		assert.equal(options.authPath, join(directory, "auth.json"), "Desk signs Pi in, in Pi's own auth.json");
		assert.equal(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] }), "device_code");
		interaction.notify({ type: "device_code", userCode: "FIXTURE-CODE", verificationUri: "https://provider.example.test/verify", expiresInSeconds: 600 });
		await new Promise((resolve, reject) => { approvals.push(resolve); interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true }); });
		writeFileSync(options.authPath, JSON.stringify({ [provider]: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 } }));
	});
	const id = randomUUID(); logins.start(id, "openai-codex"); logins.start(id, "openai-codex");
	await settled(logins);
	const waiting = await signIn(logins, id);
	assert.equal(waiting.state, "waiting"); assert.equal(waiting.device.code, "FIXTURE-CODE"); assert.equal(waiting.prompt, undefined);
	approvals.shift()(); await setImmediate(); await setImmediate();
	assert.equal((await signIn(logins, id)).state, "completed");
	const snapshot = await logins.snapshot();
	assert.equal(snapshot.providers[0].signedIn.type, "oauth");
	assert.ok(!JSON.stringify(snapshot).includes("fixture-access")); assert.ok(!JSON.stringify(snapshot).includes("fixture-refresh"));
});

test("a Codex sign-in that offers only a localhost browser callback fails instead of waiting", async t => {
	const descriptor = { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } };
	const { logins } = fixture(t, descriptor, async (_options, _provider, _type, interaction) => {
		await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }] });
	});
	const id = randomUUID(); logins.start(id, "openai-codex"); await settled(logins);
	const operation = await signIn(logins, id);
	assert.equal(operation.state, "failed"); assert.match(operation.error, /device-code/);
});

test("an API key is asked for in Settings and never shown back, even in a provider's error", async t => {
	const descriptor = { id: "anthropic", name: "Anthropic", auth: { apiKey: { login() {} } } };
	let fail = false;
	const { logins } = fixture(t, descriptor, async (options, id, type, interaction) => {
		assert.equal(type, "api_key");
		const key = await interaction.prompt({ type: "secret", message: "API key" });
		if (fail) throw Error(`Rejected key: ${key}`);
		writeFileSync(options.authPath, JSON.stringify({ [id]: { type: "api_key", key } }));
	});
	assert.deepEqual((await logins.snapshot()).providers, [{ id: "anthropic", name: "Anthropic", types: ["api_key"] }]);
	for (const failed of [true, false]) {
		fail = failed; const id = randomUUID(); logins.start(id, "anthropic", "api_key"); await settled(logins);
		let operation = await signIn(logins, id); assert.equal(operation.prompt.kind, "secret");
		logins.answer(id, operation.prompt.id, "fixture-secret-key"); await setImmediate(); await setImmediate();
		operation = await signIn(logins, id); assert.equal(operation.state, failed ? "failed" : "completed");
		assert.ok(!JSON.stringify(await logins.snapshot()).includes("fixture-secret-key"));
		if (failed) assert.equal(operation.error, "Rejected key: [redacted]");
	}
});

test("Anthropic sign-in uses the headless copy-code flow without a localhost callback", async t => {
	const descriptor = { id: "anthropic", name: "Anthropic", auth: { oauth: { isSubscription: true } } };
	const { logins } = fixture(t, descriptor, async (options, provider, _type, interaction) => {
		assert.equal(await interaction.prompt({ type: "select", message: "Select Anthropic login method:", options: [
			{ id: "browser", label: "Browser login (default)" }, { id: "copy_code", label: "Copy code login (headless)" },
		] }), "copy_code");
		interaction.notify({ type: "auth_url", url: "https://provider.example.test/authorize?state=fixture", instructions: "Copy the returned code." });
		assert.equal(await interaction.prompt({ type: "manual_code", message: "Paste the returned code", placeholder: "code#state" }), "fixture-code#fixture");
		writeFileSync(options.authPath, JSON.stringify({ [provider]: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 } }));
	});
	assert.deepEqual((await logins.snapshot()).providers, [{ id: "anthropic", name: "Anthropic", types: ["oauth"], subscription: true }]);
	const id = randomUUID(); logins.start(id, "anthropic"); await settled(logins);
	const operation = await signIn(logins, id);
	assert.equal(operation.prompt.kind, "manual_code");
	assert.equal(operation.links[0].url, "https://provider.example.test/authorize?state=fixture");
	logins.answer(id, operation.prompt.id, "fixture-code#fixture"); await setImmediate(); await setImmediate();
	assert.equal((await signIn(logins, id)).state, "completed");
	assert.ok(!JSON.stringify(await logins.snapshot()).includes("fixture-access"));
});

test("listing providers neither creates credentials nor goes online", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-logins-catalog-")), oldFetch = globalThis.fetch;
	globalThis.fetch = () => { throw Error("Catalog must stay offline"); };
	try {
		const logins = new Logins(directory), snapshot = await logins.snapshot();
		assert.ok(snapshot.providers.find(provider => provider.id === "openai-codex").types.includes("oauth"));
		assert.ok(snapshot.providers.find(provider => provider.id === "anthropic").types.includes("api_key"));
		assert.equal(existsSync(join(directory, "auth.json")), false);
		await logins.close();
	} finally { globalThis.fetch = oldFetch; rmSync(directory, { recursive: true, force: true }); }
});

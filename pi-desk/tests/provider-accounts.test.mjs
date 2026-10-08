import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { ProviderAccounts } from "../src/host/provider-accounts.ts";

const settled = async accounts => {
	for (let i = 0; i < 20; i++) {
		await setImmediate();
		if (!accounts.view().signIns.some(operation => ["starting", "saving"].includes(operation.state))) return;
	}
	throw Error("Sign-in fixture did not settle");
};

test("host-owned Codex sign-in selects device flow and keeps separate account stores", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	let calls = 0;
	const paths = [], approvals = [];
	const factory = async options => ({
		getProvider: () => ({ auth: { oauth: {} } }),
		login: async (provider, type, interaction) => {
			calls++; paths.push(options.authPath);
			assert.equal(provider, "openai-codex"); assert.equal(type, "oauth");
			assert.equal(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] }), "device_code");
			interaction.notify({ type: "device_code", userCode: "FIXTURE-CODE", verificationUri: "https://provider.example.test/verify", expiresInSeconds: 600 });
			await new Promise((resolve, reject) => {
				approvals.push(resolve);
				interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
			});
			writeFileSync(options.authPath, JSON.stringify({ [provider]: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 } }), { mode: 0o600 });
		},
	});
	const accounts = new ProviderAccounts(directory, directory, factory);
	try {
		for (const name of ["Home", "Work"]) {
			const id = randomUUID(); accounts.start(id, "openai-codex", name); accounts.start(id, "openai-codex", name);
			await settled(accounts);
			const operation = accounts.view().signIns.find(operation => operation.id === id);
			assert.equal(operation.state, "waiting"); assert.equal(operation.device.code, "FIXTURE-CODE"); assert.equal(operation.prompt, undefined);
			const receipt = readFileSync(join(directory, "provider-accounts", id, "sign-in.json"), "utf8");
			assert.ok(!receipt.includes("FIXTURE-CODE")); assert.ok(!receipt.includes("verify"));
			approvals.shift()(); await setImmediate(); await setImmediate();
			assert.equal(accounts.view().signIns.find(operation => operation.id === id).state, "completed");
		}
		assert.equal(calls, 2); assert.notEqual(paths[0], paths[1]);
		assert.deepEqual(accounts.view().accounts.map(account => account.name).sort(), ["Home", "Work"]);
		assert.ok(!JSON.stringify(accounts.view()).includes("fixture-access"));
		assert.ok(!JSON.stringify(accounts.view()).includes("fixture-refresh"));
		assert.equal(new ProviderAccounts(directory, directory, factory).view().accounts.length, 2);
	} finally { await accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("computer defaults bind new conversations once without changing existing accounts", async () => {
	const { mkdirSync } = await import("node:fs");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { initializeAccountSelection, accountSelection } = await import("../src/host/account-binding.ts");
	const directory = mkdtempSync(join(tmpdir(), "pi-account-default-")), id = randomUUID();
	const profiles = join(directory, "provider-accounts");
	const accounts = new ProviderAccounts(directory, directory, async () => { throw Error("Defaults must not create a model runtime"); });
	try {
		mkdirSync(join(profiles, id), { recursive: true });
		writeFileSync(join(profiles, id, "account.json"), JSON.stringify({ id, provider: "openai-codex", name: "Work" }));
		const credential = JSON.stringify({ "openai-codex": { type: "api_key", key: "fixture-only" } });
		writeFileSync(join(profiles, id, "auth.json"), credential);
		writeFileSync(join(directory, "auth.json"), "{}\n");
		accounts.setDefault("openai-codex", id);
		assert.deepEqual(new ProviderAccounts(directory, directory).view().defaults, { "openai-codex": id });
		const fresh = SessionManager.inMemory(directory), legacy = SessionManager.inMemory(directory);
		assert.deepEqual(initializeAccountSelection(fresh, profiles, true), { "openai-codex": id });
		assert.deepEqual(initializeAccountSelection(legacy, profiles, false), {});
		accounts.setDefault("openai-codex", "pi");
		assert.deepEqual(initializeAccountSelection(fresh, profiles, true), { "openai-codex": id });
		assert.deepEqual(accountSelection(legacy), {});
		assert.deepEqual(initializeAccountSelection(SessionManager.inMemory(directory), profiles, true), { "openai-codex": "pi" });
		assert.throws(() => accounts.setDefault("openai-codex", randomUUID()), /available/);
		assert.equal(readFileSync(join(profiles, id, "auth.json"), "utf8"), credential);
		assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}\n");
	} finally { await accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("interrupted sign-in is not restarted and cannot select a localhost browser flow", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	let calls = 0;
	const factory = async () => ({ getProvider: () => ({ auth: { oauth: {} } }), login: async (_provider, _type, interaction) => {
		calls++; await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }] });
	} });
	const accounts = new ProviderAccounts(directory, directory, factory);
	try {
		const id = randomUUID(); accounts.start(id, "openai-codex", "Home"); await settled(accounts);
		assert.equal(accounts.view().signIns[0].state, "failed");
		assert.match(accounts.view().signIns[0].error, /device-code/);
		const receipt = join(directory, "provider-accounts", id, "sign-in.json");
		writeFileSync(receipt, JSON.stringify({ ...accounts.view().signIns[0], state: "waiting" }));
		const restored = new ProviderAccounts(directory, directory, factory);
		assert.equal(restored.view().signIns[0].state, "interrupted");
		restored.start(id, "openai-codex", "Home"); await setImmediate(); assert.equal(calls, 1);
	} finally { await accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("scoped child account stays pinned when the parent selects another account", async () => {
	const { mkdirSync } = await import("node:fs");
	const { SessionManager, createEventBus } = await import("@earendil-works/pi-coding-agent");
	const { AccountBinding, accountSelection } = await import("../src/host/account-binding.ts");
	const { installModelCredentials, getModelCredentials } = await import("../../pi-subagents/model-credentials.ts");
	const { inheritProviderRuntime } = await import("../../pi-subagents/extensions/subagents.ts");
	const directory = mkdtempSync(join(tmpdir(), "pi-account-binding-"));
	const profiles = join(directory, "profiles"), ids = [randomUUID(), randomUUID()];
	const oldFetch = globalThis.fetch;
	globalThis.fetch = () => { throw Error("Account fixture must not use network"); };
	const access = identity => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.fixture`;
	try {
		writeFileSync(join(directory, "auth.json"), "{}\n");
		for (const id of ids) {
			const path = join(profiles, id); mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "account.json"), JSON.stringify({ id, provider: "openai-codex", name: id }));
			writeFileSync(join(path, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: access(id), refresh: "fixture", expires: Date.now() + 3600000 } }));
		}
		const parent = new AccountBinding(directory, profiles, { "openai-codex": ids[0] });
		const childSession = SessionManager.inMemory(directory), signal = new AbortController().signal;
		const child = await parent.capability().create(childSession, signal);
		assert.equal((await child.runtime.getAuth("openai-codex")).auth.apiKey, access(ids[0]));
		parent.select({ "openai-codex": ids[1] });
		const resumed = await parent.capability().create(childSession, signal);
		assert.equal((await resumed.runtime.getAuth("openai-codex")).auth.apiKey, access(ids[0]));
		assert.deepEqual(accountSelection(childSession), { "openai-codex": ids[0] });
		const pi = { events: createEventBus(), on() {} }; installModelCredentials(pi, resumed.binding);
		const grandchild = await getModelCredentials(pi).create(SessionManager.inMemory(directory), signal);
		assert.equal((await grandchild.runtime.getAuth("openai-codex")).auth.apiKey, access(ids[0]));
		const fresh = await parent.capability().create(SessionManager.inMemory(directory), signal);
		assert.equal((await fresh.runtime.getAuth("openai-codex")).auth.apiKey, access(ids[1]));
		const model = { id: "fixture", name: "Fixture", provider: "openai-codex", api: "openai-codex-responses", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
		const provider = { ...child.runtime.getProvider("openai-codex"), getModels: () => [model] };
		const ctx = { modelRegistry: { find: () => model, getProvider: () => provider, getRegisteredNativeProvider: () => provider,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: access(ids[1]) }),
			getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: access(ids[1]) } }),
		} };
		await inheritProviderRuntime(ctx, { provider: model.provider, id: model.id }, child.runtime, undefined, signal, true);
		await assert.rejects(inheritProviderRuntime(ctx, { provider: model.provider, id: model.id }, child.runtime, undefined, signal), /same OAuth credential store/);
		assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}\n");
	} finally { globalThis.fetch = oldFetch; rmSync(directory, { recursive: true, force: true }); }
});

test("cancelled unconfirmed sign-in fences a delayed admission across restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-account-cancel-")), id = randomUUID();
	let calls = 0;
	const factory = async () => { calls++; throw Error("Cancelled sign-in must not start"); };
	try {
		const first = new ProviderAccounts(directory, directory, factory);
		await first.cancel(id);
		assert.equal(first.start(id, "openai-codex", "Work").state, "cancelled");
		const restored = new ProviderAccounts(directory, directory, factory);
		assert.equal(restored.start(id, "openai-codex", "Work").state, "cancelled");
		assert.equal(calls, 0); assert.deepEqual(restored.view().accounts, []);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native provider secrets use host Settings prompts and isolated stores", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-provider-key-")), provider = "anthropic";
	const descriptor = { id: provider, name: "Anthropic", auth: { apiKey: { login() {} } } };
	let fail = false;
	const factory = async options => ({
		getProviders: () => [descriptor], getProvider: () => descriptor,
		login: async (id, type, interaction) => {
			assert.equal(id, provider); assert.equal(type, "api_key");
			const key = await interaction.prompt({ type: "secret", message: "API key" });
			if (fail) throw Error(`Rejected key: ${key}`);
			writeFileSync(options.authPath, JSON.stringify({ [id]: { type: "api_key", key } }));
		},
	});
	writeFileSync(join(directory, "auth.json"), "{}\n");
	const accounts = new ProviderAccounts(directory, directory, factory);
	try {
		assert.deepEqual((await accounts.snapshot()).providers, [{ id: provider, name: "Anthropic", types: ["api_key"] }]);
		for (const failed of [false, true]) {
			fail = failed; const id = randomUUID(); accounts.start(id, provider, "Key account", "api_key"); await settled(accounts);
			let operation = accounts.view().signIns.find(item => item.id === id); assert.equal(operation.prompt.kind, "secret");
			accounts.answer(id, operation.prompt.id, "fixture-secret-key"); await setImmediate();
			operation = accounts.view().signIns.find(item => item.id === id); assert.equal(operation.state, failed ? "failed" : "completed");
			assert.ok(!JSON.stringify(accounts.view()).includes("fixture-secret-key"));
			assert.ok(!readFileSync(join(directory, "provider-accounts", id, "sign-in.json"), "utf8").includes("fixture-secret-key"));
			if (failed) assert.equal(operation.error, "Rejected key: [redacted]");
		}
		assert.equal(accounts.view().accounts.length, 1); assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}\n");
	} finally { await accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Anthropic sign-in uses the native headless flow without a localhost callback", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-anthropic-account-")), id = randomUUID();
	const descriptor = { id: "anthropic", name: "Anthropic", auth: { oauth: { isSubscription: true } } };
	const factory = async options => ({
		getProviders: () => [descriptor], getProvider: () => descriptor,
		login: async (provider, type, interaction) => {
			assert.equal(provider, "anthropic"); assert.equal(type, "oauth");
			assert.equal(await interaction.prompt({ type: "select", message: "Select Anthropic login method:", options: [
				{ id: "browser", label: "Browser login (default)" }, { id: "copy_code", label: "Copy code login (headless)" },
			] }), "copy_code");
			interaction.notify({ type: "auth_url", url: "https://provider.example.test/authorize?state=fixture", instructions: "Copy the returned code." });
			assert.equal(await interaction.prompt({ type: "manual_code", message: "Paste the returned code", placeholder: "code#state" }), "fixture-code#fixture");
			writeFileSync(options.authPath, JSON.stringify({ anthropic: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 } }));
		},
	});
	writeFileSync(join(directory, "auth.json"), "{}\n");
	const accounts = new ProviderAccounts(directory, directory, factory);
	try {
		assert.deepEqual((await accounts.snapshot()).providers, [{ id: "anthropic", name: "Anthropic", types: ["oauth"], subscription: true }]);
		accounts.start(id, "anthropic", "Claude account"); await settled(accounts);
		const operation = accounts.view().signIns.find(item => item.id === id);
		assert.equal(operation.prompt.kind, "manual_code");
		assert.equal(operation.links[0].url, "https://provider.example.test/authorize?state=fixture");
		assert.ok(!readFileSync(join(directory, "provider-accounts", id, "sign-in.json"), "utf8").includes("state=fixture"));
		accounts.answer(id, operation.prompt.id, "fixture-code#fixture"); await setImmediate(); await setImmediate();
		assert.equal(accounts.view().signIns.find(item => item.id === id).state, "completed");
		assert.equal(accounts.view().accounts[0].name, "Claude account");
		assert.ok(!JSON.stringify(accounts.view()).includes("fixture-access"));
		assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}\n");
	} finally { await accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("reading native account providers neither creates credentials nor accesses the network", async () => {
	const { existsSync } = await import("node:fs");
	const directory = mkdtempSync(join(tmpdir(), "pi-account-catalog-")), oldFetch = globalThis.fetch;
	globalThis.fetch = () => { throw Error("Catalog must stay offline"); };
	try {
		const accounts = new ProviderAccounts(directory, directory), snapshot = await accounts.snapshot();
		assert.ok(snapshot.providers.find(provider => provider.id === "openai-codex").types.includes("oauth"));
		assert.ok(snapshot.providers.find(provider => provider.id === "anthropic").types.includes("api_key"));
		assert.deepEqual(snapshot.accounts, []); assert.equal(existsSync(join(directory, "auth.json")), false);
		await accounts.close();
	} finally { globalThis.fetch = oldFetch; rmSync(directory, { recursive: true, force: true }); }
});

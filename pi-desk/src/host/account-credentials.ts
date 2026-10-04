import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential, CredentialInfo, CredentialStore, AuthOperationOptions } from "@earendil-works/pi-ai";
import { atomicJson } from "../../manage/store.ts";
import type { ProviderAccount } from "../shared/provider-accounts.ts";

export type AccountSelection = Readonly<Record<string, string>>;
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function readJson<T>(path: string): T | undefined {
	try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function credentials(path: string): Record<string, Credential> {
	const data = readJson<Record<string, Credential>>(path) ?? {};
	if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some(value => !value || !["oauth", "api_key"].includes(value.type))) throw Error("Invalid credential file.");
	return data;
}

/** Immutable account routing; credential refresh remains serialized across native Pi and Desk. */
export class AccountCredentials implements CredentialStore {
	readonly selection: AccountSelection;
	private agentDir: string;
	private profiles: string;
	private resolvers = new Map<string, Promise<ModelRuntime>>();
	constructor(agentDir: string, profiles: string, selection: AccountSelection = {}) {
		this.agentDir = agentDir; this.profiles = profiles; this.selection = Object.freeze({ ...selection });
		for (const [provider, id] of Object.entries(selection)) this.path(provider, id);
	}
	fork(selection = this.selection): AccountCredentials { return new AccountCredentials(this.agentDir, this.profiles, selection); }
	private path(provider: string, id = this.selection[provider]): string {
		if (!id || id === "pi") return join(this.agentDir, "auth.json");
		if (!uuid(id)) throw Error("Invalid account selection.");
		const account = readJson<ProviderAccount>(join(this.profiles, id, "account.json"));
		if (!account || account.provider !== provider) throw Error("Selected account is unavailable. Choose another account before continuing.");
		return join(this.profiles, id, "auth.json");
	}
	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const path = this.path(provider), value = credentials(path)[provider];
		if (this.selection[provider] && this.selection[provider] !== "pi" && !value) throw Error("Selected account has no credential. Choose another account before continuing.");
		if (value?.type !== "api_key" || value.key === undefined) return value;
		// Let Pi resolve its own command/environment key syntax rather than executing it here.
		let resolver = this.resolvers.get(path);
		if (!resolver) {
			resolver = ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
			this.resolvers.set(path, resolver);
		}
		const runtime = await resolver;
		runtime.registerNativeProvider({ id: provider, name: provider, getModels: () => [],
			stream: () => { throw Error("Credential resolver has no model stream."); },
			streamSimple: () => { throw Error("Credential resolver has no model stream."); },
			auth: { apiKey: { name: "Stored key", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } },
		});
		const auth = await runtime.getAuth(provider, options);
		return { ...value, key: auth?.auth.apiKey };
	}
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const stored = { ...credentials(join(this.agentDir, "auth.json")) };
		for (const provider of Object.keys(this.selection)) {
			const credential = credentials(this.path(provider))[provider];
			if (!credential && this.selection[provider] !== "pi") throw Error("Selected account has no credential. Choose another account before continuing.");
			if (credential) stored[provider] = credential; else delete stored[provider];
		}
		return Object.entries(stored).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
	private async change<T>(provider: string, fn: (current: Record<string, Credential>) => Promise<{ result: T; next?: Record<string, Credential> }>, options?: AuthOperationOptions): Promise<T> {
		options?.signal?.throwIfAborted();
		const path = this.path(provider); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try { writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		let release: (() => Promise<void>) | undefined, compromised: Error | undefined;
		const deadline = Date.now() + 30_000;
		for (;;) {
			options?.signal?.throwIfAborted();
			try { release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 30_000, onCompromised: error => { compromised = error; } }); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
				await sleep(100, undefined, { signal: options?.signal });
			}
		}
		try {
			options?.signal?.throwIfAborted();
			const result = await fn(credentials(path));
			if (compromised) throw compromised;
			if (result.next) atomicJson(path, result.next);
			return result.result;
		} finally { await release(); }
	}
	modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.change(provider, async data => {
			const next = await fn(data[provider]);
			return next === undefined ? { result: data[provider] } : { result: next, next: { ...data, [provider]: next } };
		}, options);
	}
	delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		return this.change(provider, async data => { delete data[provider]; return { result: undefined, next: data }; }, options);
	}
}

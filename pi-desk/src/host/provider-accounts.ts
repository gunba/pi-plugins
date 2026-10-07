import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, CredentialSynchronizationError, readStoredCredential, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";
import { atomicJson } from "../../manage/store.ts";
import { providerIdentity } from "./provider-identity.ts";
import { AccountCredentials } from "./account-credentials.ts";
import { accountDefaults } from "./account-defaults.ts";
import type { ProviderAccount, ProviderSignIn, ProviderAccountsSnapshot, AccountProvider, ProviderAuthType } from "../shared/provider-accounts.ts";

const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const pending = (state: ProviderSignIn["state"]) => ["starting", "waiting", "saving"].includes(state);
const safeLinks = (links: { label?: string; url: string }[]) => links.map(link => {
	const url = new URL(link.url);
	if (url.protocol !== "https:" || url.username || url.password) throw Error("Provider returned an invalid sign-in link.");
	return { label: link.label ?? "Open sign-in page", url: url.href };
});
type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<Pick<ModelRuntime, "getProvider" | "getProviders" | "login">>;
interface ActiveSignIn {
	controller: AbortController; work: Promise<void>; inputs: string[];
	answer?: { id: string; finish: (answer?: string) => void };
}

/** Authentication belongs to the host, never to a conversation's tools or UI interactions. */
export class ProviderAccounts {
	private directory: string;
	private agentDir: string;
	private operations = new Map<string, ProviderSignIn>();
	private active = new Map<string, ActiveSignIn>();
	private factory: RuntimeFactory;
	private catalog?: Promise<Pick<ModelRuntime, "getProviders">>;
	private providers: AccountProvider[] = [{ id: "openai-codex", name: "OpenAI Codex", types: ["oauth"] }];
	constructor(dataDir: string, agentDir: string, factory: RuntimeFactory = options => ModelRuntime.create(options)) {
		this.directory = join(dataDir, "provider-accounts"); this.agentDir = agentDir; this.factory = factory;
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const id of readdirSync(this.directory).filter(uuid)) {
			const operation = this.read<ProviderSignIn>(join(this.directory, id, "sign-in.json"));
			if (!operation) continue;
			if (pending(operation.state)) this.publish({ ...operation, state: "interrupted", error: "Desk stopped during sign-in. Review saved accounts before starting another sign-in." });
			else this.operations.set(id, operation);
		}
	}
	private read<T>(path: string): T | undefined {
		try { return JSON.parse(readFileSync(path, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	private folder(id: string): string {
		if (!uuid(id)) throw Error("Invalid account ID."); return join(this.directory, id);
	}
	authPath(provider: string, id: string): string {
		if (id === "pi") return join(this.agentDir, "auth.json");
		const account = this.read<ProviderAccount>(join(this.folder(id), "account.json"));
		if (!account || account.provider !== provider) throw Error("This account is no longer available.");
		return join(this.folder(id), "auth.json");
	}
	setDefault(provider: string, id: string): ProviderAccountsSnapshot {
		if (!this.providers.some(item => item.id === provider)) throw Error("Account defaults are unavailable for this provider.");
		const path = this.authPath(provider, id);
		if (id !== "pi" && !readStoredCredential(provider, path)) throw Error("Selected account is unavailable.");
		atomicJson(join(this.directory, "defaults.json"), { ...accountDefaults(this.directory), [provider]: id });
		return this.view();
	}
	private publish(operation: ProviderSignIn): void {
		const current = this.operations.get(operation.id);
		if (current && current !== operation) { Object.assign(current, operation); operation = current; }
		this.operations.set(operation.id, operation);
		// Verification codes and pending prompts have only an in-memory lifetime.
		const { device, prompt, links, ...receipt } = operation;
		atomicJson(join(this.folder(operation.id), "sign-in.json"), receipt);
	}
	get signingIn(): boolean { return this.active.size > 0; }
	async snapshot(): Promise<ProviderAccountsSnapshot> {
		this.catalog ??= this.factory({ credentials: new AccountCredentials(this.agentDir, this.directory), modelsPath: join(this.agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
		try {
			const runtime = await this.catalog;
			this.providers = runtime.getProviders().flatMap(provider => {
				const types: ProviderAuthType[] = [...provider.auth.oauth ? ["oauth" as const] : [], ...provider.auth.apiKey?.login ? ["api_key" as const] : []];
				return types.length ? [{ id: provider.id, name: provider.name, types,
					...(provider.auth.oauth?.isSubscription ? { subscription: true } : {}),
				}] : [];
			});
			return this.view();
		} catch (error) { this.catalog = undefined; throw error; }
	}
	view(): ProviderAccountsSnapshot {
		const accounts: ProviderAccount[] = [];
		for (const provider of this.providers) {
			const native = readStoredCredential(provider.id, join(this.agentDir, "auth.json"));
			if (native) accounts.push({ id: "pi", provider: provider.id, name: "Pi account", native: true, identity: providerIdentity(native) });
		}
		for (const id of readdirSync(this.directory).filter(uuid)) {
			const account = this.read<ProviderAccount>(join(this.folder(id), "account.json"));
			if (!account) continue;
			const credential = readStoredCredential(account.provider, join(this.folder(id), "auth.json"));
			if (credential) accounts.push({ ...account, identity: providerIdentity(credential) });
		}
		return structuredClone({ defaults: accountDefaults(this.directory), providers: this.providers, accounts, signIns: [...this.operations.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 15) });
	}
	start(id: string, provider: string, name: string, type: ProviderAuthType = "oauth"): ProviderSignIn {
		if (!uuid(id) || !provider || provider.length > 200 || !["oauth", "api_key"].includes(type) || typeof name !== "string" || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw Error("Choose a provider, sign-in method and account name.");
		name = name.trim();
		const previous = this.operations.get(id);
		if (previous) {
			if (previous.state === "cancelled") return structuredClone(previous);
			if (previous.provider !== provider || previous.name !== name || (previous.type ?? "oauth") !== type) throw Error("Sign-in ID was reused for another account.");
			return structuredClone(previous);
		}
		if ([...this.operations.values()].some(operation => pending(operation.state))) throw Error("Finish or cancel the current sign-in first.");
		const folder = this.folder(id); mkdirSync(folder, { recursive: true, mode: 0o700 });
		atomicJson(join(folder, "account.json"), { id, provider, name });
		const operation: ProviderSignIn = { id, provider, name, type, created: new Date().toISOString(), state: "starting", message: "Starting provider sign-in…" };
		this.publish(operation);
		const active: ActiveSignIn = { controller: new AbortController(), work: Promise.resolve(), inputs: [] };
		this.active.set(id, active);
		active.work = this.signIn(operation, active).finally(() => { if (this.active.get(id) === active) this.active.delete(id); });
		return structuredClone(operation);
	}
	private async signIn(operation: ProviderSignIn, active: ActiveSignIn): Promise<void> {
		const signal = active.controller.signal;
		try {
			const runtime = await this.factory({ authPath: this.authPath(operation.provider, operation.id), modelsPath: join(this.agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false, signal });
			signal.throwIfAborted();
			const type = operation.type ?? "oauth", provider = runtime.getProvider(operation.provider);
			if (!provider || (type === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login)) throw Error("This provider's sign-in method is unavailable.");
			await runtime.login(operation.provider, type, {
				signal, notify: event => this.notify(operation, event),
				prompt: prompt => {
					// The native provider keeps ownership of device issuance, polling and token exchange.
					if (type === "oauth" && prompt.type === "select") {
						const headless = ["device_code", "copy_code"].find(id => prompt.options.some(option => option.id === id));
						if (headless) return Promise.resolve(headless);
						if (operation.provider === "openai-codex" && prompt.options.some(option => /browser/i.test(option.id)))
							throw Error("This provider does not offer device-code sign-in. Its browser callback cannot be used remotely here.");
					}
					return this.prompt(operation, active, prompt);
				},
			});
			this.publish({ ...operation, state: "completed", account: operation.id, message: "Account saved. Choose it for a conversation.", device: undefined, prompt: undefined, links: undefined });
		} catch (error) {
			const detail = active.inputs.reduce((text, input) => input ? text.replaceAll(input, "[redacted]") : text, error instanceof Error ? error.message : String(error));
			if (error instanceof CredentialSynchronizationError && readStoredCredential(operation.provider, this.authPath(operation.provider, operation.id))) {
				this.publish({ ...operation, state: "completed", account: operation.id, message: "Account saved; its model availability needs refreshing.", error: detail, device: undefined, prompt: undefined, links: undefined });
			} else this.publish({ ...operation, state: signal.aborted ? "cancelled" : "failed", error: signal.aborted ? undefined : detail, device: undefined, prompt: undefined, links: undefined });
		} finally { active.answer?.finish(); active.inputs.length = 0; }
	}
	private notify(operation: ProviderSignIn, event: AuthEvent): void {
		if (!pending(operation.state)) return;
		operation.state = "waiting"; operation.prompt = undefined;
		if (event.type === "device_code") {
			operation.message = "Open the verification page and enter this code.";
			operation.device = { code: event.userCode, ...(event.expiresInSeconds ? { expires: Date.now() + event.expiresInSeconds * 1000 } : {}) };
			operation.links = safeLinks([{ label: "Open verification page", url: event.verificationUri }]);
		} else if (event.type === "auth_url") {
			if (operation.provider === "openai-codex") throw Error("Codex did not start device-code sign-in. Cancel this flow and use its device-code method.");
			operation.message = event.instructions ?? "Open the provider page to continue sign-in.";
			operation.links = safeLinks([{ label: "Open sign-in page", url: event.url }]);
		} else { operation.message = event.message; if (event.type === "info" && event.links) operation.links = safeLinks([...event.links]); }
		this.publish(operation);
	}
	private prompt(operation: ProviderSignIn, active: ActiveSignIn, prompt: AuthPrompt): Promise<string> {
		const signal = prompt.signal ? AbortSignal.any([prompt.signal, active.controller.signal]) : active.controller.signal;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const finish = (answer?: string) => {
				if (active.answer?.id !== id) return;
				active.answer = undefined; signal.removeEventListener("abort", abort);
				operation.prompt = undefined;
				answer === undefined ? reject(Error("Sign-in cancelled.")) : resolve(answer);
			};
			const abort = () => finish();
			active.answer = { id, finish }; signal.addEventListener("abort", abort, { once: true });
			operation.state = "waiting"; operation.message = prompt.message;
			operation.prompt = { id, kind: prompt.type, message: prompt.message, ...(prompt.type === "select" ? { options: [...prompt.options] } : { placeholder: prompt.placeholder }) };
			this.publish(operation);
		});
	}
	answer(id: string, prompt: string, value: string): void {
		const active = this.active.get(id), operation = this.operations.get(id);
		if (!active?.answer || active.answer.id !== prompt || typeof value !== "string" || value.length > 32_000) throw Error("The sign-in prompt changed. Refresh it before answering.");
		if (operation?.prompt?.kind === "select" && !operation.prompt.options?.some(option => option.id === value)) throw Error("Choose one of the offered sign-in methods.");
		if (operation?.prompt?.kind !== "select") active.inputs.push(value);
		active.answer.finish(value);
	}
	async cancel(id: string): Promise<void> {
		const active = this.active.get(id);
		if (active) { active.controller.abort(); await active.work; return; }
		if (this.operations.has(id)) return;
		// A cancellation fences a delayed admission with the same operation ID.
		const folder = this.folder(id); mkdirSync(folder, { recursive: true, mode: 0o700 });
		this.publish({ id, provider: "openai-codex", name: "", created: new Date().toISOString(), state: "cancelled", message: "Sign-in cancelled before admission." });
	}
	async close(): Promise<void> {
		for (const active of this.active.values()) active.controller.abort();
		await Promise.all([...this.active.values()].map(active => active.work));
	}
}

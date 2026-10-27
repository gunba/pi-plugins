import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { ModelRuntime, CredentialSynchronizationError, readStoredCredential, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, AuthEvent, Credential } from "@earendil-works/pi-ai";
import { atomicJson } from "../../manage/store.ts";
import { providerIdentity } from "./provider-identity.ts";
import type { LoginProvider, LoginsSnapshot, ProviderAuthType, SignIn } from "../shared/logins.ts";

const pending = (state: SignIn["state"]) => ["starting", "waiting"].includes(state);
const safeLinks = (links: { label?: string; url: string }[]) => links.map(link => {
	const url = new URL(link.url);
	if (url.protocol !== "https:" || url.username || url.password) throw Error("Provider returned an invalid sign-in link.");
	return { label: link.label ?? "Open sign-in page", url: url.href };
});
type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<Pick<ModelRuntime, "getProvider" | "getProviders" | "login" | "logout">>;
interface Active { controller: AbortController; work: Promise<void>; inputs: string[]; answer?: { id: string; finish: (answer?: string) => void } }

/**
 * Pi's own logins, run from Desk: one per provider, in Pi's auth.json, shared with terminal Pi and every conversation.
 * Sign-in runs on the host, never inside a conversation; its prompts and codes are shown in Settings.
 */
export class Logins {
	private agentDir: string;
	private authPath: string;
	private factory: RuntimeFactory;
	private operations = new Map<string, SignIn>();
	private active = new Map<string, Active>();
	private catalog?: Promise<Pick<ModelRuntime, "getProviders">>;
	constructor(agentDir: string, factory: RuntimeFactory = options => ModelRuntime.create(options)) {
		this.agentDir = agentDir; this.authPath = join(agentDir, "auth.json"); this.factory = factory;
	}
	private runtime(signal?: AbortSignal) {
		return this.factory({ authPath: this.authPath, modelsPath: join(this.agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false, signal });
	}
	get signingIn(): boolean { return this.active.size > 0; }
	async snapshot(): Promise<LoginsSnapshot> {
		// The provider list needs no credentials: read with an empty store, so listing never creates or refreshes anything.
		this.catalog ??= this.factory({ credentials: { read: async () => undefined, list: async () => [], delete: async () => {},
			modify: async () => { throw Error("The provider list cannot change logins."); } },
			modelsPath: join(this.agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
		let providers: LoginProvider[];
		try {
			providers = (await this.catalog).getProviders().flatMap(provider => {
				const types: ProviderAuthType[] = [...provider.auth.oauth ? ["oauth" as const] : [], ...provider.auth.apiKey?.login ? ["api_key" as const] : []];
				if (!types.length) return [];
				const credential = readStoredCredential(provider.id, this.authPath);
				return [{ id: provider.id, name: provider.name, types, ...(provider.auth.oauth?.isSubscription ? { subscription: true } : {}),
					...(credential ? { signedIn: { type: credential.type, ...(providerIdentity(credential) ? { identity: providerIdentity(credential) } : {}) } } : {}) }];
			});
		} catch (error) { this.catalog = undefined; throw error; }
		return structuredClone({ providers, signIns: [...this.operations.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 5) });
	}
	start(id: string, provider: string, type: ProviderAuthType = "oauth"): SignIn {
		if (!/^[a-f0-9-]{36}$/.test(id) || !provider || provider.length > 200 || !["oauth", "api_key"].includes(type)) throw Error("Choose a provider and sign-in method.");
		const previous = this.operations.get(id);
		if (previous) {
			if (previous.state !== "cancelled" && (previous.provider !== provider || previous.type !== type)) throw Error("Sign-in ID was reused for another provider.");
			return structuredClone(previous);
		}
		if ([...this.operations.values()].some(operation => pending(operation.state))) throw Error("Finish or cancel the current sign-in first.");
		const operation: SignIn = { id, provider, type, created: new Date().toISOString(), state: "starting", message: type === "api_key" ? "Preparing API key entry…" : "Starting sign-in…" };
		this.operations.set(id, operation);
		const active: Active = { controller: new AbortController(), work: Promise.resolve(), inputs: [] };
		this.active.set(id, active);
		active.work = this.signIn(operation, active).finally(() => { if (this.active.get(id) === active) this.active.delete(id); });
		return structuredClone(operation);
	}
	async signOut(provider: string): Promise<LoginsSnapshot> {
		if (this.signingIn) throw Error("Finish or cancel the current sign-in first.");
		await (await this.runtime()).logout(provider);
		return this.snapshot();
	}
	private finish(operation: SignIn, update: Partial<SignIn>): void {
		Object.assign(operation, { device: undefined, prompt: undefined, links: undefined }, update);
	}
	private async signIn(operation: SignIn, active: Active): Promise<void> {
		const signal = active.controller.signal;
		try {
			const runtime = await this.runtime(signal);
			signal.throwIfAborted();
			const provider = runtime.getProvider(operation.provider);
			if (!provider || (operation.type === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login)) throw Error("This provider's sign-in method is unavailable.");
			await runtime.login(operation.provider, operation.type, {
				signal, notify: event => this.notify(operation, event),
				prompt: prompt => {
					// Desk is often used from another device: prefer the provider's device-code or copy-code method.
					if (operation.type === "oauth" && prompt.type === "select") {
						const headless = ["device_code", "copy_code"].find(id => prompt.options.some(option => option.id === id));
						if (headless) return Promise.resolve(headless);
						if (operation.provider === "openai-codex" && prompt.options.some(option => /browser/i.test(option.id)))
							throw Error("This provider does not offer device-code sign-in. Its browser callback cannot be used remotely here.");
					}
					return this.prompt(operation, active, prompt);
				},
			});
			this.finish(operation, { state: "completed", message: operation.type === "api_key" ? "API key saved. Every conversation on this computer and terminal Pi use it." : "Signed in. Every conversation on this computer and terminal Pi use this login." });
		} catch (error) {
			const detail = active.inputs.reduce((text, input) => input ? text.replaceAll(input, "[redacted]") : text, error instanceof Error ? error.message : String(error));
			if (error instanceof CredentialSynchronizationError && readStoredCredential(operation.provider, this.authPath))
				this.finish(operation, { state: "completed", message: "Signed in; the model list will refresh shortly.", error: detail });
			else this.finish(operation, { state: signal.aborted ? "cancelled" : "failed", error: signal.aborted ? undefined : detail });
		} finally { active.answer?.finish(); active.inputs.length = 0; }
	}
	private notify(operation: SignIn, event: AuthEvent): void {
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
	}
	private prompt(operation: SignIn, active: Active, prompt: AuthPrompt): Promise<string> {
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
		// A cancellation can arrive before its start: it fences a late start with the same ID.
		if (!this.operations.has(id)) this.operations.set(id, { id, provider: "", type: "oauth", created: new Date().toISOString(), state: "cancelled" });
	}
	async close(): Promise<void> {
		for (const active of this.active.values()) active.controller.abort();
		await Promise.all([...this.active.values()].map(active => active.work));
	}
}

/**
 * Earlier Desk versions kept their own named logins beside Pi's. Each provider's default moves into Pi's auth.json when
 * Pi has no login for it; Pi's own login wins otherwise. The old store is deleted once no conversation still runs the
 * code that read it.
 */
export async function adoptSavedLogins(dataDir: string, agentDir: string): Promise<string[]> {
	const folder = join(dataDir, "provider-accounts"), marker = join(folder, "adopted");
	if (!existsSync(folder) || existsSync(marker)) return [];
	const read = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
	const defaults = read<Record<string, string>>(join(folder, "defaults.json")) ?? {};
	const authPath = join(agentDir, "auth.json"), adopted: string[] = [];
	for (const [provider, id] of Object.entries(defaults)) {
		if (id === "pi" || !/^[a-f0-9-]{36}$/.test(id) || readStoredCredential(provider, authPath)) continue;
		const credential = readStoredCredential(provider, join(folder, id, "auth.json"));
		if (!credential) continue;
		await withAuthLock(authPath, data => ({ ...data, [provider]: credential }));
		adopted.push(provider);
	}
	writeFileSync(marker, `${new Date().toISOString()}\n`);
	return adopted;
}
export function retireSavedLogins(dataDir: string): void { rmSync(join(dataDir, "provider-accounts"), { recursive: true, force: true }); }

/** Writes Pi's auth.json under the lock Pi itself takes. */
async function withAuthLock(path: string, change: (data: Record<string, Credential>) => Record<string, Credential>): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try { writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	let release: (() => Promise<void>) | undefined;
	for (const deadline = Date.now() + 30_000; !release;) {
		try { release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 30_000 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error; await sleep(100); }
	}
	try { atomicJson(path, change(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "") || "{}"))); }
	finally { await release(); }
}

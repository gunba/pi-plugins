import { join } from "node:path";
import { ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { CredentialStore, Credential, CredentialInfo, AuthOperationOptions } from "@earendil-works/pi-ai";
import type { ModelCredentials } from "../../../pi-subagents/model-credentials.ts";
import { AccountCredentials, type AccountSelection } from "./account-credentials.ts";
import { accountDefaults } from "./account-defaults.ts";

export const ACCOUNT_ENTRY = "pi-desk/provider-accounts";
export function accountSelection(manager: Pick<SessionManager, "getBranch">): AccountSelection | undefined {
	const entry = [...manager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === ACCOUNT_ENTRY);
	if (!entry || entry.type !== "custom") return;
	const selection = (entry.data as { selection?: unknown } | undefined)?.selection;
	if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.values(selection).some(id => typeof id !== "string")) throw Error("Saved account selection is invalid.");
	return { ...selection as AccountSelection };
}

export function initializeAccountSelection(manager: Pick<SessionManager, "getBranch" | "appendCustomEntry">, directory: string, fresh: boolean): AccountSelection {
	const saved = accountSelection(manager);
	if (saved) return saved;
	const selected = fresh ? accountDefaults(directory) : {};
	manager.appendCustomEntry(ACCOUNT_ENTRY, { selection: selected });
	return selected;
}

/** Each native session owns a router; child factories freeze their own branch binding. */
export class AccountBinding implements CredentialStore {
	private agentDir: string;
	private profiles: string;
	private current: AccountCredentials;
	private listeners = new Set<() => void>();
	constructor(agentDir: string, profiles: string, selection: AccountSelection = {}) {
		this.agentDir = agentDir; this.profiles = profiles; this.current = new AccountCredentials(agentDir, profiles, selection);
	}
	get selection(): AccountSelection { return this.current.selection; }
	select(selection: AccountSelection): void {
		const next = new AccountCredentials(this.agentDir, this.profiles, selection);
		const changed = new Set([...Object.keys(this.selection), ...Object.keys(next.selection)]);
		const different = [...changed].some(provider => (this.selection[provider] ?? "pi") !== (next.selection[provider] ?? "pi"));
		this.current = next;
		if (different) for (const listener of this.listeners) listener();
	}
	read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> { return this.current.read(provider, options); }
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> { return this.current.list(options); }
	modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> { return this.current.modify(provider, fn, options); }
	delete(provider: string, options?: AuthOperationOptions): Promise<void> { return this.current.delete(provider, options); }
	async runtime(signal?: AbortSignal): Promise<ModelRuntime> {
		return ModelRuntime.create({ credentials: this, modelsPath: join(this.agentDir, "models.json"), allowModelNetwork: false, signal });
	}
	capability(): ModelCredentials {
		return {
			accountId: provider => this.selection[provider] ?? "pi",
			onChange: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
			create: async (manager, signal) => {
			let selected = accountSelection(manager);
			if (!selected) {
				selected = { ...this.selection };
				manager.appendCustomEntry(ACCOUNT_ENTRY, { selection: selected });
			}
			const child = new AccountBinding(this.agentDir, this.profiles, selected);
			return { runtime: await child.runtime(signal), binding: child.capability(), ownsProvider: provider => !!selected[provider] && selected[provider] !== "pi" };
		} };
	}
}

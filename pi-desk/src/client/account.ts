import {
	PublicClientApplication, BrowserCacheLocation, InteractionRequiredAuthError, LogLevel, EventType,
	type AccountInfo, type AuthenticationResult,
} from "@azure/msal-browser";
import {
	accountConfiguration, accountOrigin, deviceKey, identifier, workspaceIdentity, workspaceScope,
	type AccountConfiguration, type DeviceKey, type WorkspaceDevice, type MembershipPeer, type MembershipLease,
} from "../shared/account.ts";
import { accountProof } from "../shared/account-proof.ts";
import { signChannelProof, type ProofPurpose } from "../shared/account-channel.ts";
import { CredentialVerifier } from "../shared/device-credential.ts";

interface BrowserDevice { id: string; key: CryptoKey; publicKey: DeviceKey }
export interface AccountDirectory { account: string; revision: number; devices: Array<WorkspaceDevice & { online: boolean }> }
export class BrowserSignInRequired extends Error {
	constructor() { super("Sign in to your Pi Desk account."); }
}
export class AccountRequestError extends Error {
	status: number;
	constructor(status: number, code: string) { super(code); this.status = status; }
}

function keyDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("pi-desk-account", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("identities");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new Error("Browser device storage is unavailable."));
	});
}
async function storedDevice(namespace: string): Promise<BrowserDevice> {
	// Generate outside the transaction; the read/write transaction chooses one identity across tabs.
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
	const publicKey = (await deviceKey(await crypto.subtle.exportKey("jwk", pair.publicKey))).key;
	const candidate: BrowserDevice = { id: crypto.randomUUID(), key: pair.privateKey, publicKey };
	const db = await keyDatabase();
	try {
		const device = await new Promise<BrowserDevice>((resolve, reject) => {
			const transaction = db.transaction("identities", "readwrite"), store = transaction.objectStore("identities");
			const request = store.get(namespace);
			let value: BrowserDevice;
			request.onsuccess = () => { value = request.result ?? candidate; if (!request.result) store.put(value, namespace); };
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = transaction.onabort = () => reject(new Error("Cannot load this browser's account identity."));
		});
		identifier(device.id);
		if (!(device.key instanceof CryptoKey) || device.key.type !== "private" || device.key.extractable
			|| device.key.algorithm.name !== "ECDSA") throw new Error("Invalid browser account identity.");
		await deviceKey(device.publicKey);
		return device;
	} finally { db.close(); }
}
async function forgetDevice(namespace: string, expected: string): Promise<void> {
	const db = await keyDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("identities", "readwrite");
			const store = transaction.objectStore("identities"), request = store.get(namespace);
			request.onsuccess = () => { if (request.result?.id === expected) store.delete(namespace); };
			transaction.oncomplete = () => resolve();
			transaction.onerror = transaction.onabort = () => reject(new Error("Cannot remove the browser identity."));
		});
	} finally { db.close(); }
}

export class BrowserAccount {
	readonly config: AccountConfiguration;
	private application: PublicClientApplication;
	private device?: BrowserDevice;
	private namespace: string;
	private logoutKey: string;
	private credential?: { token: string; expires: number };
	private pending?: Promise<{ token: string; expires: number }>;
	private listeners = new Set<() => void>();
	private eventId: string | null;
	private revoked = false;
	private needsSignIn = false;
	private closed = false;
	private epoch = 0;
	private credentials: CredentialVerifier;
	private storageChanged = (event: StorageEvent) => {
		if ((!event.key || event.key === this.logoutKey) && this.markedOut()) {
			this.needsSignIn = true; this.epoch++; this.credential = undefined; this.device = undefined; this.pending = undefined; this.changed();
		}
	};
	private constructor(config: AccountConfiguration, application: PublicClientApplication) {
		this.config = config; this.application = application;
		this.credentials = new CredentialVerifier(config);
		this.namespace = `${config.origin}|${workspaceIdentity(config)}`;
		this.logoutKey = `pi-desk:signed-out:${this.namespace}`;
		this.needsSignIn = this.markedOut();
		addEventListener("storage", this.storageChanged);
		this.eventId = application.addEventCallback(event => {
			if (event.eventType === EventType.LOGIN_SUCCESS || event.eventType === EventType.LOGOUT_SUCCESS
				|| event.eventType === EventType.ACTIVE_ACCOUNT_CHANGED) {
				if (event.eventType === EventType.LOGOUT_SUCCESS
					|| event.eventType === EventType.ACTIVE_ACCOUNT_CHANGED && !application.getActiveAccount()) {
					this.needsSignIn = true; this.epoch++; this.credential = undefined; this.device = undefined; this.pending = undefined;
				} else this.needsSignIn = this.markedOut() || !this.account();
				this.changed();
			}
		});
	}
	static async open(origin: string): Promise<BrowserAccount> {
		origin = accountOrigin(origin);
		const response = await fetch(`${origin}/config`, {
			cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error("Pi Desk account service is unavailable.");
		const config = accountConfiguration(await response.json());
		if (config.origin !== origin || !config.appOrigins.includes(location.origin)) throw new Error("This app is not authorized for the account service.");
		const application = new PublicClientApplication({
			auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`,
				redirectUri: `${location.origin}/auth/redirect.html` },
			cache: { cacheLocation: BrowserCacheLocation.LocalStorage },
			system: { loggerOptions: { logLevel: LogLevel.Error, piiLoggingEnabled: false, loggerCallback: () => {} } },
		});
		await application.initialize();
		// Consume OAuth state before the application inspects or clears URL fragments.
		const result = await application.handleRedirectPromise();
		const client = new BrowserAccount(config, application);
		if (result) {
			application.setActiveAccount(result.account);
			client.needsSignIn = client.markedOut() || !result.account || !client.matches(result.account);
		}
		return client;
	}
	private matches(account: AccountInfo): boolean {
		return account.tenantId === this.config.tenantId && account.localAccountId === this.config.ownerObjectId;
	}
	account(): AccountInfo | undefined {
		const active = this.application.getActiveAccount();
		if (active) return this.matches(active) ? active : undefined;
		return this.application.getAllAccounts().find(account => this.matches(account));
	}
	private markedOut(): boolean { return localStorage.getItem(this.logoutKey) === "1"; }
	signedIn(): boolean { return !this.closed && !this.markedOut() && !this.needsSignIn && !this.revoked && !!this.account(); }
	private checked(result: AuthenticationResult): AuthenticationResult {
		if (!result.account || !this.matches(result.account) || !result.accessToken) throw new BrowserSignInRequired();
		return result;
	}
	watch(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private changed(): void { for (const listener of this.listeners) listener(); }
	async signIn(): Promise<void> {
		if (this.revoked) {
			if (this.device) await forgetDevice(this.namespace, this.device.id);
			this.device = undefined; this.credential = undefined; this.revoked = false;
		}
		this.needsSignIn = false;
		localStorage.removeItem(this.logoutKey);
		await this.application.loginRedirect({ scopes: [workspaceScope(this.config)], prompt: "select_account" });
	}
	private async token(forceRefresh: boolean): Promise<string> {
		const account = this.account();
		if (!account) throw new BrowserSignInRequired();
		try {
			return this.checked(await this.application.acquireTokenSilent({
				account, scopes: [workspaceScope(this.config)], forceRefresh,
			})).accessToken;
		} catch (error) {
			if (error instanceof InteractionRequiredAuthError || error instanceof BrowserSignInRequired) {
				this.needsSignIn = true; this.credential = undefined; this.changed(); throw new BrowserSignInRequired();
			}
			throw new Error("Account refresh is temporarily unavailable.");
		}
	}
	private async identity(): Promise<BrowserDevice> {
		if (this.closed || this.markedOut()) throw new BrowserSignInRequired();
		if (this.device) return this.device;
		const epoch = this.epoch, device = await storedDevice(this.namespace);
		if (this.closed || epoch !== this.epoch) throw new BrowserSignInRequired();
		return this.device = device;
	}
	async request<T>(path: string, input?: Record<string, unknown>, forceRefresh = false): Promise<T> {
		if (this.closed || this.markedOut()) throw new BrowserSignInRequired();
		const epoch = this.epoch;
		const url = new URL(path, this.config.origin);
		if (!path.startsWith("/") || url.origin !== this.config.origin || url.search || url.hash) throw new Error("Invalid account request.");
		const method = input === undefined ? "GET" : "POST", body = input === undefined ? "" : JSON.stringify(input);
		const accessToken = await this.token(forceRefresh);
		const device = method === "POST" ? await this.identity() : undefined;
		const proof = device ? await accountProof({ id: device.id, method, url: url.href, body, accessToken }, device.key) : undefined;
		if (this.closed || this.markedOut() || epoch !== this.epoch) throw new BrowserSignInRequired();
		const response = await fetch(url, {
			method, credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
			headers: { Authorization: `Bearer ${accessToken}`, ...(device ? {
				"Content-Type": "application/json",
				"X-Pi-Desk-Proof": proof!,
			} : {}) }, ...(input === undefined ? {} : { body }),
		});
		if (this.closed || epoch !== this.epoch) throw new BrowserSignInRequired();
		if (response.status === 401 && !forceRefresh) return this.request<T>(path, input, true);
		const value = await response.json();
		if (!response.ok) {
			if (response.status === 401) { this.needsSignIn = true; this.credential = undefined; this.changed(); throw new BrowserSignInRequired(); }
			if (value?.error === "device_revoked") { this.revoked = true; this.credential = undefined; this.changed(); }
			throw new AccountRequestError(response.status, typeof value?.error === "string" ? value.error : "Account request failed.");
		}
		return value as T;
	}
	async enrol(): Promise<{ token: string; expires: number }> {
		if (this.credential && this.credential.expires > Date.now() / 1000 + 90) return this.credential;
		if (this.pending) return this.pending;
		const epoch = this.epoch;
		const job = (async () => {
			const device = await this.identity();
			const value = await this.request<{ token: string; expires: number }>("/devices/enrol", {
				id: device.id, kind: "browser", key: device.publicKey, name: navigator.platform || "Browser",
			});
			if (typeof value.token !== "string" || !Number.isSafeInteger(value.expires)) throw new Error("Invalid account credential.");
			if (this.closed || epoch !== this.epoch) throw new BrowserSignInRequired();
			this.credential = value; return value;
		})().finally(() => { if (this.pending === job) this.pending = undefined; });
		this.pending = job; return job;
	}
	async directory(): Promise<AccountDirectory> {
		const value = await this.request<AccountDirectory>("/workspace");
		if (value.account !== workspaceIdentity(this.config) || !Array.isArray(value.devices)) throw new Error("Invalid account directory.");
		const device = await this.identity();
		if (!value.devices.some(item => item.id === device.id && item.kind === "browser" && item.revoked === undefined)) {
			this.revoked = true; this.credential = undefined; this.changed();
			throw new BrowserSignInRequired();
		}
		return value;
	}
	async deviceId(): Promise<string> { return (await this.identity()).id; }
	verifier(): CredentialVerifier { return this.credentials; }
	async certificate(): Promise<string> { return (await this.enrol()).token; }
	async signProof(payload: Uint8Array<ArrayBuffer>, purpose: ProofPurpose): Promise<string> {
		return signChannelProof(payload, purpose, (await this.identity()).key);
	}
	async lease(peers: MembershipPeer[]): Promise<MembershipLease> {
		return this.request(`/devices/${(await this.identity()).id}/lease`, { peers });
	}
	async signOut(): Promise<void> {
		const device = await this.identity();
		if (!this.revoked) await this.request(`/devices/${device.id}/revoke`, {});
		// An in-flight MSAL refresh must not silently sign this browser back in.
		localStorage.setItem(this.logoutKey, "1");
		this.epoch++; this.needsSignIn = true; this.credential = undefined; this.changed();
		await forgetDevice(this.namespace, device.id);
		await this.application.clearCache({ account: this.account() });
		this.device = undefined; this.credential = undefined; this.changed();
	}
	close(): void {
		this.closed = true; this.epoch++;
		if (this.eventId) this.application.removeEventCallback(this.eventId);
		removeEventListener("storage", this.storageChanged);
		this.listeners.clear(); this.credential = undefined;
	}
}

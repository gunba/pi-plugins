import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { PublicClientApplication, LogLevel, InteractionRequiredAuthError, ServerError, type AccountInfo, type AuthenticationResult } from "@azure/msal-node";
import {
	PersistenceCreator, PersistenceCachePlugin, DataProtectionScope, type IPersistence,
} from "@azure/msal-node-extensions";
import { generateKeyPair, exportJWK, importJWK } from "jose";
import {
	accountConfiguration, deviceKey, identifier, workspaceIdentity, workspaceScope,
	type AccountConfiguration, type DeviceKey, type MembershipPeer, type MembershipLease,
} from "../shared/account.ts";
import { accountProof } from "../shared/account-proof.ts";
import { AccountNetwork } from "./account-network.ts";
import { signChannelProof, type ProofPurpose } from "../shared/account-channel.ts";
import { AccountSignInRequired } from "./account-errors.ts";
export interface NativeDeviceIdentity { id: string; key: DeviceKey; thumbprint: string }

/** Microsoft token cache and device signing key both use OS-protected persistence. */
export class NativeAccountIdentity {
	readonly config: AccountConfiguration;
	readonly device: NativeDeviceIdentity;
	private key: CryptoKey;
	private application: PublicClientApplication;
	private network: AccountNetwork;
	private secret: IPersistence;
	private certificateValue?: { token: string; expires: number };
	private renewing?: Promise<string>;

	private constructor(config: AccountConfiguration, device: NativeDeviceIdentity, key: CryptoKey,
		application: PublicClientApplication, network: AccountNetwork, secret: IPersistence) {
		this.config = config; this.device = device; this.key = key;
		this.application = application; this.network = network; this.secret = secret;
	}
	static async open(directory: string, configuration: AccountConfiguration,
		options: { create?: boolean; proxy?: string; replaceRevokedId?: string } = {}): Promise<NativeAccountIdentity> {
		if (options.replaceRevokedId && !options.create) throw new Error("Identity replacement requires explicit enrolment.");
		if (!["linux", "win32"].includes(process.platform)) throw new Error("Protected account persistence requires Windows or Linux.");
		const config = accountConfiguration(configuration);
		const privateDirectory = join(directory, "account");
		await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
		const path = await realpath(privateDirectory);
		const identity = workspaceIdentity(config);
		const namespace = createHash("sha256").update(JSON.stringify([
			process.platform === "win32" ? path.toLowerCase() : path, config.origin, identity,
		])).digest("hex");
		const persistence = (name: string) => PersistenceCreator.createPersistence({
			cachePath: join(path, name), dataProtectionScope: DataProtectionScope.CurrentUser,
			serviceName: "Pi Desk", accountName: `${namespace}:${name}`, usePlaintextFileOnLinux: false,
			loggerOptions: { logLevel: LogLevel.Error, piiLoggingEnabled: false, loggerCallback: () => {} },
		});
		const secret = await persistence("device");
		// CLI sign-in and a running host may load this identity concurrently.
		const release = await lockfile.lock(join(path, "identity"), { realpath: false, retries: 3 });
		let saved;
		try {
			const contents = await secret.load();
			if (contents) saved = JSON.parse(contents);
			if (options.replaceRevokedId && saved?.id === options.replaceRevokedId) saved = undefined;
			if (!saved) {
				if (!options.create) throw new AccountSignInRequired();
				const pair = await generateKeyPair("ES256", { extractable: true });
				saved = { version: 1, account: identity, id: crypto.randomUUID(),
					privateKey: await exportJWK(pair.privateKey) };
				await secret.save(JSON.stringify(saved));
			}
		} finally { await release(); }
		if (saved.version !== 1 || saved.account !== identity || identifier(saved.id) !== saved.id
			|| typeof saved.privateKey?.d !== "string") {
			throw new Error("Stored account identity does not match this computer.");
		}
		const { kty, crv, x, y } = saved.privateKey;
		const publicKey = await deviceKey({ kty, crv, x, y });
		const key = await importJWK({ ...saved.privateKey, ext: false }, "ES256") as CryptoKey;
		const cache = await persistence("microsoft");
		const network = new AccountNetwork(options.proxy);
		const application = new PublicClientApplication({
			auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}` },
			cache: { cachePlugin: new PersistenceCachePlugin(cache) },
			system: { networkClient: network,
				loggerOptions: { logLevel: LogLevel.Error, piiLoggingEnabled: false, loggerCallback: () => {} } },
		});
		return new NativeAccountIdentity(config, { id: saved.id, ...publicKey }, key, application, network, secret);
	}
	private matches(account: AccountInfo): boolean {
		return account.tenantId === this.config.tenantId && account.localAccountId === this.config.ownerObjectId;
	}
	private checked(result: AuthenticationResult | null): AuthenticationResult {
		if (!result?.account || !this.matches(result.account) || !result.accessToken) throw new AccountSignInRequired();
		return result;
	}
	async signIn(openBrowser: (url: string) => Promise<void>): Promise<void> {
		let fresh = false;
		try { await this.token(); return; }
		catch (error) {
			if (!(error instanceof AccountSignInRequired)) throw error;
			fresh = error.freshAuthentication;
		}
		const request = {
			scopes: [workspaceScope(this.config)], openBrowser,
			...(fresh ? { prompt: "login" as const } : {}),
			successTemplate: "<!doctype html><title>Pi Desk</title><p>Signed in. You can close this window.</p>",
			errorTemplate: "<!doctype html><title>Pi Desk</title><p>Sign-in did not complete. Return to Pi Desk.</p>",
		};
		let result = await this.application.acquireTokenInteractive(request);
		if (result?.account && !this.matches(result.account)) {
			result = await this.application.acquireTokenInteractive({ ...request, prompt: "select_account" });
		}
		this.checked(result);
	}
	private async token(forceRefresh = false): Promise<string> {
		const account = (await this.application.getTokenCache().getAllAccounts()).find(account => this.matches(account));
		if (!account) throw new AccountSignInRequired();
		try {
			return this.checked(await this.application.acquireTokenSilent({
				account, scopes: [workspaceScope(this.config)], forceRefresh,
			})).accessToken;
		} catch (error) {
			if (error instanceof AccountSignInRequired) throw error;
			if (error instanceof ServerError && String(error.errorNo) === "530035") {
				throw new AccountSignInRequired("Microsoft security defaults blocked authorization (AADSTS530035). Sign in again. If Microsoft still denies access, contact your tenant administrator.", true);
			}
			if (error instanceof InteractionRequiredAuthError) throw new AccountSignInRequired();
			throw new Error("Account refresh is temporarily unavailable. Check the connection before signing in again.");
		}
	}
	async request<T>(path: string, input?: Record<string, unknown>, forceRefresh = false): Promise<T> {
		const url = new URL(path, this.config.origin);
		if (url.origin !== this.config.origin || url.search || url.hash || !path.startsWith("/")) throw new Error("Invalid account request.");
		const method = input === undefined ? "GET" : "POST", body = input === undefined ? "" : JSON.stringify(input);
		const accessToken = await this.token(forceRefresh);
		const response = await this.network.request<T & { error?: string }>(method, url.href, {
			headers: { Authorization: `Bearer ${accessToken}`, ...(method === "POST" ? {
				"Content-Type": "application/json",
				"X-Pi-Desk-Proof": await accountProof({ id: this.device.id, method, url: url.href, body, accessToken }, this.key),
			} : {}) }, body,
		});
		if (response.status === 401 && !forceRefresh) return this.request<T>(path, input, true);
		if (response.status < 200 || response.status >= 300) {
			if (response.status === 401) throw new AccountSignInRequired();
			const codes = ["device_revoked", "device_identity_changed", "workspace_access_denied", "device_not_found"];
			throw new Error(codes.includes(response.body.error ?? "") ? response.body.error : "Account request failed.");
		}
		return response.body;
	}
	async enrol(name: string): Promise<{ token: string; expires: number }> {
		const result = await this.request<{ token: string; expires: number }>("/devices/enrol", {
			id: this.device.id, kind: "host", name, key: this.device.key,
		});
		this.certificateValue = result;
		return result;
	}
	async certificate(): Promise<string> {
		if (this.certificateValue && this.certificateValue.expires > Date.now() / 1000 + 90) return this.certificateValue.token;
		if (this.renewing) return this.renewing;
		this.renewing = this.request<{ token: string; expires: number }>(`/devices/${this.device.id}/credential`, {})
			.then(value => { this.certificateValue = value; return value.token; }).finally(() => { this.renewing = undefined; });
		return this.renewing;
	}
	signProof(payload: Uint8Array<ArrayBuffer>, purpose: ProofPurpose): Promise<string> {
		return signChannelProof(payload, purpose, this.key);
	}
	verifier() { return this.network.verifier(this.config); }
	lease(peers: MembershipPeer[], purpose?: "party"): Promise<MembershipLease> {
		return this.request(`/devices/${this.device.id}/lease`, { peers, ...(purpose ? { purpose } : {}) });
	}
	heartbeat(connected: boolean): Promise<unknown> {
		return this.request(`/devices/${this.device.id}/heartbeat`, { connected });
	}
	async signOut(): Promise<void> {
		// Revoke before removing the key; offline failure must not pretend remote access was revoked.
		await this.request(`/devices/${this.device.id}/revoke`, {});
		for (const account of await this.application.getTokenCache().getAllAccounts()) {
			await this.application.getTokenCache().removeAccount(account);
		}
		await this.secret.delete();
		this.certificateValue = undefined;
	}
	close(): void { this.network.close(); }
}

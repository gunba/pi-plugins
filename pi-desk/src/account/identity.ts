import {
	createRemoteJWKSet, errors, importJWK, jwtVerify, SignJWT,
	type JWK, type JWTVerifyGetKey,
} from "jose";
import {
	DEVICE_AUDIENCE, DEVICE_LIFETIME, DEVICE_TOKEN_TYPE, deviceKey, workspaceIdentity,
	type AccountConfiguration, type WorkspaceDevice,
} from "../shared/account.ts";

export class AccountError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export interface OwnerSettings { clientId: string; clientSecret: string; email: string }
export function ownerSettings(value: unknown): OwnerSettings {
	const input = value as Partial<OwnerSettings> | undefined;
	if (!input || typeof input.clientId !== "string" || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(input.clientId)
		|| typeof input.clientSecret !== "string" || !input.clientSecret || input.clientSecret.length > 200
		|| typeof input.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(input.email)) throw new Error("Invalid owner sign-in settings.");
	return { clientId: input.clientId, clientSecret: input.clientSecret, email: input.email.toLowerCase() };
}
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * The owner proves themselves with Google only to approve a new device; enrolled devices then use their own keys.
 * The service exchanges the code with its client secret, so the browser never handles a token.
 */
export class GoogleOwner {
	private settings: OwnerSettings;
	private keys: JWTVerifyGetKey;
	private exchange: (form: URLSearchParams) => Promise<Response>;
	constructor(settings: OwnerSettings, options: { keys?: JWTVerifyGetKey; exchange?: (form: URLSearchParams) => Promise<Response> } = {}) {
		this.settings = settings;
		this.keys = options.keys ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"),
			{ timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60_000 });
		this.exchange = options.exchange ?? (form => fetch("https://oauth2.googleapis.com/token", {
			method: "POST", body: form, signal: AbortSignal.timeout(15_000),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		}));
	}
	async start(redirectUri: string): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
		const state = randomToken(), nonce = randomToken(), verifier = randomToken();
		const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		for (const [key, value] of Object.entries({ client_id: this.settings.clientId, redirect_uri: redirectUri, response_type: "code",
			scope: "openid email", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
			login_hint: this.settings.email, prompt: "select_account" })) url.searchParams.set(key, value);
		return { url: url.href, state, nonce, verifier };
	}
	/** The Google account that completed sign-in: it must be the owner's, by verified email and pinned subject. */
	async finish(code: string, attempt: { nonce: string; verifier: string }, redirectUri: string): Promise<{ subject: string; email: string }> {
		const form = new URLSearchParams({ code, client_id: this.settings.clientId, client_secret: this.settings.clientSecret,
			redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: attempt.verifier });
		let response: Response;
		try { response = await this.exchange(form); } catch { throw new AccountError(503, "identity_verification_unavailable"); }
		const value = await response.json().catch(() => ({})) as { id_token?: unknown };
		if (!response.ok || typeof value.id_token !== "string") throw new AccountError(401, "sign_in_failed");
		let payload;
		try {
			({ payload } = await jwtVerify(value.id_token, this.keys, {
				issuer: GOOGLE_ISSUERS, audience: this.settings.clientId, algorithms: ["RS256"], clockTolerance: 30,
				requiredClaims: ["exp", "iat", "sub", "email", "nonce"],
			}));
		} catch (error) {
			if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) throw new AccountError(401, "invalid_identity_token");
			throw new AccountError(503, "identity_verification_unavailable");
		}
		if (payload.nonce !== attempt.nonce || payload.email_verified !== true || typeof payload.sub !== "string"
			|| typeof payload.email !== "string" || payload.email.toLowerCase() !== this.settings.email) {
			throw new AccountError(403, "workspace_access_denied");
		}
		return { subject: payload.sub, email: payload.email.toLowerCase() };
	}
}

/** Account authority signing material is never deployed to the routing broker. */
export class DeviceAuthority {
	private config: AccountConfiguration;
	private privateKey: CryptoKey;
	readonly publicKey: JWK;
	private constructor(config: AccountConfiguration, privateKey: CryptoKey, publicKey: JWK) {
		this.config = config; this.privateKey = privateKey; this.publicKey = publicKey;
	}
	static async open(config: AccountConfiguration, value: unknown): Promise<DeviceAuthority> {
		if (!value || typeof value !== "object") throw new Error("Account signing key is not configured.");
		const input = value as JWK;
		if (input.kty !== "EC" || input.crv !== "P-256" || typeof input.d !== "string") {
			throw new Error("Account signing key must be a private P-256 key.");
		}
		const privateKey = await importJWK(input, "ES256") as CryptoKey;
		const { key, thumbprint } = await deviceKey({ kty: input.kty, crv: input.crv, x: input.x, y: input.y });
		const publicKey: JWK = { ...key, kid: thumbprint };
		publicKey.alg = "ES256"; publicKey.use = "sig";
		return new DeviceAuthority(config, privateKey, publicKey);
	}
	async credential(device: WorkspaceDevice): Promise<{ token: string; expires: number }> {
		if (device.revoked !== undefined) throw new AccountError(403, "device_revoked");
		const now = Math.floor(Date.now() / 1000), expires = now + DEVICE_LIFETIME;
		const token = await new SignJWT({
			version: 2, wsp: workspaceIdentity(this.config),
			role: device.kind, cnf: { jwk: device.key },
		}).setProtectedHeader({ alg: "ES256", kid: this.publicKey.kid, typ: DEVICE_TOKEN_TYPE })
			.setIssuer(this.config.origin).setAudience(DEVICE_AUDIENCE).setSubject(device.id)
			.setIssuedAt(now).setNotBefore(now - 5).setExpirationTime(expires)
			.setJti(crypto.randomUUID()).sign(this.privateKey);
		return { token, expires };
	}
}

import {
	createRemoteJWKSet, errors, importJWK, jwtVerify, SignJWT,
	type JWK, type JWTVerifyGetKey,
} from "jose";
import {
	DEVICE_AUDIENCE, DEVICE_LIFETIME, DEVICE_TOKEN_TYPE, microsoftIssuer, deviceKey,
	type AccountConfiguration, type WorkspaceDevice,
} from "../shared/account.ts";

export class AccountError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export interface MicrosoftIdentity { objectId: string; tenantId: string; expires: number }

/** The resource accepts its delegated access token, never a Graph or ID token. */
export class MicrosoftAccess {
	private keys: JWTVerifyGetKey;
	private config: AccountConfiguration;
	constructor(config: AccountConfiguration, keys?: JWTVerifyGetKey) {
		this.config = config;
		this.keys = keys ?? createRemoteJWKSet(
			new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
			{ timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60_000 },
		);
	}
	async authenticate(authorization: string | undefined): Promise<MicrosoftIdentity> {
		const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
		if (!match || match[1].length > 24_000) throw new AccountError(401, "sign_in_required");
		let payload;
		try {
			({ payload } = await jwtVerify(match[1], this.keys, {
				issuer: microsoftIssuer(this.config), audience: this.config.clientId,
				algorithms: ["RS256"], clockTolerance: 30,
				requiredClaims: ["exp", "iat", "sub", "oid", "tid", "scp", "azp"],
			}));
		} catch (error) {
			if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
				throw new AccountError(401, "invalid_access_token");
			}
			throw new AccountError(503, "identity_verification_unavailable");
		}
		if (payload.tid !== this.config.tenantId || payload.oid !== this.config.ownerObjectId
			|| payload.azp !== this.config.clientId || typeof payload.scp !== "string"
			|| !payload.scp.split(" ").includes("Workspace.Access")) {
			throw new AccountError(403, "workspace_access_denied");
		}
		if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
			throw new AccountError(401, "access_token_expired");
		}
		return { tenantId: this.config.tenantId, objectId: this.config.ownerObjectId, expires: payload.exp };
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
	async credential(device: WorkspaceDevice, identity: MicrosoftIdentity): Promise<{ token: string; expires: number }> {
		if (device.revoked !== undefined) throw new AccountError(403, "device_revoked");
		if (identity.objectId !== this.config.ownerObjectId || identity.tenantId !== this.config.tenantId) {
			throw new AccountError(403, "workspace_access_denied");
		}
		const now = Math.floor(Date.now() / 1000);
		const expires = Math.min(now + DEVICE_LIFETIME, identity.expires);
		if (expires - now < 60) throw new AccountError(401, "refresh_access_token");
		const token = await new SignJWT({
			version: 1, tid: identity.tenantId, oid: identity.objectId,
			role: device.kind, cnf: { jwk: device.key },
		}).setProtectedHeader({ alg: "ES256", kid: this.publicKey.kid, typ: DEVICE_TOKEN_TYPE })
			.setIssuer(this.config.origin).setAudience(DEVICE_AUDIENCE).setSubject(device.id)
			.setIssuedAt(now).setNotBefore(now - 5).setExpirationTime(expires)
			.setJti(crypto.randomUUID()).sign(this.privateKey);
		return { token, expires };
	}
}

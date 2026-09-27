import { createRemoteJWKSet, importJWK, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
	DEVICE_AUDIENCE, DEVICE_LIFETIME, DEVICE_TOKEN_TYPE, deviceKey, identifier,
	type AccountConfiguration, type DeviceKey, type DeviceKind,
} from "./account.ts";

export interface DeviceCredential {
	id: string;
	kind: DeviceKind;
	key: DeviceKey;
	verificationKey: CryptoKey;
	thumbprint: string;
	expires: number;
}

/** Peers verify the configured account authority, not claims supplied by the broker. */
export class CredentialVerifier {
	private config: AccountConfiguration;
	private keys: JWTVerifyGetKey;
	constructor(config: AccountConfiguration, keys?: JWTVerifyGetKey) {
		this.config = config;
		this.keys = keys ?? createRemoteJWKSet(new URL("/.well-known/jwks.json", config.origin), {
			timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000,
		});
	}
	async verify(token: string, kind: DeviceKind, expectedId?: string): Promise<DeviceCredential> {
		if (typeof token !== "string" || token.length > 8000) throw new Error("Invalid device credential.");
		const { payload } = await jwtVerify(token, this.keys, {
			issuer: this.config.origin, audience: DEVICE_AUDIENCE, algorithms: ["ES256"],
			typ: DEVICE_TOKEN_TYPE, clockTolerance: 5,
			requiredClaims: ["exp", "iat", "nbf", "sub", "jti", "tid", "oid", "role", "cnf", "version"],
		});
		const now = Math.floor(Date.now() / 1000);
		if (payload.version !== 1 || payload.tid !== this.config.tenantId || payload.oid !== this.config.ownerObjectId
			|| payload.role !== kind || expectedId !== undefined && payload.sub !== expectedId
			|| typeof payload.exp !== "number" || typeof payload.iat !== "number"
			|| !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
			|| payload.exp <= now || payload.iat > now + 5 || payload.exp - payload.iat > DEVICE_LIFETIME
			|| !payload.cnf || typeof payload.cnf !== "object") {
			throw new Error("Device is not authorized for this account connection.");
		}
		const id = identifier(payload.sub);
		const { key, thumbprint } = await deviceKey((payload.cnf as { jwk?: unknown }).jwk);
		const verificationKey = await importJWK(key, "ES256") as CryptoKey;
		return { id, kind, key, thumbprint, verificationKey, expires: payload.exp };
	}
}

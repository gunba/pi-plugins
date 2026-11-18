import { SignJWT, importJWK, jwtVerify } from "jose";
import type { DeviceKey } from "./account.ts";
import { accountNow, measureAccountClock } from "./account-clock.ts";
import { base64 } from "./secure-channel.ts";

const encoder = new TextEncoder();
const TYPE = "pi-desk-account-proof+jwt";
const LIFETIME = 60;
const digest = async (value: string) => base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
export interface AccountRequest {
	id: string; method: string; url: string; body: string; accessToken: string;
}
export async function accountProof(request: AccountRequest, key: CryptoKey): Promise<string> {
	const now = Math.floor(accountNow() / 1000);
	return new SignJWT({ device: request.id, htm: request.method, htu: request.url,
		bh: await digest(request.body), ath: await digest(request.accessToken) })
		.setProtectedHeader({ alg: "ES256", typ: TYPE }).setIssuedAt(now).setExpirationTime(now + LIFETIME)
		.setJti(crypto.randomUUID()).sign(key);
}

/** What `sendWithProof` needs of a reply: its status, the service's error code if any, and its Date header. */
export interface ProvenReply { status: number; error?: string; date?: string | null }
/**
 * Sends a request signed by this device and measures this device's clock against the reply. When the service refused
 * the proof and the measurement moved the clock, the request is signed again, by the corrected clock, and sent once
 * more.
 */
export async function sendWithProof<R extends ProvenReply>(request: AccountRequest, key: CryptoKey,
	send: (proof: string) => Promise<R>): Promise<R> {
	const reply = await send(await accountProof(request, key));
	const moved = measureAccountClock(reply.date);
	return moved && reply.status === 403 && reply.error === "invalid_device_proof" ? send(await accountProof(request, key)) : reply;
}

/** Body/token binding and a bounded, process-wide replay cache for device operations. */
export class AccountProofs {
	private used = new Map<string, number>();
	async verify(proof: unknown, request: AccountRequest, publicKey: DeviceKey): Promise<void> {
		if (typeof proof !== "string" || proof.length > 4000) throw new Error("Device proof required.");
		const key = await importJWK(publicKey, "ES256");
		const { payload } = await jwtVerify(proof, key, {
			algorithms: ["ES256"], typ: TYPE, clockTolerance: 5,
			requiredClaims: ["iat", "exp", "jti", "device", "htm", "htu", "bh", "ath"],
		});
		const now = Math.floor(Date.now() / 1000);
		if (payload.device !== request.id || payload.htm !== request.method || payload.htu !== request.url
			|| payload.bh !== await digest(request.body) || payload.ath !== await digest(request.accessToken)
			|| typeof payload.iat !== "number" || typeof payload.exp !== "number"
			|| !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
			|| payload.iat > now + 5 || payload.iat < now - LIFETIME || payload.exp <= now
			|| payload.exp > payload.iat + LIFETIME || typeof payload.jti !== "string" || payload.jti.length > 64) {
			throw new Error("Invalid device proof.");
		}
		for (const [id, expires] of this.used) if (expires <= now) this.used.delete(id);
		const id = `${request.id}:${payload.jti}`;
		if (this.used.has(id) || this.used.size >= 10_000) throw new Error("Device proof replay or capacity limit.");
		this.used.set(id, payload.exp);
	}
}

import { createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { AccountError } from "./identity.ts";

/** A browser's push subscription (PushSubscription.toJSON()). */
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
/** What the service worker shows (public/sw.js). `session` is the app's conversation key; `answers` maps action ids to answers. */
export interface PushNotice {
	title: string; body?: string; tag: string; session?: string; urgency?: "high" | "normal";
	actions?: { action: string; title: string }[];
	answers?: Record<string, { interaction: string; answer: unknown }>;
}
interface PushState { version: 1; vapid: { publicKey: string; privateKey: JsonWebKey }; subscriptions: Record<string, PushSubscriptionData & { created: number }> }

const b64 = (value: Buffer | Uint8Array) => Buffer.from(value).toString("base64url");
const MAX_NOTICE = 3000;

function subscription(value: unknown): PushSubscriptionData {
	const item = value as PushSubscriptionData;
	let url: URL;
	try { url = new URL(item?.endpoint); } catch { throw new AccountError(400, "invalid_push_subscription"); }
	const p256dh = Buffer.from(String(item.keys?.p256dh ?? ""), "base64url"), auth = Buffer.from(String(item.keys?.auth ?? ""), "base64url");
	// Push services are public HTTPS hosts; an address or local name would make this service a proxy into its own network.
	if (url.protocol !== "https:" || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") || url.href.length > 1000
		|| p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new AccountError(400, "invalid_push_subscription");
	return { endpoint: url.href, keys: { p256dh: b64(p256dh), auth: b64(auth) } };
}

/** RFC 8291 message encryption (aes128gcm, one record) for a subscription's keys. */
export function encryptPush(payload: Buffer, keys: PushSubscriptionData["keys"]): Buffer {
	const client = Buffer.from(keys.p256dh, "base64url"), secret = Buffer.from(keys.auth, "base64url");
	const ecdh = createECDH("prime256v1"), server = ecdh.generateKeys(), shared = ecdh.computeSecret(client);
	const ikm = Buffer.from(hkdfSync("sha256", shared, secret, Buffer.concat([Buffer.from("WebPush: info\0"), client, server]), 32));
	const salt = randomBytes(16);
	const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const cipher = createCipheriv("aes-128-gcm", key, nonce);
	const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = server.length;
	return Buffer.concat([header, server, body]);
}

/**
 * Notifications to the owner's browsers through their push services (Web Push with VAPID): a browser registers its
 * subscription, and computers send notices, which reach every registered browser. One key pair for the whole
 * workspace, because a browser's subscription is bound to the key it subscribed with.
 */
export class PushService {
	private saving: Promise<void> = Promise.resolve();
	private file: string; private state: PushState; private key: KeyObject; private subject: string;
	private constructor(file: string, state: PushState, key: KeyObject, subject: string) { this.file = file; this.state = state; this.key = key; this.subject = subject; }

	static async open(directory: string, origin: string): Promise<PushService> {
		const file = join(directory, "push.json");
		let state: PushState;
		try { state = JSON.parse(await readFile(file, "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the push settings.");
			const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
			const jwk = pair.publicKey.export({ format: "jwk" });
			const publicKey = b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]));
			state = { version: 1, vapid: { publicKey, privateKey: pair.privateKey.export({ format: "jwk" }) }, subscriptions: {} };
			await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); await rename(`${file}.tmp`, file);
		}
		if (state?.version !== 1 || typeof state.vapid?.publicKey !== "string" || !state.subscriptions) throw new Error("Invalid push settings.");
		return new PushService(file, state, createPrivateKey({ key: state.vapid.privateKey as import("node:crypto").JsonWebKey, format: "jwk" }), origin);
	}
	get publicKey(): string { return this.state.vapid.publicKey; }
	subscribed(device: string): boolean { return !!this.state.subscriptions[device]; }

	async subscribe(device: string, value: unknown): Promise<boolean> {
		if (value === null) delete this.state.subscriptions[device];
		else this.state.subscriptions[device] = { ...subscription(value), created: Date.now() };
		await this.save();
		return value !== null;
	}
	/** Sends to each listed browser that has a subscription; ones their push service no longer knows are forgotten. */
	async send(devices: readonly string[], notice: PushNotice): Promise<number> {
		const payload = Buffer.from(JSON.stringify(notice));
		if (payload.length > MAX_NOTICE) throw new AccountError(400, "notice_too_large");
		let sent = 0, forgotten = false;
		await Promise.all(devices.map(async device => {
			const target = this.state.subscriptions[device];
			if (!target) return;
			const status = await this.post(target, payload, notice).catch(() => 0);
			if (status === 404 || status === 410) { delete this.state.subscriptions[device]; forgotten = true; }
			else if (status >= 200 && status < 300) sent++;
		}));
		if (forgotten) await this.save();
		return sent;
	}
	forget(devices: readonly string[]): Promise<void> | void {
		const known = devices.filter(device => this.state.subscriptions[device]);
		if (!known.length) return;
		for (const device of known) delete this.state.subscriptions[device];
		return this.save();
	}

	private async post(target: PushSubscriptionData, payload: Buffer, notice: PushNotice): Promise<number> {
		const endpoint = new URL(target.endpoint);
		const response = await fetch(endpoint, {
			method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body: new Uint8Array(encryptPush(payload, target.keys)),
			headers: {
				Authorization: `vapid t=${this.token(endpoint.origin)}, k=${this.publicKey}`,
				"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
				TTL: String(notice.urgency === "high" ? 7 * 86_400 : 86_400), Urgency: notice.urgency ?? "normal",
				// A newer notice for the same thing replaces one the phone has not received yet.
				Topic: createHash("sha256").update(notice.tag).digest("base64url").slice(0, 32),
			},
		});
		await response.arrayBuffer().catch(() => undefined);
		return response.status;
	}
	/** RFC 8292 VAPID token for one push service. */
	private token(audience: string): string {
		const part = (value: object) => b64(Buffer.from(JSON.stringify(value)));
		const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject })}`;
		return `${input}.${b64(sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" }))}`;
	}
	/** Writes one at a time, each the state as it is when its turn comes. */
	private save(): Promise<void> {
		const write = this.saving.catch(() => {}).then(async () => {
			await writeFile(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 }); await rename(`${this.file}.tmp`, this.file);
		});
		this.saving = write; return write;
	}
}

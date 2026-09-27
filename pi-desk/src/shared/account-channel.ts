import { compactVerify, CompactSign } from "jose";
import { deviceKey, type DeviceKey } from "./account.ts";
import { CredentialVerifier, type DeviceCredential } from "./device-credential.ts";
import { API_VERSION } from "./release.ts";
import { base64, newSecret, PROTOCOL_VERSION, SecureChannel, validId, validSecret } from "./secure-channel.ts";

export type ProofPurpose = "pi-desk-client-hello+jws" | "pi-desk-host-hello+jws" | "pi-desk-host-admission+jws";
export interface ChannelIdentity {
	certificate(): Promise<string>;
	signProof(payload: Uint8Array<ArrayBuffer>, purpose: ProofPurpose): Promise<string>;
}
export interface ChannelWire { type: "offer" | "accept"; credential: string; proof: string }
export interface ChannelHandlers {
	output: (wire: string) => void | Promise<void>;
	input: (message: unknown) => void;
	failed: (error: Error) => void;
}
export interface ChannelSession { channel: SecureChannel; peer: DeviceCredential; ownExpires: number }
interface Hello {
	protocol: number; api: number; host: string; nonce: string; key: DeviceKey; credential: string;
	offer?: string;
}
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
const digest = async (value: unknown) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value)));

export function signChannelProof(payload: Uint8Array<ArrayBuffer>, purpose: ProofPurpose, key: CryptoKey): Promise<string> {
	return new CompactSign(payload).setProtectedHeader({ alg: "ES256", typ: purpose }).sign(key);
}
function wire(value: unknown, type: ChannelWire["type"]): ChannelWire {
	if (!value || typeof value !== "object") throw new Error("Invalid channel handshake.");
	const input = value as ChannelWire;
	if (input.type !== type || typeof input.credential !== "string" || input.credential.length > 8000
		|| typeof input.proof !== "string" || input.proof.length > 4000) throw new Error("Invalid channel handshake.");
	return { type, credential: input.credential, proof: input.proof };
}
async function proof(value: string, credential: DeviceCredential, purpose: ProofPurpose): Promise<Record<string, unknown>> {
	if (value.length > 4000) throw new Error("Invalid channel proof.");
	const result = await compactVerify(value, credential.verificationKey, { algorithms: ["ES256"] });
	if (result.protectedHeader.typ !== purpose) throw new Error("Incorrect proof purpose.");
	const payload = JSON.parse(decoder.decode(result.payload));
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid channel proof.");
	return payload as Record<string, unknown>;
}
async function hello(message: ChannelWire, credential: DeviceCredential, purpose: ProofPurpose, host: string): Promise<Hello> {
	const data = await proof(message.proof, credential, purpose);
	if (data.protocol !== PROTOCOL_VERSION || data.api !== API_VERSION || data.host !== host || !validSecret(data.nonce)
		|| data.credential !== base64(await digest(message.credential))) throw new Error("Channel context does not match.");
	const key = (await deviceKey(data.key)).key;
	return { protocol: PROTOCOL_VERSION, api: API_VERSION, host, nonce: data.nonce, key, credential: data.credential as string,
		...(typeof data.offer === "string" ? { offer: data.offer } : {}) };
}
async function ephemeral(): Promise<{ privateKey: CryptoKey; publicKey: DeviceKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	return { privateKey: pair.privateKey, publicKey: (await deviceKey(await crypto.subtle.exportKey("jwk", pair.publicKey))).key };
}
async function channel(privateKey: CryptoKey, remote: DeviceKey, offer: ChannelWire, accept: ChannelWire,
	client: Hello, host: Hello, device: string, role: "host" | "client", handlers: ChannelHandlers): Promise<SecureChannel> {
	const publicKey = await crypto.subtle.importKey("jwk", remote, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
	let material: CryptoKey;
	try { material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]); }
	finally { shared.fill(0); }
	const root = new Uint8Array(await crypto.subtle.deriveBits({
		name: "HKDF", hash: "SHA-256", salt: await digest([offer, accept]),
		info: bytes(["pi-desk-account-channel", PROTOCOL_VERSION]),
	}, material, 256));
	try {
		return await SecureChannel.create({
			secret: base64(root), clientNonce: client.nonce, challenge: host.nonce, host: host.host, device, role,
		}, handlers.output, handlers.input, handlers.failed);
	} finally { root.fill(0); }
}

/** One fresh ephemeral key per connection; a reply is accepted at most once. */
export class ClientHandshake {
	readonly offer: ChannelWire;
	private privateKey?: CryptoKey;
	private own: DeviceCredential;
	private data: Hello;
	private verifier: CredentialVerifier;
	private constructor(offer: ChannelWire, key: CryptoKey, own: DeviceCredential, data: Hello, verifier: CredentialVerifier) {
		this.offer = offer; this.privateKey = key; this.own = own; this.data = data; this.verifier = verifier;
	}
	static async create(host: string, identity: ChannelIdentity, verifier: CredentialVerifier): Promise<ClientHandshake> {
		if (!validId(host)) throw new Error("Invalid target computer.");
		const credential = await identity.certificate(), own = await verifier.verify(credential, "browser");
		const key = await ephemeral();
		const data: Hello = { protocol: PROTOCOL_VERSION, api: API_VERSION, host, nonce: newSecret(),
			key: key.publicKey, credential: base64(await digest(credential)) };
		const offer: ChannelWire = { type: "offer", credential,
			proof: await identity.signProof(bytes(data), "pi-desk-client-hello+jws") };
		return new ClientHandshake(offer, key.privateKey, own, data, verifier);
	}
	async finish(value: unknown, handlers: ChannelHandlers): Promise<ChannelSession> {
		const key = this.privateKey; this.privateKey = undefined;
		if (!key) throw new Error("Channel handshake is no longer available.");
		const accept = wire(value, "accept"), peer = await this.verifier.verify(accept.credential, "host", this.data.host);
		const data = await hello(accept, peer, "pi-desk-host-hello+jws", this.data.host);
		if (data.offer !== base64(await digest(this.offer)) || Math.min(this.own.expires, peer.expires) <= Date.now() / 1000) {
			throw new Error("Host response does not authorize this handshake.");
		}
		return { channel: await channel(key, data.key, this.offer, accept, this.data, data, this.own.id, "client", handlers),
			peer, ownExpires: this.own.expires };
	}
	close(): void { this.privateKey = undefined; }
}

export async function acceptChannelOffer(value: unknown, host: string, identity: ChannelIdentity, verifier: CredentialVerifier,
	authorize: (peer: DeviceCredential) => Promise<void>, handlers: ChannelHandlers): Promise<ChannelSession & { accept: ChannelWire }> {
	const offer = wire(value, "offer"), peer = await verifier.verify(offer.credential, "browser");
	const client = await hello(offer, peer, "pi-desk-client-hello+jws", host);
	await authorize(peer);
	const credential = await identity.certificate(), own = await verifier.verify(credential, "host", host);
	const key = await ephemeral();
	const data: Hello = { protocol: PROTOCOL_VERSION, api: API_VERSION, host, nonce: newSecret(),
		key: key.publicKey, credential: base64(await digest(credential)), offer: base64(await digest(offer)) };
	const accept: ChannelWire = { type: "accept", credential,
		proof: await identity.signProof(bytes(data), "pi-desk-host-hello+jws") };
	if (Math.min(own.expires, peer.expires) <= Date.now() / 1000) throw new Error("Channel authorization expired.");
	return { channel: await channel(key.privateKey, client.key, offer, accept, client, data, peer.id, "host", handlers),
		peer, ownExpires: own.expires, accept };
}

export async function hostAdmission(identity: ChannelIdentity, origin: string, nonce: string): Promise<{ credential: string; proof: string }> {
	if (!validSecret(nonce)) throw new Error("Invalid broker challenge.");
	const credential = await identity.certificate();
	return { credential, proof: await identity.signProof(bytes({
		protocol: PROTOCOL_VERSION, origin, nonce, credential: base64(await digest(credential)),
	}), "pi-desk-host-admission+jws") };
}
export async function verifyHostAdmission(value: unknown, origin: string, nonce: string, host: string,
	verifier: CredentialVerifier): Promise<DeviceCredential> {
	if (!value || typeof value !== "object" || !validSecret(nonce)) throw new Error("Invalid host admission.");
	const input = value as { credential: string; proof: string };
	if (typeof input.credential !== "string" || typeof input.proof !== "string") throw new Error("Invalid host admission.");
	const peer = await verifier.verify(input.credential, "host", host);
	const data = await proof(input.proof, peer, "pi-desk-host-admission+jws");
	if (data.protocol !== PROTOCOL_VERSION || data.origin !== origin || data.nonce !== nonce
		|| data.credential !== base64(await digest(input.credential))) throw new Error("Invalid host admission proof.");
	return peer;
}

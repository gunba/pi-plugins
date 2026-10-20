const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MESSAGE = 32 * 1024 * 1024;
const CHUNK = 48 * 1024;
export const MAX_WIRE = 128 * 1024;
export const PROTOCOL_VERSION = 3;
/**
 * "compact": each message is compressed before it is encrypted, and its chunks carry a small binary header instead of
 * base64 inside JSON. Encrypted data does not compress, so this is the only place it can be done: the JSON a computer
 * sends compresses about 3.5 times, and the old format carried it base64-encoded twice (1.8 times its size). Used only
 * when both ends offer it, so a computer still running an older Desk keeps the old format.
 */
export const CHANNEL_FEATURES: readonly string[] = typeof CompressionStream === "function" && typeof DecompressionStream === "function" ? ["compact"] : [];
const COMPACT_CHUNK = 64 * 1024, HEADER = 21;
/** A message is abandoned only after this long without any of its chunks arriving: a slow link is not a failure. */
const ASSEMBLY_IDLE_MS = 60_000;

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}
/** Decompresses, refusing more than `limit` bytes of output (a small message must not expand without bound). */
async function inflate(data: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
	const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(), parts: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > limit) { await reader.cancel(); throw new Error("Encrypted message is too large."); }
		parts.push(value);
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) { result.set(part, offset); offset += part.length; }
	return result;
}
const uuidBytes = (id: string) => Uint8Array.from(id.replaceAll("-", "").match(/../g)!, pair => parseInt(pair, 16));
const uuidText = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
export interface Handshake {
	secret: string; challenge: string; clientNonce: string; host: string; device: string; role: "host" | "client";
}

export function base64(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unbase64(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[\w-]*$/.test(text)) throw new Error("Invalid encoded data.");
	return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}
export const newSecret = () => base64(crypto.getRandomValues(new Uint8Array(32)));
export const validSecret = (value: unknown): value is string => typeof value === "string" && /^[\w-]{43}$/.test(value);
export const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

function nonce(sequence: number): Uint8Array<ArrayBuffer> {
	const iv = new Uint8Array(12);
	new DataView(iv.buffer).setBigUint64(4, BigInt(sequence));
	return iv;
}

/** Both endpoints contribute fresh nonces; direction keys and frame counters are independent. */
export class SecureChannel {
	private outgoing = 0;
	private incoming = 0;
	private sendTail = Promise.resolve();
	private receiveTail = Promise.resolve();
	private queued = 0;
	private closed = false;
	private assembly?: { id: string; next: number; parts: Uint8Array<ArrayBuffer>[]; length: number };
	private assemblyTimeout?: ReturnType<typeof setTimeout>;
	private readonly compact: boolean;
	private readonly additional: Uint8Array<ArrayBuffer>;
	private sendKey: CryptoKey;
	private receiveKey: CryptoKey;
	private output: (wire: string) => void | Promise<void>;
	private input: (message: unknown) => void;
	private failed: (error: Error) => void;

	private constructor(keys: { send: CryptoKey; receive: CryptoKey }, output: (wire: string) => void | Promise<void>,
		input: (message: unknown) => void, failed: (error: Error) => void, compact: boolean) {
		this.sendKey = keys.send; this.receiveKey = keys.receive;
		this.output = output; this.input = input; this.failed = failed;
		this.compact = compact;
		// The format is part of what is authenticated: a frame of one format is never read as the other.
		this.additional = encoder.encode(`pi-desk-v${PROTOCOL_VERSION}${compact ? "-compact" : ""}`);
	}

	static async create({ secret, challenge, clientNonce, host, device, role }: Handshake,
		output: (wire: string) => void | Promise<void>, input: (message: unknown) => void, failed: (error: Error) => void,
		options: { compact?: boolean } = {}): Promise<SecureChannel> {
		if (!validSecret(secret) || !validSecret(challenge) || !validSecret(clientNonce) || !validId(host) || !validId(device)) throw new Error("Invalid channel identity.");
		const material = await crypto.subtle.importKey("raw", unbase64(secret), "HKDF", false, ["deriveKey"]);
		const salt = new Uint8Array(64);
		salt.set(unbase64(challenge));
		salt.set(unbase64(clientNonce), 32);
		const derive = (direction: string) => crypto.subtle.deriveKey({
			name: "HKDF", hash: "SHA-256", salt,
			info: encoder.encode(JSON.stringify(["pi-desk", PROTOCOL_VERSION, host, device, direction])),
		}, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const [up, down] = await Promise.all([derive("client-to-host"), derive("host-to-client")]);
		return new SecureChannel({ send: role === "client" ? up : down, receive: role === "client" ? down : up }, output, input, failed, !!options.compact);
	}

	send(message: unknown): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Encrypted connection is closed."));
		const bytes = encoder.encode(JSON.stringify(message));
		if (bytes.length > MAX_MESSAGE || this.queued + bytes.length > MAX_MESSAGE) {
			this.fail(new Error("Encrypted connection queue is full."));
			return Promise.reject(new Error("Encrypted connection queue is full."));
		}
		this.queued += bytes.length;
		const operation = this.sendTail.then(async () => {
			const id = crypto.randomUUID();
			const payload = this.compact ? await deflate(bytes) : bytes, size = this.compact ? COMPACT_CHUNK : CHUNK;
			for (let offset = 0, part = 0; offset < payload.length || part === 0; offset += size, part++) {
				if (this.closed) throw new Error("Encrypted connection is closed.");
				if (!Number.isSafeInteger(this.outgoing)) throw new Error("Channel counter exhausted.");
				const sequence = this.outgoing++, last = offset + size >= payload.length, data = payload.subarray(offset, offset + size);
				let chunk: Uint8Array<ArrayBuffer>;
				if (this.compact) {
					// id (16 bytes), part (4), last (1), then the compressed bytes.
					chunk = new Uint8Array(HEADER + data.length);
					chunk.set(uuidBytes(id)); new DataView(chunk.buffer).setUint32(16, part); chunk[20] = last ? 1 : 0; chunk.set(data, HEADER);
				} else chunk = encoder.encode(JSON.stringify({ id, part, last, data: base64(data) }));
				const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(sequence),
					additionalData: this.additional }, this.sendKey, chunk);
				if (this.closed) throw new Error("Encrypted connection is closed.");
				await this.output(JSON.stringify({ sequence, data: base64(new Uint8Array(ciphertext)) }));
			}
		});
		this.sendTail = operation.catch(error => this.fail(error)).finally(() => { this.queued -= bytes.length; });
		return operation;
	}

	receive(wire: string): void {
		if (this.closed) return;
		if (wire.length > MAX_WIRE) { this.fail(new Error("Encrypted frame is too large.")); return; }
		// Account for queued decryptions as well as the message being assembled.
		this.queued += wire.length;
		if (this.queued > MAX_MESSAGE) { this.fail(new Error("Encrypted connection queue is full.")); return; }
		this.receiveTail = this.receiveTail.then(async () => {
			if (this.closed) return;
			const frame = JSON.parse(wire);
			if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== this.incoming || typeof frame.data !== "string") {
				throw new Error("Unexpected encrypted frame counter.");
			}
			const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(frame.sequence),
				additionalData: this.additional }, this.receiveKey, unbase64(frame.data)));
			if (this.closed) return;
			this.incoming++;
			let chunk: { id: string; part: number; last: boolean; data: Uint8Array<ArrayBuffer> };
			if (this.compact) {
				if (clear.length < HEADER || clear[20]! > 1) throw new Error("Invalid encrypted message chunk.");
				chunk = { id: uuidText(clear.subarray(0, 16)), part: new DataView(clear.buffer).getUint32(16), last: clear[20] === 1, data: clear.slice(HEADER) };
			} else {
				const value = JSON.parse(decoder.decode(clear));
				if (!validId(value.id) || !Number.isSafeInteger(value.part) || typeof value.last !== "boolean" || typeof value.data !== "string") {
					throw new Error("Invalid encrypted message chunk.");
				}
				chunk = { ...value, data: unbase64(value.data) };
			}
			if (!this.assembly) {
				if (chunk.part !== 0) throw new Error("Missing message beginning.");
				this.assembly = { id: chunk.id, next: 0, parts: [], length: 0 };
			}
			// Restarted with every chunk: a long message on a slow link keeps arriving, it has not failed.
			clearTimeout(this.assemblyTimeout);
			this.assemblyTimeout = setTimeout(() => this.fail(new Error("Incomplete encrypted message.")), ASSEMBLY_IDLE_MS);
			const assembly = this.assembly;
			if (chunk.id !== assembly.id || chunk.part !== assembly.next++) throw new Error("Out-of-order message chunk.");
			const data = chunk.data;
			assembly.length += data.length;
			if (data.length > (this.compact ? COMPACT_CHUNK : CHUNK) || assembly.length > MAX_MESSAGE) throw new Error("Encrypted message is too large.");
			assembly.parts.push(data);
			if (chunk.last) {
				clearTimeout(this.assemblyTimeout);
				let bytes = new Uint8Array(assembly.length);
				let offset = 0;
				for (const part of assembly.parts) { bytes.set(part, offset); offset += part.length; }
				this.assembly = undefined;
				if (this.compact) bytes = await inflate(bytes, MAX_MESSAGE);
				if (this.closed) return;
				this.input(JSON.parse(decoder.decode(bytes)));
			}
		}).catch(error => this.fail(error)).finally(() => { this.queued -= wire.length; });
	}

	private fail(error: unknown): void {
		if (this.closed) return;
		this.close();
		this.failed(error instanceof Error ? error : new Error(String(error)));
	}
	close(): void { this.closed = true; clearTimeout(this.assemblyTimeout); this.assembly = undefined; }
}

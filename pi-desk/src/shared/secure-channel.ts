const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MESSAGE = 32 * 1024 * 1024;
const CHUNK = 48 * 1024;
export const MAX_WIRE = 128 * 1024;
export const PROTOCOL_VERSION = 2;
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
	private sendKey: CryptoKey;
	private receiveKey: CryptoKey;
	private output: (wire: string) => void | Promise<void>;
	private input: (message: unknown) => void;
	private failed: (error: Error) => void;

	private constructor(keys: { send: CryptoKey; receive: CryptoKey }, output: (wire: string) => void | Promise<void>,
		input: (message: unknown) => void, failed: (error: Error) => void) {
		this.sendKey = keys.send; this.receiveKey = keys.receive;
		this.output = output; this.input = input; this.failed = failed;
	}

	static async create({ secret, challenge, clientNonce, host, device, role }: Handshake,
		output: (wire: string) => void | Promise<void>, input: (message: unknown) => void, failed: (error: Error) => void): Promise<SecureChannel> {
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
		return new SecureChannel({ send: role === "client" ? up : down, receive: role === "client" ? down : up }, output, input, failed);
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
			for (let offset = 0, part = 0; offset < bytes.length; offset += CHUNK, part++) {
				if (this.closed) throw new Error("Encrypted connection is closed.");
				if (!Number.isSafeInteger(this.outgoing)) throw new Error("Channel counter exhausted.");
				const sequence = this.outgoing++;
				const chunk = encoder.encode(JSON.stringify({
					id, part, last: offset + CHUNK >= bytes.length, data: base64(bytes.subarray(offset, offset + CHUNK)),
				}));
				const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(sequence),
					additionalData: encoder.encode(`pi-desk-v${PROTOCOL_VERSION}`) }, this.sendKey, chunk);
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
			const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(frame.sequence),
				additionalData: encoder.encode(`pi-desk-v${PROTOCOL_VERSION}`) }, this.receiveKey, unbase64(frame.data));
			if (this.closed) return;
			this.incoming++;
			const chunk = JSON.parse(decoder.decode(clear));
			if (!validId(chunk.id) || !Number.isSafeInteger(chunk.part) || typeof chunk.last !== "boolean" || typeof chunk.data !== "string") {
				throw new Error("Invalid encrypted message chunk.");
			}
			if (!this.assembly) {
				if (chunk.part !== 0) throw new Error("Missing message beginning.");
				this.assembly = { id: chunk.id, next: 0, parts: [], length: 0 };
				this.assemblyTimeout = setTimeout(() => this.fail(new Error("Incomplete encrypted message.")), 30_000);
			}
			const assembly = this.assembly;
			if (chunk.id !== assembly.id || chunk.part !== assembly.next++) throw new Error("Out-of-order message chunk.");
			const data = unbase64(chunk.data);
			assembly.length += data.length;
			if (data.length > CHUNK || assembly.length > MAX_MESSAGE) throw new Error("Encrypted message is too large.");
			assembly.parts.push(data);
			if (chunk.last) {
				clearTimeout(this.assemblyTimeout);
				const bytes = new Uint8Array(assembly.length);
				let offset = 0;
				for (const part of assembly.parts) { bytes.set(part, offset); offset += part.length; }
				this.assembly = undefined;
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

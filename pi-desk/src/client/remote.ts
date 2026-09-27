import { SecureChannel, newSecret, validId, validSecret, MAX_WIRE, PROTOCOL_VERSION } from "../shared/secure-channel.ts";
import { socketUrl, type ApiRequest, type ApiResponse } from "../shared/relay-protocol.ts";
import type { HostEvent } from "../shared/protocol.ts";
import { API_VERSION, apiMatches, upgradeMessage } from "../shared/release.ts";

export interface RemoteCredential { host: string; device: string; key: string; invitation?: string; label: string }
export class RemoteError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
interface Pending { resolve: (value: ApiResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class RemoteClient {
	private credential: RemoteCredential;
	private origin: string;
	private save: (credential: RemoteCredential) => void;
	private socket?: WebSocket;
	private channel?: SecureChannel;
	private pending = new Map<string, Pending>();
	private handlers = new Set<(event: HostEvent, sequence: number) => void>();
	private connections = new Set<(online: boolean) => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private deadline?: ReturnType<typeof setTimeout>;
	private closed = false;
	private failure?: RemoteError;
	private online = false;
	private backoff = 1000;
	private initial: Promise<void>;
	private resolve!: () => void;
	private reject!: (error: Error) => void;
	private received = 0;
	private acknowledged = 0;
	private ackScheduled = false;
	private onlineListener = () => { clearTimeout(this.timer); this.connect(); };
	private visibilityListener = () => document.hidden ? this.disconnect("App paused; delivery of pending commands is uncertain.") : this.connect();
	private pageHideListener = () => this.disconnect("App closed; delivery of pending commands is uncertain.");

	constructor(origin: string, credential: RemoteCredential, save: (credential: RemoteCredential) => void) {
		this.origin = origin; this.credential = credential; this.save = save;
		this.initial = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
		void this.initial.catch(() => {});
		addEventListener("online", this.onlineListener);
		document.addEventListener("visibilitychange", this.visibilityListener);
		addEventListener("pagehide", this.pageHideListener);
		addEventListener("pageshow", this.onlineListener);
		this.connect();
	}
	ready(): Promise<void> { return this.initial; }
	get connected(): boolean { return this.online; }
	get error(): string | undefined { return this.failure?.message; }
	get errorStatus(): number | undefined { return this.failure?.status; }
	private setOnline(value: boolean): void { this.online = value; for (const handler of this.connections) handler(value); }
	private connect(): void {
		if (this.closed || this.failure || document.hidden) return;
		if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
		this.channel?.close(); this.channel = undefined;
		this.received = 0; this.acknowledged = 0;
		const clientNonce = newSecret();
		const socket = new WebSocket(socketUrl(this.origin, "/connect", this.credential.host));
		this.socket = socket;
		let processing = Promise.resolve();
		let handshakes = 0;
		this.deadline = setTimeout(() => socket.close(), 15_000);
		socket.onopen = () => socket.send(JSON.stringify({ type: "identify", protocol: PROTOCOL_VERSION, api: API_VERSION, nonce: clientNonce, device: this.credential.device }));
		socket.onmessage = event => {
			if (this.socket !== socket || this.closed) return;
			if (typeof event.data !== "string" || event.data.length > MAX_WIRE) { socket.close(4002); return; }
			if (this.channel) { this.channel.receive(event.data); return; }
			if (++handshakes > 4) { socket.close(4002); return; }
			processing = processing.then(async () => {
				if (this.socket !== socket || this.closed) return;
				if (this.channel) { this.channel.receive(event.data); return; }
				const message = JSON.parse(event.data);
				if (message.type === "denied") { this.deny(); return; }
				if (message.type === "upgrade-required") { this.deny(426, upgradeMessage("This computer", message.api)); return; }
				if (message.type !== "challenge" || !validSecret(message.nonce) || typeof message.pairing !== "boolean") throw new Error("Invalid host challenge.");
				if (message.protocol !== PROTOCOL_VERSION) { this.deny(426, "Update Pi Desk on the computer and reload this app."); return; }
				if (!apiMatches(message.api)) { this.deny(426, upgradeMessage("This computer", message.api)); return; }
				const key = message.pairing ? this.credential.invitation : this.credential.key;
				if (!key) { this.deny(); return; }
				const channel = await SecureChannel.create({ secret: key, challenge: message.nonce, clientNonce,
					host: this.credential.host, device: this.credential.device, role: "client" },
					wire => {
						if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error("Connection is unavailable.");
						socket.send(wire);
					},
					payload => { if (this.socket === socket) this.message(payload); }, () => socket.close(4002, "Encrypted channel rejected"));
				if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) { channel.close(); return; }
				this.channel = channel;
				await channel.send({ type: "hello", api: API_VERSION, label: this.credential.label, ...(message.pairing ? { key: this.credential.key } : {}) });
			}).catch(() => socket.close(4002, "Invalid host response")).finally(() => { handshakes--; });
		};
		socket.onerror = () => {};
		socket.onclose = event => {
			if (this.socket !== socket) return;
			clearTimeout(this.deadline); this.channel?.close(); this.channel = undefined;
			if (event.code === 4001) this.failure ??= new RemoteError(401, "This device is no longer paired.");
			if (event.code === 4003) this.failure ??= new RemoteError(426, "Update Pi Desk on the computer and reload this app.");
			this.setOnline(false);
			this.rejectPending("Connection lost; delivery is uncertain. Check the conversation before sending it again.");
			if (event.code === 4001) this.deny();
			if (this.closed || this.failure) { if (this.failure) this.reject(this.failure); return; }
			this.reject(new RemoteError(503, "The host is offline or unreachable. Keep its connector running; this page will reconnect."));
			this.timer = setTimeout(() => this.connect(), this.backoff + Math.random() * 500);
			this.backoff = Math.min(30_000, this.backoff * 2);
		};
	}
	private deny(status = 401, message = "This device invitation expired, was already claimed, or was revoked. Open a new invitation."): void {
		this.failure = new RemoteError(status, message);
		this.reject(this.failure);
		this.socket?.close();
		this.setOnline(false);
	}
	private message(raw: unknown): void {
		if (!raw || typeof raw !== "object") throw new Error("Invalid host response.");
		const message = raw as Record<string, unknown>;
		if (message.type === "upgrade-required") { this.deny(426, upgradeMessage("This computer", message.api)); return; }
		if (!this.online) {
			if (message.type !== "ready") throw new Error("Expected authenticated host acknowledgement.");
			if (!apiMatches((message.release as { api?: unknown } | undefined)?.api)) {
				this.deny(426, upgradeMessage("This computer", (message.release as { api?: unknown } | undefined)?.api)); return;
			}
			delete this.credential.invitation;
			this.save(this.credential);
			clearTimeout(this.deadline);
			this.backoff = 1000; this.setOnline(true); this.resolve();
			return;
		}
		if (message.type === "event") {
			if (message.sequence !== this.received + 1) throw new Error("Unexpected event sequence.");
			this.received++;
			const event = message.event as HostEvent;
			if (event.type === "state" && !apiMatches(event.state.release?.api)) {
				this.deny(426, upgradeMessage("This computer", event.state.release?.api)); return;
			}
			for (const handler of this.handlers) handler(event, this.received);
		} else if (message.type === "response" && validId(message.id)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id); clearTimeout(pending.timer);
			pending.resolve(message.response as ApiResponse);
		} else throw new Error("Unknown host message.");
	}
	request(request: ApiRequest): Promise<ApiResponse> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.online || !this.channel) return Promise.reject(new RemoteError(503, "The host is not connected."));
		if (this.pending.size >= 32) return Promise.reject(new RemoteError(429, "Too many requests are waiting."));
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RemoteError(504, "Request timed out; delivery is uncertain. Check the session before retrying."));
			}, 60_000);
			this.pending.set(id, { resolve, reject, timer });
			void this.channel!.send({ type: "request", id, request }).catch(() => this.socket?.close());
		});
	}
	acknowledge(sequence: number): void {
		if (!this.online || sequence <= this.acknowledged) return;
		if (sequence > this.received) throw new Error("Invalid event acknowledgement.");
		this.acknowledged = sequence;
		if (this.ackScheduled) return;
		this.ackScheduled = true;
		const channel = this.channel;
		queueMicrotask(() => {
			this.ackScheduled = false;
			if (this.online && this.channel === channel) void channel?.send({ type: "events_ack", sequence: this.acknowledged }).catch(() => this.socket?.close());
		});
	}
	subscribe(events: (event: HostEvent, sequence: number) => void, connected: (online: boolean) => void): () => void {
		this.handlers.add(events); this.connections.add(connected);
		connected(this.online);
		return () => { this.handlers.delete(events); this.connections.delete(connected); };
	}
	private rejectPending(message: string): void {
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RemoteError(503, message)); }
		this.pending.clear();
	}
	private disconnect(message: string): void {
		clearTimeout(this.timer); clearTimeout(this.deadline);
		const socket = this.socket; this.socket = undefined;
		socket?.close(); this.channel?.close(); this.channel = undefined;
		this.rejectPending(message); this.setOnline(false);
	}
	reconnect(): void {
		this.disconnect("Reconnecting; delivery of pending commands is uncertain. Check the session before retrying.");
		this.connect();
	}
	close(): void {
		this.closed = true;
		removeEventListener("online", this.onlineListener);
		document.removeEventListener("visibilitychange", this.visibilityListener);
		removeEventListener("pagehide", this.pageHideListener);
		removeEventListener("pageshow", this.onlineListener);
		this.disconnect("Computer disconnected; delivery of pending commands is uncertain.");
		this.reject(new RemoteError(503, "Computer disconnected."));
	}
}

import { SecureChannel, validId, MAX_WIRE } from "../shared/secure-channel.ts";
import { ClientHandshake, ChannelVersionError, type ChannelIdentity } from "../shared/account-channel.ts";
import type { AccountConfiguration, MembershipLease, MembershipPeer } from "../shared/account.ts";
import { CredentialVerifier, type DeviceCredential } from "../shared/device-credential.ts";
import { membershipDeadline, MembershipDenied } from "../shared/membership.ts";
import { socketUrl, type ApiRequest, type ApiResponse } from "../shared/relay-protocol.ts";
import type { HostEvent } from "../shared/protocol.ts";
import { API_VERSION, apiMatches, upgradeMessage } from "../shared/release.ts";
import { interruptionReason, type ConnectionInterruption, type ConnectionState } from "./connection-state.ts";

export interface RemoteAccount extends ChannelIdentity {
	config: AccountConfiguration;
	verifier(): CredentialVerifier;
	lease(peers: MembershipPeer[]): Promise<MembershipLease>;
}
export class RemoteError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
interface Pending { resolve: (value: ApiResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class RemoteClient {
	private account: RemoteAccount;
	private host: MembershipPeer;
	private verifier: CredentialVerifier;
	private peer?: DeviceCredential;
	private own?: DeviceCredential;
	private leaseUntil = 0;
	private sentCredential?: string;
	private socket?: WebSocket;
	private channel?: SecureChannel;
	private pending = new Map<string, Pending>();
	private handlers = new Set<(event: HostEvent, sequence: number) => void>();
	private connections = new Set<(online: boolean) => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private deadline?: ReturnType<typeof setTimeout>;
	private refresh?: ReturnType<typeof setInterval>;
	private expiry?: ReturnType<typeof setInterval>;
	private closed = false;
	private starting = false;
	private generation = 0;
	private failure?: RemoteError;
	private lastError?: string;
	private online = false;
	private phase: ConnectionState = "connecting";
	private attempts = 0;
	private interruptionCount = 0;
	private lastInterruption?: ConnectionInterruption;
	private backoff = 1000;
	private received = 0;
	private acknowledged = 0;
	private ackScheduled = false;
	private renewing = false;
	private onlineListener = () => { clearTimeout(this.timer); void this.connect(); };
	private visibilityListener = () => document.hidden ? this.disconnect("App paused; delivery of pending commands is uncertain.", "paused") : void this.connect();
	private pageHideListener = () => this.disconnect("App closed; delivery of pending commands is uncertain.", "paused");
	private offlineListener = () => {
		this.interrupted("This device lost its network connection");
		this.disconnect("This device is offline; delivery of pending commands is uncertain.", "network-offline");
	};

	constructor(account: RemoteAccount, host: MembershipPeer) {
		this.account = account; this.host = host; this.verifier = account.verifier();
		addEventListener("online", this.onlineListener);
		addEventListener("offline", this.offlineListener);
		document.addEventListener("visibilitychange", this.visibilityListener);
		addEventListener("pagehide", this.pageHideListener);
		addEventListener("pageshow", this.onlineListener);
		void this.connect();
	}
	get connected(): boolean { return this.online && this.valid(); }
	get state(): ConnectionState {
		if (this.failure) return this.failure.status === 426 ? "upgrade" : "denied";
		return this.phase === "connected" && !this.valid() ? "reconnecting" : this.phase;
	}
	get error(): string | undefined {
		if (this.failure) return this.failure.message;
		if (this.phase === "paused") return "This app is paused. Pausing the browser does not stop Pi sessions.";
		if (this.phase === "network-offline") return "This device has no network connection.";
		return this.lastError;
	}
	get diagnostics() { return { interruptions: this.interruptionCount, last: this.lastInterruption }; }
	private setPhase(value: ConnectionState): void {
		this.phase = value; this.online = value === "connected";
		if (this.online) this.lastError = undefined;
		for (const handler of this.connections) handler(this.connected);
	}
	private interrupted(reason: string, code?: number): void {
		if (!this.online) return;
		this.interruptionCount++;
		this.lastInterruption = { at: Date.now(), reason, ...(code === undefined ? {} : { code }) };
	}
	private valid(socket = this.socket): boolean {
		return !this.closed && this.socket === socket && socket?.readyState === WebSocket.OPEN
			&& !!this.peer && !!this.own && this.peer.expires > Date.now() / 1000 && this.own.expires > Date.now() / 1000
			&& this.leaseUntil > performance.now();
	}
	private retry(): void {
		if (this.closed || this.failure || document.hidden || navigator.onLine === false) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.connect(); }, this.backoff + Math.random() * 500);
		this.backoff = Math.min(30_000, this.backoff * 2);
	}
	private async connect(): Promise<void> {
		if (this.closed || this.failure || this.starting) return;
		if (document.hidden) { this.setPhase("paused"); return; }
		if (navigator.onLine === false) { this.setPhase("network-offline"); return; }
		if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
		const generation = ++this.generation;
		this.starting = true;
		this.setPhase(this.attempts++ ? "reconnecting" : "connecting");
		let handshake: ClientHandshake | undefined;
		try {
			const started = performance.now(), lease = await this.account.lease([this.host]);
			const until = membershipDeadline(lease, started, this.host.id);
			handshake = await ClientHandshake.create(this.host.id, this.account, this.verifier);
			if (this.closed || generation !== this.generation || document.hidden) { handshake.close(); return; }
			if (until <= performance.now()) throw new Error("Account authorization expired.");
			this.leaseUntil = until;
			this.open(handshake);
		} catch (error) {
			handshake?.close();
			if (this.closed || generation !== this.generation) return;
			if (error instanceof MembershipDenied) this.deny(403, "This computer is no longer in your account workspace.");
			else {
				this.lastError = "Account authorization is unavailable. Reconnecting.";
				this.setPhase("reconnecting"); this.retry();
			}
		} finally { if (generation === this.generation) this.starting = false; }
	}
	private open(handshake: ClientHandshake): void {
		this.channel?.close(); this.channel = undefined; this.peer = undefined; this.own = undefined;
		this.received = 0; this.acknowledged = 0; this.renewing = false;
		const socket = new WebSocket(socketUrl(this.account.config.relayOrigin, "/connect", this.host.id));
		this.socket = socket;
		let processing = Promise.resolve(), handshakes = 0, maintaining = false;
		const maintain = () => {
			if (maintaining || !this.valid(socket) || !this.online) return;
			maintaining = true;
			void this.maintain(socket).catch(error => {
				if (this.socket !== socket || this.closed) return;
				if (error instanceof MembershipDenied) this.deny(403, "This computer was removed from your workspace.");
				// Transient account outages never extend the current authorization deadline.
			}).finally(() => { maintaining = false; });
		};
		this.deadline = setTimeout(() => socket.close(4004, "Handshake timed out"), 30_000);
		socket.onopen = () => {
			if (this.socket !== socket || this.closed || this.leaseUntil <= performance.now()) { socket.close(); return; }
			socket.send(JSON.stringify(handshake.offer));
		};
		socket.onmessage = event => {
			if (this.socket !== socket || this.closed) return;
			if (typeof event.data !== "string" || event.data.length > MAX_WIRE) { socket.close(4002); return; }
			if (this.channel) { this.channel.receive(event.data); return; }
			if (++handshakes > 4) { socket.close(4002); return; }
			processing = processing.then(async () => {
				if (this.socket !== socket || this.closed) return;
				if (this.channel) { this.channel.receive(event.data); return; }
				const message = JSON.parse(event.data);
				if (message.type === "upgrade-required") { this.deny(426, upgradeMessage("This computer", message.api)); return; }
				const session = await handshake.finish(message, {
					output: wire => {
						if (!this.valid(socket) || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error("Connection authorization or capacity unavailable.");
						socket.send(wire);
					},
					input: payload => {
						if (this.socket === socket) void this.message(payload, socket).catch(() => socket.close(4002, "Invalid host message"));
					}, failed: () => socket.close(4002, "Encrypted channel rejected"),
				});
				if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.closed) { session.channel.close(); return; }
				if (session.peer.thumbprint !== this.host.thumbprint) { session.channel.close(); throw new Error("Computer key changed."); }
				this.channel = session.channel; this.peer = session.peer; this.own = session.own;
				this.sentCredential = handshake.offer.credential;
				this.refresh = setInterval(maintain, 20_000);
				this.expiry = setInterval(() => { if (!this.valid(socket)) socket.close(4004, "Authorization expired"); }, 1000);
				await session.channel.send({ type: "hello", api: API_VERSION });
			}).catch(error => {
				if (error instanceof ChannelVersionError) this.deny(426, error.message);
				else socket.close(4002, "Invalid host response");
			}).finally(() => { handshakes--; });
		};
		socket.onerror = () => {};
		socket.onclose = event => {
			handshake.close();
			if (this.socket !== socket) return;
			this.interrupted(interruptionReason(event.code), event.code);
			clearTimeout(this.deadline); clearInterval(this.refresh); clearInterval(this.expiry);
			this.channel?.close(); this.channel = undefined; this.peer = undefined; this.own = undefined;
			if (event.code === 4003) this.failure ??= new RemoteError(426, "Update Pi Desk on the computer and reload this app.");
			this.lastError = event.code === 4001 ? "Computer access could not be authorized. Rechecking the account."
				: this.online ? "Connection interrupted. Reconnecting." : "Could not establish a connection. Retrying.";
			this.setPhase("reconnecting");
			this.rejectPending("Connection lost; delivery is uncertain. Check the conversation before sending it again.");
			if (this.closed || this.failure) return;
			this.retry();
		};
	}
	private async maintain(socket: WebSocket): Promise<void> {
		const started = performance.now(), lease = await this.account.lease([this.host]);
		if (this.socket !== socket || this.closed) return;
		this.leaseUntil = membershipDeadline(lease, started, this.host.id);
		const token = await this.account.certificate();
		if (!this.valid(socket) || !this.own || token === this.sentCredential) return;
		const own = await this.verifier.verify(token, "browser", this.own.id);
		if (own.thumbprint !== this.own.thumbprint) throw new Error("Browser identity changed.");
		if (!this.valid(socket)) return;
		await this.channel!.send({ type: "authorize", credential: token });
		if (this.socket === socket) { this.own = own; this.sentCredential = token; }
	}
	private deny(status: number, message: string): void {
		this.interrupted(status === 426 ? "Application update required" : "Account access is unavailable");
		this.failure = new RemoteError(status, message);
		this.disconnect("Access unavailable; delivery of pending commands is uncertain.");
	}
	private async message(raw: unknown, socket: WebSocket): Promise<void> {
		if (!this.valid(socket)) { socket.close(4004, "Authorization expired"); return; }
		if (!raw || typeof raw !== "object") throw new Error("Invalid host response.");
		const message = raw as Record<string, unknown>;
		if (message.type === "upgrade-required") { this.deny(426, upgradeMessage("This computer", message.api)); return; }
		if (!this.online) {
			if (message.type !== "ready") throw new Error("Expected authenticated host acknowledgement.");
			if (!apiMatches((message.release as { api?: unknown } | undefined)?.api)) {
				this.deny(426, upgradeMessage("This computer", (message.release as { api?: unknown } | undefined)?.api)); return;
			}
			clearTimeout(this.deadline); this.backoff = 1000; this.setPhase("connected"); return;
		}
		if (message.type === "authorize") {
			if (this.renewing || typeof message.credential !== "string") throw new Error("Invalid credential renewal.");
			this.renewing = true;
			try {
				const peer = await this.verifier.verify(message.credential, "host", this.host.id);
				if (peer.thumbprint !== this.host.thumbprint) throw new Error("Computer identity changed.");
				if (this.valid(socket)) this.peer = peer;
			} finally { this.renewing = false; }
		} else if (message.type === "event") {
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
			this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message.response as ApiResponse);
		} else throw new Error("Unknown host message.");
	}
	request(request: ApiRequest): Promise<ApiResponse> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.online || !this.channel || !this.valid()) return Promise.reject(new RemoteError(503, "The computer is not connected or its authorization expired."));
		if (this.pending.size >= 32) return Promise.reject(new RemoteError(429, "Too many requests are waiting."));
		const id = crypto.randomUUID(), socket = this.socket;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id); reject(new RemoteError(504, "Request timed out; delivery is uncertain. Check the session before retrying."));
			}, 60_000);
			this.pending.set(id, { resolve, reject, timer });
			void this.channel!.send({ type: "request", id, request }).catch(() => socket?.close());
		});
	}
	acknowledge(sequence: number): void {
		if (!this.online || !this.valid() || sequence <= this.acknowledged) return;
		if (sequence > this.received) throw new Error("Invalid event acknowledgement.");
		this.acknowledged = sequence;
		if (this.ackScheduled) return;
		this.ackScheduled = true;
		const channel = this.channel;
		queueMicrotask(() => {
			this.ackScheduled = false;
			if (this.online && this.channel === channel && this.valid()) {
				const socket = this.socket;
				void channel?.send({ type: "events_ack", sequence: this.acknowledged }).catch(() => socket?.close());
			}
		});
	}
	subscribe(events: (event: HostEvent, sequence: number) => void, connected: (online: boolean) => void): () => void {
		this.handlers.add(events); this.connections.add(connected); connected(this.connected);
		return () => { this.handlers.delete(events); this.connections.delete(connected); };
	}
	private rejectPending(message: string): void {
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RemoteError(503, message)); }
		this.pending.clear();
	}
	private disconnect(message: string, phase: ConnectionState = "reconnecting"): void {
		this.generation++; this.starting = false;
		clearTimeout(this.timer); clearTimeout(this.deadline); clearInterval(this.refresh); clearInterval(this.expiry);
		const socket = this.socket; this.socket = undefined;
		socket?.close(); this.channel?.close(); this.channel = undefined; this.peer = undefined; this.own = undefined;
		this.rejectPending(message); this.setPhase(phase);
	}
	reconnect(reason?: string): void {
		if (reason) this.interrupted(reason);
		this.disconnect("Reconnecting; delivery of pending commands is uncertain. Check the session before retrying.");
		void this.connect();
	}
	close(): void {
		this.closed = true;
		removeEventListener("online", this.onlineListener);
		removeEventListener("offline", this.offlineListener);
		document.removeEventListener("visibilitychange", this.visibilityListener);
		removeEventListener("pagehide", this.pageHideListener);
		removeEventListener("pageshow", this.onlineListener);
		this.disconnect("Computer disconnected; delivery of pending commands is uncertain.", "closed");
	}
}

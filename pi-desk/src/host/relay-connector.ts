import { WebSocket } from "ws";
import { ProxyAgent } from "proxy-agent";
import { object, string } from "./commands.ts";
import { SecureChannel, validId, MAX_WIRE, PROTOCOL_VERSION } from "../shared/secure-channel.ts";
import { acceptChannelOffer, hostAdmission, ChannelVersionError, type ChannelIdentity } from "../shared/account-channel.ts";
import type { AccountConfiguration, MembershipLease, MembershipPeer } from "../shared/account.ts";
import { CredentialVerifier, type DeviceCredential } from "../shared/device-credential.ts";
import { membershipDeadline, MembershipDenied } from "../shared/membership.ts";
import { EventWindow } from "./event-window.ts";
import { remoteOrigins, socketUrl, type ApiRequest, type ApiResponse, type RemotePayload } from "../shared/relay-protocol.ts";
import type { HostEvent } from "../shared/protocol.ts";
import { API_VERSION, RELEASE, apiMatches } from "../shared/release.ts";
import { AccountSignInRequired } from "./account-errors.ts";

interface Peer {
	id: string; device?: DeviceCredential; channel?: SecureChannel; ready: boolean;
	timer: ReturnType<typeof setTimeout>; unwatch?: () => void; pending: number; events: EventWindow;
	leaseUntil: number; ownExpires: number; sentCredential?: string; handshaking: boolean; renewing: boolean;
}
export interface RemoteAccess { id: string; authorized: () => boolean }
export interface HostAccount extends ChannelIdentity {
	config: AccountConfiguration; device: { id: string; thumbprint: string };
	verifier(): CredentialVerifier;
	lease(peers: MembershipPeer[]): Promise<MembershipLease>;
	heartbeat(connected: boolean): Promise<unknown>;
}
export interface RelayStatus { origin: string; appOrigin: string; state: "connecting" | "online" | "offline"; error?: string }
interface Options {
	appOrigin: string; proxy?: string; account: HostAccount;
	request: (access: RemoteAccess, request: ApiRequest) => Promise<ApiResponse>;
	watch: (handler: (event: HostEvent) => void) => () => void;
	status: (status: RelayStatus) => void;
}

export class RelayConnector {
	private options: Options;
	private verifier: CredentialVerifier;
	private socket?: WebSocket;
	private peers = new Map<string, Peer>();
	private timer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setTimeout>;
	private refresh?: ReturnType<typeof setInterval>;
	private expiry?: ReturnType<typeof setInterval>;
	private stopped = false;
	private connecting = false;
	private admitted = false;
	private hostLeaseUntil = 0;
	private backoff = 1000;
	private agent: ProxyAgent;
	status: RelayStatus;

	constructor(options: Options) {
		this.options = options;
		const origins = remoteOrigins(options.account.config.relayOrigin, options.appOrigin);
		if (!options.account.config.appOrigins.includes(origins.appOrigin)) throw new Error("Account does not authorize this app.");
		this.status = { ...origins, state: "connecting" };
		this.verifier = options.account.verifier();
		this.agent = options.proxy ? new ProxyAgent({ getProxyForUrl: () => options.proxy! }) : new ProxyAgent();
	}
	start(): void { void this.connect(); }
	private update(state: RelayStatus["state"], error?: string): void {
		this.status = { origin: this.status.origin, appOrigin: this.status.appOrigin, state, ...(error ? { error } : {}) };
		this.options.status(this.status);
	}
	private retry(): void {
		if (this.stopped) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.connect(); }, this.backoff + Math.random() * 500);
		this.timer.unref(); this.backoff = Math.min(30_000, this.backoff * 2);
	}
	private async certificate(): Promise<{ token: string; credential: DeviceCredential }> {
		const token = await this.options.account.certificate();
		const credential = await this.verifier.verify(token, "host", this.options.account.device.id);
		if (credential.thumbprint !== this.options.account.device.thumbprint) throw new Error("Computer identity changed.");
		return { token, credential };
	}
	private async connect(): Promise<void> {
		if (this.stopped || this.connecting || this.socket) return;
		this.connecting = true; this.update("connecting");
		try {
			await this.certificate();
			const started = performance.now(), lease = await this.options.account.lease([]);
			this.hostLeaseUntil = membershipDeadline(lease, started);
			if (this.stopped) return;
			this.open();
		} catch (error) {
			if (!this.stopped) {
				this.update("offline", error instanceof AccountSignInRequired ? error.message
					: "Account access is unavailable. Check sign-in, the account service, proxy and network policy.");
				this.retry();
			}
		} finally { this.connecting = false; }
	}
	private open(): void {
		const socket = new WebSocket(socketUrl(this.status.origin, "/host", this.options.account.device.id), {
			agent: this.agent, handshakeTimeout: 15_000, maxPayload: MAX_WIRE * 2, perMessageDeflate: false,
		});
		this.socket = socket; this.admitted = false;
		let authenticating = false, maintaining = false;
		const heartbeat = () => {
			clearTimeout(this.heartbeat);
			this.heartbeat = setTimeout(() => socket.terminate(), 50_000); this.heartbeat.unref();
		};
		const maintain = () => {
			if (maintaining || this.socket !== socket || !this.admitted) return;
			maintaining = true;
			void this.maintain(socket).catch(error => {
				if (this.socket !== socket || this.stopped) return;
				if (["device_revoked", "device_not_found", "workspace_access_denied"].includes(error?.message)) {
					this.hostLeaseUntil = 0; socket.terminate();
				} else this.update("online", "Account renewal is unavailable; access pauses when its authorization expires.");
			}).finally(() => { maintaining = false; });
		};
		socket.on("open", heartbeat);
		socket.on("ping", heartbeat);
		socket.on("message", raw => {
			if (this.socket !== socket || this.stopped) return;
			try {
				const message = object(JSON.parse(raw.toString()));
				if (!this.admitted) {
					if (message.type === "admission" && !authenticating && message.protocol === PROTOCOL_VERSION) {
						authenticating = true;
						void hostAdmission(this.options.account, this.status.origin, string(message.nonce, 100)).then(proof => {
							if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(proof));
						}).catch(() => socket.terminate());
						return;
					}
					if (message.type !== "admitted" || !authenticating || message.protocol !== PROTOCOL_VERSION) throw new Error("Invalid admission.");
					this.admitted = true; this.backoff = 1000; this.update("online");
					this.refresh = setInterval(maintain, 20_000); this.refresh.unref();
					this.expiry = setInterval(() => {
						if (performance.now() >= this.hostLeaseUntil) { socket.terminate(); return; }
						for (const peer of this.peers.values()) if (peer.channel && !this.valid(peer)) this.drop(peer.id, true, 1013);
					}, 1000); this.expiry.unref();
					maintain(); return;
				}
				if (message.type === "renewed") return;
				if (!validId(message.peer)) throw new Error("Invalid relay peer.");
				const id = message.peer;
				if (message.type === "opened") {
					if (this.peers.has(id) || this.peers.size >= 32) throw new Error("Too many relay peers.");
					const peer: Peer = { id, ready: false, pending: 0, events: new EventWindow(),
						leaseUntil: 0, ownExpires: 0, handshaking: false, renewing: false,
						timer: setTimeout(() => this.drop(id, true, 1013), 30_000) };
					this.peers.set(id, peer);
				} else if (message.type === "closed") this.drop(id);
				else if (message.type === "frame") {
					const peer = this.peers.get(id);
					if (!peer) return;
					const frame = string(message.frame, MAX_WIRE);
					if (peer.channel) peer.channel.receive(frame);
					else {
						if (peer.handshaking) { this.drop(id, true); return; }
						peer.handshaking = true;
						void this.identify(peer, frame).catch(error => {
							if (this.peers.get(id) !== peer) return;
							if (error instanceof ChannelVersionError) {
								socket.send(JSON.stringify({ type: "frame", peer: id,
									frame: JSON.stringify({ type: "upgrade-required", api: API_VERSION }) }));
								this.drop(id, true, 4003);
							} else this.drop(id, true, error instanceof MembershipDenied ? 4001 : 1013);
						});
					}
				} else throw new Error("Invalid relay event.");
			} catch { socket.close(1008, "Invalid relay protocol"); }
		});
		socket.on("error", () => {
			if (this.socket === socket && !this.stopped) this.update("offline", "Relay connection failed. Check the account workspace, proxy and network policy.");
		});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined; this.admitted = false;
			clearTimeout(this.heartbeat); clearInterval(this.refresh); clearInterval(this.expiry);
			for (const id of this.peers.keys()) this.drop(id);
			if (this.stopped) return;
			this.update("offline", this.status.error ?? "Relay disconnected. Retrying.");
			this.retry();
		});
	}
	private async maintain(socket: WebSocket): Promise<void> {
		const peers = [...this.peers.values()].filter(peer => peer.device);
		const started = performance.now();
		const lease = await this.options.account.lease(peers.map(peer => ({ id: peer.device!.id, thumbprint: peer.device!.thumbprint })));
		if (this.socket !== socket || this.stopped) return;
		this.hostLeaseUntil = membershipDeadline(lease, started);
		for (const peer of peers) if (this.peers.get(peer.id) === peer) {
			try { peer.leaseUntil = membershipDeadline(lease, started, peer.device!.id); }
			catch (error) { this.drop(peer.id, true, error instanceof MembershipDenied ? 4001 : 1013); }
		}
		const current = await this.certificate();
		if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.stopped) return;
		socket.send(JSON.stringify({ type: "renew", credential: current.token }));
		for (const peer of this.peers.values()) if (peer.ready && peer.sentCredential !== current.token && this.valid(peer)) {
			await peer.channel!.send({ type: "authorize", credential: current.token } satisfies RemotePayload);
			if (this.peers.get(peer.id) === peer) { peer.sentCredential = current.token; peer.ownExpires = current.credential.expires; }
		}
		await this.options.account.heartbeat(true);
		if (this.socket === socket && !this.stopped) this.update("online");
	}
	private valid(peer: Peer): boolean {
		const now = Date.now() / 1000, monotonic = performance.now();
		return !this.stopped && this.admitted && this.socket?.readyState === WebSocket.OPEN && this.peers.get(peer.id) === peer
			&& !!peer.device && peer.device.expires > now && peer.ownExpires > now
			&& peer.leaseUntil > monotonic && this.hostLeaseUntil > monotonic;
	}
	private async output(peer: Peer, frame: string): Promise<void> {
		const socket = this.socket;
		if (!this.valid(peer) || !socket || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error("Connection authorization or capacity unavailable.");
		await new Promise<void>((yes, no) => socket.send(JSON.stringify({ type: "frame", peer: peer.id, frame }), error => error ? no(error) : yes()));
	}
	private async identify(peer: Peer, wire: string): Promise<void> {
		const session = await acceptChannelOffer(JSON.parse(wire), this.options.account.device.id, this.options.account, this.verifier, async device => {
			const started = performance.now();
			const lease = await this.options.account.lease([{ id: device.id, thumbprint: device.thumbprint }]);
			peer.leaseUntil = membershipDeadline(lease, started, device.id);
		}, {
			output: frame => this.output(peer, frame),
			input: payload => { void this.message(peer, payload).catch(() => this.drop(peer.id, true)); },
			failed: () => this.drop(peer.id, true, 1013),
		});
		if (this.peers.get(peer.id) !== peer) { session.channel.close(); return; }
		peer.device = session.peer; peer.ownExpires = session.own.expires; peer.sentCredential = session.accept.credential;
		peer.channel = session.channel;
		await this.output(peer, JSON.stringify(session.accept));
	}
	private async message(peer: Peer, raw: unknown): Promise<void> {
		if (!this.valid(peer)) { this.drop(peer.id, true, 1013); return; }
		const message = object(raw), device = peer.device!;
		if (!peer.ready) {
			if (message.type !== "hello") throw new Error("Expected device proof.");
			if (!apiMatches(message.api)) {
				await peer.channel!.send({ type: "upgrade-required", api: API_VERSION });
				this.drop(peer.id, true, 4003); return;
			}
			peer.ready = true; clearTimeout(peer.timer);
			await peer.channel!.send({ type: "ready", release: RELEASE } satisfies RemotePayload);
			if (!this.valid(peer)) return;
			peer.unwatch = this.options.watch(event => {
				if (!this.valid(peer)) { this.drop(peer.id, true, 1013); return; }
				const sequence = peer.events.reserve(event);
				if (sequence === undefined) { this.drop(peer.id, true, 1013); return; }
				void peer.channel!.send({ type: "event", sequence, event } satisfies RemotePayload).catch(() => this.drop(peer.id, true, 1013));
			});
			if (!this.valid(peer)) peer.unwatch();
			return;
		}
		if (message.type === "authorize") {
			if (peer.renewing) throw new Error("Credential renewal already in progress.");
			peer.renewing = true;
			try {
				const updated = await this.verifier.verify(string(message.credential, 8000), "browser", device.id);
				if (updated.thumbprint !== device.thumbprint) throw new Error("Device identity changed.");
				if (this.valid(peer)) peer.device = updated;
			} finally { peer.renewing = false; }
			return;
		}
		if (message.type === "events_ack") { peer.events.acknowledge(message.sequence); return; }
		if (message.type !== "request" || !validId(message.id) || peer.pending >= 32) throw new Error("Invalid remote request.");
		const request = object(message.request);
		if ((request.method !== "GET" && request.method !== "POST") || typeof request.path !== "string" || request.path.length > 5000 ||
			!request.path.startsWith("/api/") || Buffer.byteLength(JSON.stringify(request)) > 1_100_000) throw new Error("Invalid remote request.");
		peer.pending++;
		try {
			const response = await this.options.request({ id: device.id, authorized: () => peer.ready && this.valid(peer) }, {
				method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: object(request.body) }),
			});
			if (this.valid(peer)) await peer.channel!.send({ type: "response", id: message.id, response } satisfies RemotePayload);
		} finally { peer.pending--; }
	}
	private drop(id: string, notify = false, code = 4001): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		this.peers.delete(id); clearTimeout(peer.timer); peer.channel?.close(); peer.unwatch?.();
		if (notify && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "close", peer: id, code }));
	}
	close(): void {
		this.stopped = true; clearTimeout(this.timer); clearTimeout(this.heartbeat); clearInterval(this.refresh); clearInterval(this.expiry);
		for (const id of this.peers.keys()) this.drop(id);
		this.socket?.terminate(); this.agent.destroy();
	}
}

import { WebSocket } from "ws";
import { ProxyAgent } from "proxy-agent";
import { object, string } from "./commands.ts";
import { SecureChannel, validId, MAX_WIRE, PROTOCOL_VERSION } from "../shared/secure-channel.ts";
import { acceptChannelOffer, ClientHandshake, hostAdmission, ChannelVersionError, type ChannelIdentity, type ChannelPurpose } from "../shared/account-channel.ts";
import type { AccountConfiguration, MembershipLease, MembershipPeer } from "../shared/account.ts";
import { CredentialVerifier, type DeviceCredential } from "../shared/device-credential.ts";
import { membershipDeadline, MembershipDenied } from "../shared/membership.ts";
import { EventDelivery, EventWindow } from "./event-window.ts";
import { remoteOrigins, socketUrl, type ApiRequest, type ApiResponse, type RemotePayload } from "../shared/relay-protocol.ts";
import type { HostEvent } from "../shared/protocol.ts";
import { API_VERSION, RELEASE, apiMatches } from "../shared/release.ts";
import { AccountSignInRequired } from "./account-errors.ts";
import { MAX_NETWORK_PACKET } from "../../../pi-party/network.ts";

interface Peer {
	id: string; purpose: ChannelPurpose; initiator?: boolean; handshake?: ClientHandshake; device?: DeviceCredential; channel?: SecureChannel; ready: boolean;
	timer: ReturnType<typeof setTimeout>; unwatch?: () => void; pending: number; events: EventWindow; delivery?: EventDelivery;
	leaseUntil: number; ownExpires: number; sentCredential?: string; handshaking: boolean; renewing: boolean;
}
export interface RemoteAccess { id: string; authorized: () => boolean }
export interface HostAccount extends ChannelIdentity {
	config: AccountConfiguration; device: { id: string; thumbprint: string };
	verifier(): CredentialVerifier;
	lease(peers: MembershipPeer[], purpose?: "party"): Promise<MembershipLease>;
	heartbeat(connected: boolean): Promise<unknown>;
}
export interface ConnectorRequest { method: string; path: string; query: string; headers: { authorization?: string; "content-type"?: string }; body: string }
export interface ConnectorResponse { status: number; headers?: Record<string, string>; body: string }
export interface RelayStatus { origin: string; appOrigin: string; state: "connecting" | "online" | "offline"; error?: string }
interface Options {
	appOrigin: string; proxy?: string; account: HostAccount;
	request: (access: RemoteAccess, request: ApiRequest) => Promise<ApiResponse>;
	watch: (handler: (event: HostEvent) => void) => () => void;
	status: (status: RelayStatus) => void;
	party?: {
		connected: (id: string, send: (payload: unknown) => Promise<void>, close: () => void) => () => void;
		receive: (id: string, payload: unknown) => void | Promise<void>;
	};
	/** Dot connector: the relay forwards HTTP requests for this host's connector path; the host authenticates them. */
	connector?: { enabled: () => boolean; handle: (request: ConnectorRequest) => Promise<ConnectorResponse> };
}

export class RelayConnector {
	private options: Options;
	private verifier: CredentialVerifier;
	private socket?: WebSocket;
	private peers = new Map<string, Peer>();
	private computers: string[] = [];
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
	/** Publish the current connector key (or its removal) to the relay. */
	connectorChanged(): void {
		if (!this.options.connector || !this.admitted || this.socket?.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify({ type: "connector-enable", enabled: this.options.connector.enabled() }));
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
					if (this.options.party) socket.send(JSON.stringify({ type: "party-enable" }));
					this.connectorChanged();
					this.refresh = setInterval(maintain, 20_000); this.refresh.unref();
					this.expiry = setInterval(() => {
						if (performance.now() >= this.hostLeaseUntil) { socket.terminate(); return; }
						for (const peer of this.peers.values()) if (peer.channel && !this.valid(peer)) this.drop(peer.id, true, 1013);
					}, 1000); this.expiry.unref();
					maintain(); return;
				}
				if (message.type === "renewed") return;
				if (message.type === "connector") {
					const id = string(message.id, 64), headers = object(message.headers ?? {});
					const header = (name: string) => headers[name] === undefined ? undefined : string(headers[name], 8000);
					const request: ConnectorRequest = { method: string(message.method, 10), path: string(message.path, 200), query: string(message.query, 4000),
						headers: { authorization: header("authorization"), "content-type": header("content-type") }, body: string(message.body, 256 * 1024) };
					void (this.options.connector?.handle(request) ?? Promise.resolve({ status: 404, body: "" }))
						.catch(() => ({ status: 500, body: JSON.stringify({ error: "The connector failed." }) }))
						.then(result => { if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "connector-result", id, ...result })); });
					return;
				}
				if (message.type === "hosts") {
					if (!Array.isArray(message.hosts) || message.hosts.length > 256 || !message.hosts.every(validId)) throw new Error("Invalid computer directory.");
					this.computers = message.hosts; this.connectParties(); return;
				}
				if (!validId(message.peer)) throw new Error("Invalid relay peer.");
				const id = message.peer;
				if (message.type === "opened") {
					if (this.peers.has(id) || this.peers.size >= 32) throw new Error("Too many relay peers.");
					const purpose = message.purpose === "party" ? "party" : "control";
					if (purpose === "party" && (!this.options.party || id === this.options.account.device.id)) {
						socket.send(JSON.stringify({ type: "party-close", peer: id })); return;
					}
					const peer: Peer = { id, purpose, initiator: purpose === "party" && message.initiator === true, ready: false, pending: 0, events: new EventWindow(),
						leaseUntil: 0, ownExpires: 0, handshaking: false, renewing: false,
						timer: setTimeout(() => this.drop(id, true, 1013), 30_000) };
					this.peers.set(id, peer);
					if (purpose === "party" && message.initiator === true) void this.offerParty(peer).catch(() => this.drop(id, true, 1013));
				} else if (message.type === "closed") this.drop(id);
				else if (message.type === "frame") {
					const peer = this.peers.get(id);
					if (!peer) return;
					const frame = string(message.frame, MAX_WIRE);
					if (peer.channel) peer.channel.receive(frame);
					else {
						if (peer.handshaking) { this.drop(id, true); return; }
						peer.handshaking = true;
						void (peer.handshake ? this.finishParty(peer, frame) : this.identify(peer, frame)).catch(error => {
							if (this.peers.get(id) !== peer) return;
							if (error instanceof ChannelVersionError) {
								socket.send(JSON.stringify({ type: peer.purpose === "party" ? "party-frame" : "frame", peer: id,
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
			this.socket = undefined; this.admitted = false; this.computers = [];
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
		const leaseFor = (purpose: ChannelPurpose) => this.options.account.lease(peers.filter(peer => peer.purpose === purpose)
			.map(peer => ({ id: peer.device!.id, thumbprint: peer.device!.thumbprint })), purpose === "party" ? "party" : undefined);
		const [control, party] = await Promise.all([leaseFor("control"), this.options.party ? leaseFor("party") : Promise.resolve(undefined)]);
		if (this.socket !== socket || this.stopped) return;
		this.hostLeaseUntil = membershipDeadline(control, started);
		for (const peer of peers) if (this.peers.get(peer.id) === peer) {
			try { peer.leaseUntil = membershipDeadline(peer.purpose === "party" ? party! : control, started, peer.device!.id); }
			catch (error) { this.drop(peer.id, true, error instanceof MembershipDenied ? 4001 : 1013); }
		}
		this.connectParties();
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
	private connectParties(): void {
		if (!this.options.party || !this.admitted || this.socket?.readyState !== WebSocket.OPEN
			|| performance.now() >= this.hostLeaseUntil) return;
		let capacity = 32 - this.peers.size;
		for (const id of this.computers) if (this.options.account.device.id < id && !this.peers.has(id)) {
			if (capacity-- <= 0) break;
			this.socket.send(JSON.stringify({ type: "party-open", peer: id }));
		}
	}
	private async wire(peer: Peer, frame: string): Promise<void> {
		const socket = this.socket;
		if (this.stopped || !this.admitted || this.peers.get(peer.id) !== peer || socket?.readyState !== WebSocket.OPEN
			|| performance.now() >= this.hostLeaseUntil || socket.bufferedAmount > 2 * 1024 * 1024 || Buffer.byteLength(frame) > MAX_WIRE) {
			throw new Error("Connection unavailable.");
		}
		await new Promise<void>((yes, no) => socket.send(JSON.stringify({
			type: peer.purpose === "party" ? "party-frame" : "frame", peer: peer.id, frame,
		}), error => error ? no(error) : yes()));
	}
	private async offerParty(peer: Peer): Promise<void> {
		peer.handshaking = true;
		const handshake = await ClientHandshake.create(peer.id, this.options.account, this.verifier, "party");
		if (this.peers.get(peer.id) !== peer) { handshake.close(); return; }
		peer.handshake = handshake; peer.handshaking = false;
		await this.wire(peer, JSON.stringify(handshake.offer));
	}
	private async finishParty(peer: Peer, frame: string): Promise<void> {
		const handshake = peer.handshake!; peer.handshake = undefined;
		const session = await handshake.finish(JSON.parse(frame), {
			output: wire => this.output(peer, wire),
			input: payload => { void this.message(peer, payload).catch(() => this.drop(peer.id, true)); },
			failed: () => this.drop(peer.id, true, 1013),
		});
		try {
			const started = performance.now(), lease = await this.options.account.lease([
				{ id: session.peer.id, thumbprint: session.peer.thumbprint },
			], "party");
			const deadline = membershipDeadline(lease, started, session.peer.id);
			if (this.peers.get(peer.id) !== peer) { session.channel.close(); return; }
			peer.device = session.peer; peer.ownExpires = session.own.expires; peer.leaseUntil = deadline;
			peer.sentCredential = handshake.offer.credential; peer.channel = session.channel; peer.handshaking = false;
			await peer.channel.send({ type: "hello", api: API_VERSION } satisfies RemotePayload);
		} catch (error) { session.channel.close(); throw error; }
	}
	private async output(peer: Peer, frame: string): Promise<void> {
		const socket = this.socket;
		if (!this.valid(peer) || !socket || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error("Connection authorization or capacity unavailable.");
		await this.wire(peer, frame);
	}
	private async identify(peer: Peer, wire: string): Promise<void> {
		const session = await acceptChannelOffer(JSON.parse(wire), this.options.account.device.id, this.options.account, this.verifier, async device => {
			if (peer.purpose === "party" && device.id !== peer.id) throw new Error("Party computer identity changed.");
			const started = performance.now();
			const lease = await this.options.account.lease([{ id: device.id, thumbprint: device.thumbprint }], peer.purpose === "party" ? "party" : undefined);
			peer.leaseUntil = membershipDeadline(lease, started, device.id);
		}, {
			output: frame => this.output(peer, frame),
			input: payload => { void this.message(peer, payload).catch(() => this.drop(peer.id, true)); },
			failed: () => this.drop(peer.id, true, 1013),
		}, peer.purpose);
		if (this.peers.get(peer.id) !== peer) { session.channel.close(); return; }
		peer.device = session.peer; peer.ownExpires = session.own.expires; peer.sentCredential = session.accept.credential;
		peer.channel = session.channel;
		await this.output(peer, JSON.stringify(session.accept));
	}
	private async message(peer: Peer, raw: unknown): Promise<void> {
		if (!this.valid(peer)) { this.drop(peer.id, true, 1013); return; }
		const message = object(raw), device = peer.device!;
		if (!peer.ready) {
			if (message.type !== (peer.initiator ? "ready" : "hello")) throw new Error("Expected device proof.");
			if (!apiMatches(peer.initiator ? object(message.release).api : message.api)) {
				await peer.channel!.send({ type: "upgrade-required", api: API_VERSION });
				this.drop(peer.id, true, 4003); return;
			}
			peer.ready = true; clearTimeout(peer.timer);
			if (!peer.initiator) await peer.channel!.send({ type: "ready", release: RELEASE } satisfies RemotePayload);
			if (!this.valid(peer)) return;
			if (peer.purpose === "party") {
				peer.unwatch = this.options.party!.connected(device.id, payload => {
					if (!this.valid(peer)) return Promise.reject(new Error("Party computer is offline."));
					return peer.channel!.send({ type: "party", payload });
				}, () => this.drop(peer.id, true, 1013));
				if (!this.valid(peer)) peer.unwatch();
				return;
			}
			peer.delivery = new EventDelivery(peer.events, (sequence, event) =>
				peer.channel!.send({ type: "event", sequence, event } satisfies RemotePayload),
				() => this.drop(peer.id, true, 1013));
			peer.unwatch = this.options.watch(event => {
				if (!this.valid(peer)) { this.drop(peer.id, true, 1013); return; }
				peer.delivery!.push(event);
			});
			if (!this.valid(peer)) peer.unwatch();
			return;
		}
		if (message.type === "authorize") {
			if (peer.renewing) throw new Error("Credential renewal already in progress.");
			peer.renewing = true;
			try {
				const updated = await this.verifier.verify(string(message.credential, 8000), peer.purpose === "party" ? "host" : "browser", device.id);
				if (updated.thumbprint !== device.thumbprint) throw new Error("Device identity changed.");
				if (this.valid(peer)) peer.device = updated;
			} finally { peer.renewing = false; }
			return;
		}
		if (peer.purpose === "party") {
			if (message.type === "ready") return;
			if (message.type !== "party" || Buffer.byteLength(JSON.stringify(message.payload)) > MAX_NETWORK_PACKET) throw new Error("Invalid party payload.");
			await this.options.party!.receive(device.id, message.payload); return;
		}
		if (message.type === "events_ack") { peer.events.acknowledge(message.sequence); peer.delivery?.resume(); return; }
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
		this.peers.delete(id); clearTimeout(peer.timer); peer.delivery?.close(); peer.handshake?.close(); peer.channel?.close(); peer.unwatch?.();
		if (notify && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: peer.purpose === "party" ? "party-close" : "close", peer: id, code }));
	}
	close(): void {
		this.stopped = true; clearTimeout(this.timer); clearTimeout(this.heartbeat); clearInterval(this.refresh); clearInterval(this.expiry);
		for (const id of this.peers.keys()) this.drop(id);
		this.socket?.terminate(); this.agent.destroy();
	}
}

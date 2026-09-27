import { WebSocket } from "ws";
import { ProxyAgent } from "proxy-agent";
import { AccessStore, type RemoteDevice } from "./access.ts";
import { object, string } from "./commands.ts";
import { SecureChannel, newSecret, validId, validSecret, MAX_WIRE, PROTOCOL_VERSION } from "../shared/secure-channel.ts";
import { EventWindow } from "./event-window.ts";
import { relayOrigin, socketUrl, type ApiRequest, type ApiResponse, type RemotePayload } from "../shared/relay-protocol.ts";
import type { HostEvent } from "../shared/protocol.ts";
import { API_VERSION, RELEASE, apiMatches } from "../shared/release.ts";

interface Peer {
	id: string; device?: RemoteDevice; channel?: SecureChannel; ready: boolean;
	input: Promise<void>; timer: ReturnType<typeof setTimeout>; unwatch?: () => void; pending: number; events: EventWindow;
}
export interface RelayStatus { origin: string; state: "connecting" | "online" | "offline"; error?: string }
interface Options {
	origin: string; token: string; proxy?: string; access: AccessStore;
	request: (device: string, request: ApiRequest) => Promise<ApiResponse>;
	watch: (handler: (event: HostEvent) => void) => () => void;
	status: (status: RelayStatus) => void;
}

export class RelayConnector {
	private options: Options;
	private socket?: WebSocket;
	private peers = new Map<string, Peer>();
	private timer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private backoff = 1000;
	private unrevoke: () => void;
	private agent: ProxyAgent;
	status: RelayStatus;

	constructor(options: Options) {
		this.options = { ...options, origin: relayOrigin(options.origin) };
		this.status = { origin: this.options.origin, state: "connecting" };
		this.agent = options.proxy ? new ProxyAgent({ getProxyForUrl: () => options.proxy! }) : new ProxyAgent();
		this.unrevoke = options.access.onRevoke(id => {
			for (const peer of this.peers.values()) if (peer.device?.id === id) this.drop(peer.id, true);
		});
	}
	start(): void { this.connect(); }
	private update(state: RelayStatus["state"], error?: string): void {
		this.status = { origin: this.options.origin, state, ...(error ? { error } : {}) };
		this.options.status(this.status);
	}
	private connect(): void {
		if (this.stopped) return;
		this.update("connecting");
		const socket = new WebSocket(socketUrl(this.options.origin, "/host", this.options.access.hostId), {
			headers: { Authorization: `Bearer ${this.options.token}` }, agent: this.agent,
			handshakeTimeout: 15_000, maxPayload: MAX_WIRE * 2, perMessageDeflate: false,
		});
		this.socket = socket;
		const heartbeat = () => {
			clearTimeout(this.heartbeat);
			this.heartbeat = setTimeout(() => socket.terminate(), 50_000);
			this.heartbeat.unref();
		};
		socket.on("open", () => { this.backoff = 1000; this.update("online"); heartbeat(); });
		socket.on("ping", heartbeat);
		socket.on("message", raw => {
			try {
				const message = object(JSON.parse(raw.toString()));
				if (!validId(message.peer)) throw new Error("Invalid relay peer.");
				const id = message.peer;
				if (message.type === "opened") {
					if (this.peers.has(id) || this.peers.size >= 32) throw new Error("Too many relay peers.");
					const peer: Peer = { id, ready: false, pending: 0, input: Promise.resolve(), events: new EventWindow(),
						timer: setTimeout(() => this.drop(id, true), 15_000) };
					this.peers.set(id, peer);
				} else if (message.type === "closed") this.drop(id);
				else if (message.type === "frame") {
					const peer = this.peers.get(id);
					if (!peer) return;
					const frame = string(message.frame, MAX_WIRE);
					if (peer.channel) peer.channel.receive(frame);
					else {
						if (++peer.pending > 4) { this.drop(id, true); return; }
						peer.input = peer.input.then(() => this.identify(peer, frame)).catch(() => this.drop(id, true)).finally(() => peer.pending--);
					}
				} else throw new Error("Invalid relay event.");
			} catch { socket.close(1008, "Invalid relay protocol"); }
		});
		socket.on("error", () => this.update("offline", "Relay connection failed. Check the address, registration token, proxy and network policy."));
		socket.on("close", () => {
			clearTimeout(this.heartbeat);
			for (const id of this.peers.keys()) this.drop(id);
			if (this.stopped) return;
			this.update("offline", this.status.error ?? "Relay disconnected. Retrying.");
			this.timer = setTimeout(() => this.connect(), this.backoff + Math.random() * 500);
			this.backoff = Math.min(30_000, this.backoff * 2);
		});
	}
	private async output(peer: string, frame: string): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error("Relay is disconnected or slow.");
		await new Promise<void>((yes, no) => socket.send(JSON.stringify({ type: "frame", peer, frame }), error => error ? no(error) : yes()));
	}
	private async identify(peer: Peer, wire: string): Promise<void> {
		if (peer.channel || !this.peers.has(peer.id)) throw new Error("Duplicate identity.");
		const message = object(JSON.parse(wire));
		if (message.type !== "identify" || !validId(message.device)) throw new Error("Invalid identity.");
		if (message.protocol !== PROTOCOL_VERSION || !apiMatches(message.api) || !validSecret(message.nonce)) {
			await this.output(peer.id, JSON.stringify({ type: "upgrade-required", api: API_VERSION }));
			this.drop(peer.id, true, 4003); return;
		}
		const device = this.options.access.remote(message.device);
		if (!device) {
			await this.output(peer.id, JSON.stringify({ type: "denied" }));
			this.drop(peer.id, true); return;
		}
		peer.device = device;
		const challenge = newSecret();
		peer.channel = await SecureChannel.create({ secret: device.key, challenge, clientNonce: message.nonce,
			host: this.options.access.hostId, device: device.id, role: "host" },
			frame => this.output(peer.id, frame), payload => { void this.message(peer, payload).catch(() => this.drop(peer.id, true)); },
			() => this.drop(peer.id, true, 1013));
		if (!this.peers.has(peer.id)) { peer.channel.close(); return; }
		await this.output(peer.id, JSON.stringify({ type: "challenge", protocol: PROTOCOL_VERSION, api: API_VERSION, nonce: challenge, pairing: !!device.expires }));
	}
	private async message(peer: Peer, raw: unknown): Promise<void> {
		if (!this.peers.has(peer.id)) return;
		const message = object(raw);
		const device = peer.device!;
		const current = this.options.access.remote(device.id);
		if (!current) throw new Error("Device revoked.");
		if (!peer.ready) {
			if (message.type !== "hello") throw new Error("Expected device proof.");
			if (!apiMatches(message.api)) {
				await peer.channel!.send({ type: "upgrade-required", api: API_VERSION });
				this.drop(peer.id, true, 4003); return;
			}
			if (device.expires) this.options.access.claimRemote(device.id, device.key, string(message.key, 100), string(message.label, 100));
			else if (current.key !== device.key) throw new Error("Device key changed.");
			peer.ready = true; clearTimeout(peer.timer);
			await peer.channel!.send({ type: "ready", release: RELEASE } satisfies RemotePayload);
			if (!this.peers.has(peer.id)) return;
			peer.unwatch = this.options.watch(event => {
				if (!this.peers.has(peer.id)) return;
				const sequence = peer.events.reserve(event);
				if (sequence === undefined) { this.drop(peer.id, true, 1013); return; }
				void peer.channel!.send({ type: "event", sequence, event } satisfies RemotePayload).catch(() => this.drop(peer.id, true, 1013));
			});
			if (!this.peers.has(peer.id)) peer.unwatch();
			return;
		}
		if (message.type === "events_ack") { peer.events.acknowledge(message.sequence); return; }
		if (message.type !== "request" || !validId(message.id) || peer.pending >= 32) throw new Error("Invalid remote request.");
		const request = object(message.request);
		if ((request.method !== "GET" && request.method !== "POST") || typeof request.path !== "string" || request.path.length > 5000 ||
			!request.path.startsWith("/api/") || Buffer.byteLength(JSON.stringify(request)) > 1_100_000) throw new Error("Invalid remote request.");
		peer.pending++;
		try {
			const response = await this.options.request(device.id, {
				method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: object(request.body) }),
			});
			if (this.peers.has(peer.id)) await peer.channel!.send({ type: "response", id: message.id, response } satisfies RemotePayload);
		} finally { peer.pending--; }
	}
	private drop(id: string, notify = false, code = 4001): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		this.peers.delete(id); clearTimeout(peer.timer); peer.channel?.close(); peer.unwatch?.();
		if (notify && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "close", peer: id, code }));
	}
	close(): void {
		this.stopped = true; clearTimeout(this.timer); clearTimeout(this.heartbeat);
		this.unrevoke();
		for (const id of this.peers.keys()) this.drop(id);
		this.socket?.terminate(); this.agent.destroy();
	}
}

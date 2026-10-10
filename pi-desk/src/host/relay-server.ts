import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_WIRE, validId, newSecret, PROTOCOL_VERSION } from "../shared/secure-channel.ts";
import { remoteOrigins } from "../shared/relay-protocol.ts";
import { securityHeaders } from "./static.ts";
import { parseArgs } from "node:util";
import { MINIMUM_NODE, RELEASE, supportsNode } from "../shared/release.ts";
import { accountConfiguration, accountOrigin, type AccountConfiguration } from "../shared/account.ts";
import { CredentialVerifier, type DeviceCredential } from "../shared/device-credential.ts";
import { verifyHostAdmission } from "../shared/account-channel.ts";
import { AccountNetwork } from "./account-network.ts";

export async function runRelay(args: string[]): Promise<void> {
	if (!supportsNode(process.versions.node)) throw new Error(`Pi Desk requires Node ${MINIMUM_NODE} or later; this process uses ${process.version}.`);
	const { values } = parseArgs({ args, options: {
		port: { type: "string", default: "8920" }, listen: { type: "string", default: "127.0.0.1" }, origin: { type: "string" },
		"app-origin": { type: "string" },
		account: { type: "string" },
	} });
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
	if (!values.account) throw new Error("Set --account to the account authority.");
	const network = new AccountNetwork(), origin = accountOrigin(values.account);
	let relay: RelayServer;
	try {
		const response = await network.request<AccountConfiguration>("GET", `${origin}/config`);
		if (response.status !== 200) throw new Error("Account configuration unavailable.");
		const account = accountConfiguration(response.body);
		if (account.origin !== origin) throw new Error("Account authority mismatch.");
		relay = new RelayServer({ origin: values.origin ?? `http://127.0.0.1:${port}`,
			appOrigin: values["app-origin"] ?? account.appOrigins[0], account, verifier: network.verifier(account) });
		await relay.start(port, values.listen);
	} catch (error) { network.close(); throw error; }
	console.log(`Pi Desk relay: ${relay.origin}`);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void relay.close().then(() => { network.close(); process.exit(0); }, () => { network.close(); process.exit(1); });
	};
	process.once("SIGINT", close); process.once("SIGTERM", close);
}

interface Room { socket: WebSocket; peers: Map<string, WebSocket>; parties: Set<string>; partyEnabled: boolean; credential: DeviceCredential; connector: boolean }
interface ConnectorCall { room: Room; finish: (status: number, headers: Record<string, string>, body: string) => void }
const CONNECTOR_BODY = 256 * 1024;
/** Response headers a host may set on connector responses; everything else stays the relay's. */
const CONNECTOR_HEADERS = ["content-type", "location", "www-authenticate", "cache-control"];
function requestUrl(target: string | undefined, origin: string): URL | undefined {
	try {
		const url = new URL(target ?? "/", origin);
		return url.origin === origin ? url : undefined;
	} catch { return; }
}
export class RelayServer {
	private rooms = new Map<string, Room>();
	private sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE * 2, perMessageDeflate: false });
	private connectorCalls = new Map<string, ConnectorCall>();
	private server = createServer((request, response) => {
		securityHeaders(response);
		if (request.headers.host !== new URL(this.origin).host) { response.writeHead(403); response.end(); return; }
		const url = requestUrl(request.url, this.origin);
		if (!url) { response.writeHead(400); response.end(); return; }
		const path = url.pathname;
		// MCP and its OAuth endpoints for one opted-in host: /connector/<device>[/...] and /.well-known/<doc>/connector/<device>.
		const connector = /^\/connector\/([^/]+)(\/.*)?$/.exec(path) ?? /^(\/\.well-known\/[a-z-]+)\/connector\/([^/]+)$/.exec(path);
		if (connector) {
			const [device, subpath] = path.startsWith("/connector/") ? [connector[1]!, connector[2] ?? ""] : [connector[2]!, connector[1]!];
			this.connector(device, subpath, url.search, request, response); return;
		}
		if (request.method !== "GET") { response.writeHead(403); response.end(); return; }
		if (path === "/health") {
			response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(JSON.stringify({ status: "ok", appOrigin: this.appOrigin, ...RELEASE }));
		} else { response.writeHead(404); response.end(); }
	});
	private timer?: ReturnType<typeof setInterval>;
	private alive = new WeakSet<WebSocket>();
	private count = 0;
	private verifier: CredentialVerifier;
	origin: string;
	appOrigin: string;

	constructor(options: { origin: string; appOrigin: string; account: AccountConfiguration; verifier?: CredentialVerifier }) {
		const origins = remoteOrigins(options.origin, options.appOrigin);
		this.origin = origins.origin; this.appOrigin = origins.appOrigin;
		const account = accountConfiguration(options.account);
		if (account.relayOrigin !== this.origin || !account.appOrigins.includes(this.appOrigin)
			|| account.origin === this.origin || account.origin === this.appOrigin) throw new Error("Invalid account service separation.");
		this.verifier = options.verifier ?? new CredentialVerifier(account);
		this.server.on("upgrade", (request, socket, head) => {
			const reject = (code: number) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
			const url = requestUrl(request.url, this.origin);
			if (!url) { reject(400); return; }
			const host = url.searchParams.get("host");
			if (request.headers.host !== new URL(this.origin).host || !validId(host) || this.count >= 256) { reject(403); return; }
			if (url.pathname === "/host") {
				if (request.headers.origin || request.headers.authorization) { reject(403); return; }
				if (this.rooms.has(host)) { reject(409); return; }
				this.sockets.handleUpgrade(request, socket, head, ws => this.admit(host, ws));
			} else if (url.pathname === "/connect") {
				const room = this.rooms.get(host);
				if (request.headers.origin !== this.appOrigin || !room || room.peers.size + room.parties.size >= 32) { reject(403); return; }
				this.sockets.handleUpgrade(request, socket, head, ws => this.client(room, ws));
			} else reject(404);
		});
	}

	async start(port = 8920, address = "127.0.0.1"): Promise<void> {
		await new Promise<void>((yes, no) => { this.server.once("error", no); this.server.listen(port, address, () => { this.server.off("error", no); yes(); }); });
		this.timer = setInterval(() => {
			for (const room of this.rooms.values()) if (room.credential.expires <= Date.now() / 1000) {
				room.socket.close(4001, "Host authorization expired");
			}
			for (const socket of this.sockets.clients) {
				if (!this.alive.has(socket)) { socket.terminate(); continue; }
				this.alive.delete(socket); socket.ping();
			}
		}, 20_000);
		this.timer.unref();
	}
	private track(socket: WebSocket): void {
		this.count++; this.alive.add(socket);
		socket.on("pong", () => this.alive.add(socket));
		socket.on("error", () => socket.terminate());
		socket.once("close", () => this.count--);
	}
	private send(socket: WebSocket, value: unknown): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.terminate(); return; }
		socket.send(typeof value === "string" ? value : JSON.stringify(value));
	}
	private admit(id: string, socket: WebSocket): void {
		this.track(socket);
		const nonce = newSecret();
		const deadline = setTimeout(() => socket.close(4001, "Host authorization required"), 15_000);
		deadline.unref();
		socket.once("close", () => clearTimeout(deadline));
		let pending = false;
		const identify = (raw: import("ws").RawData, binary: boolean) => {
			const text = raw.toString();
			if (pending || binary || text.length > 12_000) { socket.close(1008, "Invalid admission"); return; }
			pending = true;
			void (async () => {
				const credential = await verifyHostAdmission(JSON.parse(text), this.origin, nonce, id, this.verifier);
				if (socket.readyState !== WebSocket.OPEN) return;
				if (this.rooms.has(id)) throw new Error("Host already connected.");
				clearTimeout(deadline); socket.off("message", identify);
				this.host(id, socket, credential);
				this.send(socket, { type: "admitted", protocol: PROTOCOL_VERSION });
				this.announceHosts();
			})().catch(() => socket.close(4001, "Host authorization failed"));
		};
		socket.on("message", identify);
		this.send(socket, { type: "admission", protocol: PROTOCOL_VERSION, nonce });
	}
	private host(id: string, socket: WebSocket, credential: DeviceCredential): void {
		const room: Room = { socket, peers: new Map(), parties: new Set(), partyEnabled: false, credential, connector: false }; this.rooms.set(id, room);
		let renewing = false;
		socket.on("message", (raw, binary) => {
			try {
				if (binary) throw new Error("Expected a routed frame.");
				if (room.credential.expires <= Date.now() / 1000) throw new Error("Host authorization expired.");
				const message = JSON.parse(raw.toString());
				if (message.type === "renew") {
					if (renewing || typeof message.credential !== "string") throw new Error("Invalid credential renewal.");
					renewing = true;
					void this.verifier.verify(message.credential, "host", id).then(current => {
						if (current.thumbprint !== room.credential.thumbprint) throw new Error("Host key changed.");
						room.credential = current;
						this.send(socket, { type: "renewed", expires: current.expires });
					}).catch(() => socket.close(4001, "Host authorization failed")).finally(() => { renewing = false; });
					return;
				}
				if (message.type === "party-enable") { room.partyEnabled = true; this.announceHosts(); return; }
				if (message.type === "connector-enable") { room.connector = message.enabled === true; return; }
				if (message.type === "connector-result") {
					const call = this.connectorCalls.get(String(message.id));
					if (!call || call.room !== room || !Number.isInteger(message.status) || message.status < 200 || message.status > 599
						|| typeof message.body !== "string" || message.body.length > CONNECTOR_BODY) return;
					const headers: Record<string, string> = {};
					for (const name of CONNECTOR_HEADERS) {
						const value = message.headers?.[name];
						if (typeof value === "string" && value.length <= 2000 && !/[\r\n]/.test(value)) headers[name] = value;
					}
					call.finish(message.status, headers, message.body); return;
				}
				if (message.type === "party-open") {
					if (!room.partyEnabled) throw new Error("Party transport is not enabled.");
					if (!validId(message.peer) || message.peer === id) throw new Error("Invalid party computer.");
					const target = this.rooms.get(message.peer);
					if (!target?.partyEnabled || target.credential.expires <= Date.now() / 1000) return;
					if (room.parties.has(message.peer)) return;
					if (room.parties.size + room.peers.size >= 32 || target.parties.size + target.peers.size >= 32) return;
					room.parties.add(message.peer); target.parties.add(id);
					this.send(target.socket, { type: "opened", peer: id, purpose: "party", initiator: false });
					this.send(socket, { type: "opened", peer: message.peer, purpose: "party", initiator: true });
					return;
				}
				if (!validId(message.peer)) throw new Error("Invalid peer.");
				if (message.type === "party-frame" || message.type === "party-close") {
					if (!room.parties.has(message.peer)) return;
					const target = this.rooms.get(message.peer);
					if (!target || !target.parties.has(id) || target.credential.expires <= Date.now() / 1000) return;
					if (message.type === "party-close") this.closeParty(id, message.peer);
					else if (typeof message.frame === "string" && Buffer.byteLength(message.frame) <= MAX_WIRE) {
						this.send(target.socket, { type: "frame", peer: id, frame: message.frame });
					} else throw new Error("Invalid party frame.");
					return;
				}
				const peer = room.peers.get(message.peer);
				if (!peer) return;
				if (message.type === "close") peer.close([1000, 1012, 1013, 4001, 4002, 4003].includes(message.code) ? message.code : 4002, "Device connection closed");
				else if (message.type === "frame" && typeof message.frame === "string" && message.frame.length <= MAX_WIRE) this.send(peer, message.frame);
				else throw new Error("Invalid routed frame.");
			} catch { socket.close(1008, "Invalid protocol"); }
		});
		socket.once("close", () => {
			if (this.rooms.get(id) !== room) return;
			this.rooms.delete(id);
			for (const call of [...this.connectorCalls.values()]) if (call.room === room) call.finish(503, {}, JSON.stringify({ error: "The computer disconnected." }));
			for (const peer of room.peers.values()) peer.close(1012, "Host disconnected");
			for (const other of room.parties) this.closeParty(id, other);
			this.announceHosts();
		});
	}
	/** Forward a connector request to the opted-in host. The host authenticates it; the relay only routes. */
	private connector(device: string, subpath: string, search: string, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): void {
		if (request.method !== "GET" && request.method !== "POST") { response.writeHead(405, { Allow: "GET, POST" }); response.end(); return; }
		const room = validId(device) ? this.rooms.get(device) : undefined;
		if (!room?.connector || room.credential.expires <= Date.now() / 1000) { response.writeHead(404); response.end(); return; }
		const chunks: Buffer[] = []; let size = 0, done = false, timer: ReturnType<typeof setTimeout> | undefined, id: string | undefined;
		const finish = (status: number, headers: Record<string, string>, body: string) => {
			if (done) return; done = true;
			clearTimeout(timer); if (id) this.connectorCalls.delete(id);
			response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); response.end(body);
		};
		const failure = (status: number, error: string) => finish(status, {}, JSON.stringify({ error }));
		request.on("data", chunk => { size += chunk.length; if (size > CONNECTOR_BODY) { request.destroy(); failure(413, "Request too large."); } else chunks.push(chunk); });
		request.on("end", () => {
			if (done) return;
			id = randomUUID();
			timer = setTimeout(() => failure(504, "The computer did not answer in time."), 30_000);
			this.connectorCalls.set(id, { room, finish });
			const header = (name: string) => { const value = request.headers[name]; return typeof value === "string" ? value.slice(0, 8000) : undefined; };
			this.send(room.socket, { type: "connector", id, method: request.method, path: subpath.slice(0, 200), query: search.slice(0, 4000),
				headers: { authorization: header("authorization"), "content-type": header("content-type") }, body: Buffer.concat(chunks).toString("utf8") });
		});
	}
	private announceHosts(): void {
		const hosts = [...this.rooms].filter(([, room]) => room.partyEnabled).map(([id]) => id);
		for (const room of this.rooms.values()) if (room.partyEnabled) this.send(room.socket, { type: "hosts", hosts });
	}
	private closeParty(id: string, other: string): void {
		const room = this.rooms.get(id), target = this.rooms.get(other);
		room?.parties.delete(other); target?.parties.delete(id);
		if (room) this.send(room.socket, { type: "closed", peer: other });
		if (target) this.send(target.socket, { type: "closed", peer: id });
	}
	private client(room: Room, socket: WebSocket): void {
		if (room.credential.expires <= Date.now() / 1000) { socket.close(1012, "Host authorization expired"); return; }
		this.track(socket);
		const id = randomUUID(); room.peers.set(id, socket);
		this.send(room.socket, { type: "opened", peer: id });
		socket.on("message", (raw, binary) => {
			if (room.credential.expires <= Date.now() / 1000) { socket.close(1012, "Host authorization expired"); return; }
			const frame = raw.toString();
			if (binary || Buffer.byteLength(frame) > MAX_WIRE) { socket.close(1009, "Frame too large"); return; }
			this.send(room.socket, { type: "frame", peer: id, frame });
		});
		socket.once("close", () => { room.peers.delete(id); this.send(room.socket, { type: "closed", peer: id }); });
	}
	async close(): Promise<void> {
		clearInterval(this.timer);
		for (const socket of this.sockets.clients) socket.terminate();
		await new Promise<void>(resolve => this.sockets.close(() => resolve()));
		await new Promise<void>(resolve => this.server.close(() => resolve()));
	}
}

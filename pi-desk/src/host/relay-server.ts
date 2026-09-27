import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_WIRE, validId } from "../shared/secure-channel.ts";
import { relayOrigin } from "../shared/relay-protocol.ts";
import { securityHeaders, serveClient } from "./static.ts";
import { parseArgs } from "node:util";
import { MINIMUM_NODE, RELEASE, supportsNode } from "../shared/release.ts";
import { inspectAppAssets } from "./app-assets.ts";

export async function runRelay(args: string[]): Promise<void> {
	if (!supportsNode(process.versions.node)) throw new Error(`Pi Desk requires Node ${MINIMUM_NODE} or later; this process uses ${process.version}.`);
	const { values } = parseArgs({ args, options: {
		port: { type: "string", default: "8920" }, listen: { type: "string", default: "127.0.0.1" }, origin: { type: "string" },
	} });
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
	inspectAppAssets();
	const relay = new RelayServer({ origin: values.origin ?? `http://127.0.0.1:${port}`, token: process.env.PI_DESK_RELAY_TOKEN ?? "" });
	await relay.start(port, values.listen);
	console.log(`Pi Desk relay: ${relay.origin}`);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void relay.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
	};
	process.once("SIGINT", close); process.once("SIGTERM", close);
}

interface Room { socket: WebSocket; peers: Map<string, WebSocket> }
function requestUrl(target: string | undefined, origin: string): URL | undefined {
	try {
		const url = new URL(target ?? "/", origin);
		return url.origin === origin ? url : undefined;
	} catch { return; }
}
export class RelayServer {
	private rooms = new Map<string, Room>();
	private sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE * 2, perMessageDeflate: false });
	private server = createServer((request, response) => {
		securityHeaders(response);
		if (request.method !== "GET" || request.headers.host !== new URL(this.origin).host) { response.writeHead(403); response.end(); return; }
		const url = requestUrl(request.url, this.origin);
		if (!url) { response.writeHead(400); response.end(); return; }
		const path = url.pathname;
		if (path === "/health" || path === "/api/transport") {
			response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(JSON.stringify(path === "/health" ? { status: "ok", ...RELEASE } : { kind: "relay", ...RELEASE }));
		} else if (path.startsWith("/api/")) { response.writeHead(404); response.end(); }
		else void serveClient(this.clientDir, path, response);
	});
	private clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
	private timer?: ReturnType<typeof setInterval>;
	private alive = new WeakSet<WebSocket>();
	private count = 0;
	private tokenHash: Buffer;
	origin: string;

	constructor(options: { origin: string; token: string }) {
		this.origin = relayOrigin(options.origin);
		if (options.token.length < 32) throw new Error("Set PI_DESK_RELAY_TOKEN to a random secret of at least 32 characters.");
		this.tokenHash = createHash("sha256").update(options.token).digest();
		this.server.on("upgrade", (request, socket, head) => {
			const reject = (code: number) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
			const url = requestUrl(request.url, this.origin);
			if (!url) { reject(400); return; }
			const host = url.searchParams.get("host");
			if (request.headers.host !== new URL(this.origin).host || !validId(host) || this.count >= 256) { reject(403); return; }
			if (url.pathname === "/host") {
				const provided = createHash("sha256").update((request.headers.authorization ?? "").replace(/^Bearer /, "")).digest();
				if (!timingSafeEqual(provided, this.tokenHash) || request.headers.origin) { reject(403); return; }
				if (this.rooms.has(host)) { reject(409); return; }
				this.sockets.handleUpgrade(request, socket, head, ws => this.host(host, ws));
			} else if (url.pathname === "/connect") {
				const room = this.rooms.get(host);
				if (request.headers.origin !== this.origin || !room || room.peers.size >= 32) { reject(403); return; }
				this.sockets.handleUpgrade(request, socket, head, ws => this.client(room, ws));
			} else reject(404);
		});
	}

	async start(port = 8920, address = "127.0.0.1"): Promise<void> {
		await new Promise<void>((yes, no) => { this.server.once("error", no); this.server.listen(port, address, () => { this.server.off("error", no); yes(); }); });
		this.timer = setInterval(() => {
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
	private host(id: string, socket: WebSocket): void {
		this.track(socket);
		const room: Room = { socket, peers: new Map() }; this.rooms.set(id, room);
		socket.on("message", (raw, binary) => {
			try {
				if (binary) throw new Error("Expected a routed frame.");
				const message = JSON.parse(raw.toString());
				if (!validId(message.peer)) throw new Error("Invalid peer.");
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
			for (const peer of room.peers.values()) peer.close(1012, "Host disconnected");
		});
	}
	private client(room: Room, socket: WebSocket): void {
		this.track(socket);
		const id = randomUUID(); room.peers.set(id, socket);
		this.send(room.socket, { type: "opened", peer: id });
		socket.on("message", (raw, binary) => {
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

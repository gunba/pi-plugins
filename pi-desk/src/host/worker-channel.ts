import { createServer, createConnection, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { WorkerMessage, WorkerRequest } from "../shared/protocol.ts";
import { WorkerConnectionError } from "./worker-errors.ts";

const PROTOCOL = 1;
const MAX_FRAME = 8 * 1024 * 1024;
const failures = new WeakMap<Socket, WorkerConnectionError>();
function disconnect(socket: Socket, message: string): void {
	failures.set(socket, new WorkerConnectionError(message)); socket.destroy();
}
export interface WorkerEndpointIdentity { instance: string; secret: string }
export interface WorkerEndpointAddress extends WorkerEndpointIdentity { port: number }

interface PendingFrame { frame: string; bytes: number; replacement?: string }
class FrameWriter {
	private pending: PendingFrame[] = [];
	private bytes = 0;
	private blocked = false;
	private socket: Socket;
	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("drain", () => { this.blocked = false; this.flush(); });
		socket.once("close", () => { this.pending = []; this.bytes = 0; });
	}
	send(value: unknown): void {
		if (this.socket.destroyed || this.socket.writableEnded) return;
		const frame = JSON.stringify(value) + "\n", bytes = Buffer.byteLength(frame);
		if (bytes > MAX_FRAME) { disconnect(this.socket, "A worker message exceeded the 8 MiB channel limit."); return; }
		const snapshot = object(value) && object(value.snapshot) ? value.snapshot : undefined;
		const generation = object(value) && value.type === "snapshot" && object(snapshot?.ui)
			? snapshot.ui.generation : snapshot?.generation;
		const replacement = object(value) && ["snapshot", "ui"].includes(String(value.type)) && typeof generation === "string"
			? `${value.type}:${generation}` : undefined;
		// Only adjacent, complete views of the same generation replace each other.
		// Commands, receipts, transcript events and generation boundaries stay ordered.
		const last = this.pending.at(-1);
		if (replacement && last?.replacement === replacement) {
			this.bytes -= last.bytes; this.pending.pop();
		}
		if (this.bytes + bytes > MAX_FRAME) { disconnect(this.socket, "The worker connection could not drain its pending messages."); return; }
		this.pending.push({ frame, bytes, replacement }); this.bytes += bytes;
		this.flush();
	}
	private flush(): void {
		while (!this.blocked && this.pending.length && !this.socket.destroyed && !this.socket.writableEnded) {
			const next = this.pending.shift()!; this.bytes -= next.bytes;
			this.blocked = !this.socket.write(next.frame);
		}
	}
}
const writers = new WeakMap<Socket, FrameWriter>();
function write(socket: Socket, value: unknown): void {
	let writer = writers.get(socket);
	if (!writer) { writer = new FrameWriter(socket); writers.set(socket, writer); }
	writer.send(value);
}

function frames(socket: Socket, limit: () => number, receive: (value: unknown) => void): void {
	let pending = Buffer.alloc(0);
	socket.on("data", chunk => {
		let handling = false;
		try {
			pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
			for (;;) {
				const end = pending.indexOf(10);
				if ((end < 0 ? pending.length : end) > limit()) { disconnect(socket, "An incoming worker message exceeded the channel limit."); return; }
				if (end < 0) break;
				const value: unknown = JSON.parse(pending.subarray(0, end).toString("utf8"));
				pending = pending.subarray(end + 1);
				handling = true; receive(value); handling = false;
				if (socket.destroyed) break;
			}
		} catch (error) {
			if (handling) console.error("Worker message handling failed:", error);
			disconnect(socket, handling ? "The host could not handle a worker update. Details are in the host log." : "The worker connection received invalid JSON.");
		}
	});
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function request(value: unknown): value is WorkerRequest {
	if (!object(value) || typeof value.id !== "string" || !value.id.length || value.id.length > 128) return false;
	if (value.type === "shutdown") return value.force === undefined || typeof value.force === "boolean";
	if (value.type === "describe") return true;
	if (value.type === "receipt") return typeof value.target === "string" && value.target.length <= 128 && (value.wait === undefined || typeof value.wait === "boolean");
	if (value.type === "init") return object(value.options) && typeof value.options.cwd === "string";
	if (value.type === "checkpoint") return typeof value.checkpoint === "string" && ["inspect", "hold", "release"].includes(String(value.action));
	return (value.type === "command" || value.type === "control") && typeof value.generation === "string" && object(value.command) && typeof value.command.kind === "string";
}

/** A dropped host connection releases its subscription, not the native session. */
export class WorkerEndpoint {
	private server: Server;
	private sockets = new Set<Socket>();
	private controller?: Socket;
	private closing?: Promise<void>;
	readonly address: WorkerEndpointAddress;

	private constructor(server: Server, address: WorkerEndpointAddress) { this.server = server; this.address = address; }

	static async listen(identity: WorkerEndpointIdentity, execute: (request: WorkerRequest) => Promise<WorkerMessage>,
		attached: () => WorkerMessage[] = () => []): Promise<WorkerEndpoint> {
		if (!identity.instance || !/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error("Invalid worker endpoint identity.");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Worker endpoint is unavailable.");
		const endpoint = new WorkerEndpoint(server, { ...identity, port: address.port });
		server.on("connection", socket => {
			endpoint.sockets.add(socket);
			let authenticated = false;
			socket.setNoDelay(true);
			socket.setTimeout(5000, () => socket.destroy());
			socket.on("error", () => {});
			socket.on("close", () => {
				endpoint.sockets.delete(socket);
				if (endpoint.controller === socket) endpoint.controller = undefined;
			});
			frames(socket, () => authenticated ? MAX_FRAME : 2048, value => {
				if (!authenticated) {
					if (!object(value) || value.protocol !== PROTOCOL || value.instance !== identity.instance
						|| typeof value.secret !== "string" || !/^[a-f0-9]{64}$/.test(value.secret)
						|| !timingSafeEqual(Buffer.from(value.secret), Buffer.from(identity.secret))) { socket.destroy(); return; }
					authenticated = true;
					socket.setTimeout(0);
					endpoint.controller?.destroy();
					endpoint.controller = socket;
					write(socket, { type: "attached", protocol: PROTOCOL, instance: identity.instance });
					for (const message of attached()) write(socket, message);
					return;
				}
				if (!request(value)) { socket.destroy(); return; }
				void Promise.resolve().then(() => execute(value)).then(message => write(socket, message), () => socket.destroy());
			});
		});
		return endpoint;
	}

	publish(message: WorkerMessage): void { if (this.controller) write(this.controller, message); }
	close(graceful = false): Promise<void> {
		return this.closing ??= new Promise<void>((resolve, reject) => {
			for (const socket of this.sockets) { if (graceful) socket.end(); else socket.destroy(); }
			this.server.close(error => error ? reject(error) : resolve());
		});
	}
}

export class WorkerChannel {
	private socket: Socket;
	private constructor(socket: Socket) { this.socket = socket; }

	static connect(address: WorkerEndpointAddress, receive: (message: WorkerMessage) => void,
		disconnected: (error?: WorkerConnectionError) => void): Promise<WorkerChannel> {
		if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) return Promise.reject(new Error("Invalid worker endpoint port."));
		return new Promise((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port: address.port });
			let authenticated = false;
			const timer = setTimeout(() => socket.destroy(), 5000);
			socket.setNoDelay(true);
			socket.on("error", error => {
				const code = (error as NodeJS.ErrnoException).code;
				if (!failures.has(socket) && code && /^[A-Z_]{1,64}$/.test(code))
					failures.set(socket, new WorkerConnectionError(`The worker connection closed (${code}).`));
			});
			socket.on("close", () => {
				clearTimeout(timer);
				if (authenticated) disconnected(failures.get(socket));
				else reject(new WorkerConnectionError("Worker attachment could not be authenticated."));
			});
			socket.once("connect", () => write(socket, { protocol: PROTOCOL, instance: address.instance, secret: address.secret }));
			frames(socket, () => MAX_FRAME, value => {
				if (!authenticated) {
					if (!object(value) || value.type !== "attached" || value.protocol !== PROTOCOL || value.instance !== address.instance) { socket.destroy(); return; }
					authenticated = true;
					clearTimeout(timer);
					resolve(new WorkerChannel(socket));
				} else {
					if (!object(value) || typeof value.type !== "string") { socket.destroy(); return; }
					receive(value as unknown as WorkerMessage);
				}
			});
		});
	}

	send(request: WorkerRequest): void {
		if (this.socket.destroyed || this.socket.writableEnded) throw new WorkerConnectionError("The worker connection is no longer attached; the command outcome is unconfirmed.");
		write(this.socket, request);
	}
	detach(): Promise<void> {
		if (this.socket.destroyed) return Promise.resolve();
		return new Promise(resolve => { this.socket.once("close", resolve); this.socket.end(); });
	}
}

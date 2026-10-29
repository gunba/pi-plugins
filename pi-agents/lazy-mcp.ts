/**
 * MCP transports that start a stdio server only when a session first needs it and stop it once it
 * has been idle.
 *
 * Pi connects every configured server when a session starts and keeps it until the session closes,
 * so every Desk conversation and every secondary agent held its own copy of every server process,
 * used or not. A lazy transport stays open to the session while the process comes and goes:
 * `initialize` and the first page of `tools/list` are answered from the server's last answers,
 * cached on disk per configuration; any other request starts the server, and the server is stopped
 * once nothing has been in flight for the idle time. HTTP servers hold no process and connect as
 * usual.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type McpTransportFactory } from "@earendil-works/pi-coding-agent";

type Transport = ReturnType<McpTransportFactory>;
type Entry = Parameters<McpTransportFactory>[0];
type Message = Parameters<Transport["send"]>[0];
type SendOptions = Parameters<Transport["send"]>[1];
type Listener<T extends unknown[]> = (...args: T) => void;
interface Rpc { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown }

export const IDLE_MS = 10 * 60_000;
/** Older answers are not trusted: the session waits for the server once, which refreshes them. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Cache files of configurations unused this long are deleted when another is written. */
const CACHE_PRUNE_MS = 7 * 24 * 60 * 60_000;
/** Ids of the requests the transport sends itself, which the session never sees answered. */
const OWN_ID = "pi-lazy-mcp:";

interface CachedAnswers {
	/** `protocolVersion` the session asked for; the cached `initialize` answers only that. */
	requested: string;
	initialize: Record<string, unknown>;
	tools?: Record<string, unknown>;
}

export interface LazyMcpOptions {
	idleMs?: number;
	cacheDir?: string;
}

/**
 * Transport factory for `createMcpExtension`. Pi's own transport for a configuration is built
 * through its runtime module, which its package does not export, so it is loaded once here.
 */
export async function lazyMcpTransports(options: LazyMcpOptions = {}): Promise<McpTransportFactory> {
	const runtime = await import(new URL("./extensions/mcp/runtime.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as { createDefaultTransport: McpTransportFactory };
	const create = runtime.createDefaultTransport;
	const cacheDir = options.cacheDir ?? join(getAgentDir(), "mcp-cache");
	return (entry, cwd, authProvider) => "url" in entry.config
		? create(entry, cwd, authProvider)
		: new LazyTransport(() => create(entry, cwd, undefined), join(cacheDir, `${cacheKey(entry, cwd)}.json`), options.idleMs ?? IDLE_MS, timeoutMs(entry));
}

function cacheKey(entry: Entry, cwd: string): string {
	return createHash("sha256").update(JSON.stringify([entry.name, entry.config, cwd])).digest("hex").slice(0, 32);
}

function timeoutMs(entry: Entry): number {
	const seconds = (entry.config as { timeout?: number }).timeout;
	return (typeof seconds === "number" && seconds > 0 ? seconds : 60) * 1000;
}

export class LazyTransport implements Transport {
	private readonly messageListeners = new Set<Listener<[Message]>>();
	private readonly errorListeners = new Set<Listener<[Error]>>();
	private readonly closeListeners = new Set<Listener<[]>>();
	private server: Transport | undefined;
	private starting: Promise<Transport> | undefined;
	/** Servers this transport closed itself, whose exit the session must not see. */
	private readonly stopped = new WeakSet<Transport>();
	/** Client requests the server has not answered (`c:<id>`) and server requests the client has not (`s:<id>`). */
	private readonly inflight = new Set<string>();
	private readonly toolLists = new Set<string | number>();
	private readonly ownReplies = new Map<string, (message: Rpc) => void>();
	private ownId = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private initializeParams: Record<string, unknown> | undefined;
	private protocolVersion: string | undefined;
	private cachedTools = false;
	private closed = false;
	private cache: CachedAnswers | undefined;

	private readonly create: () => Transport;
	private readonly cachePath: string;
	private readonly idleMs: number;
	private readonly requestTimeoutMs: number;

	constructor(create: () => Transport, cachePath: string, idleMs: number, requestTimeoutMs: number) {
		this.create = create;
		this.cachePath = cachePath;
		this.idleMs = idleMs;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	/** Pid of the running server process, if any; for diagnostics and tests. */
	get pid(): number | undefined {
		return (this.server as { pid?: number } | undefined)?.pid;
	}

	async start(): Promise<void> {
		this.cache = readCache(this.cachePath);
	}

	async send(message: Message, options?: SendOptions): Promise<void> {
		if (this.closed) throw new Error("MCP transport is closed");
		const rpc = message as Rpc;
		if (rpc.method !== undefined && rpc.id !== undefined) {
			if (rpc.method === "initialize") return this.initialize(rpc);
			if (!this.server) {
				if (rpc.method === "ping") return this.reply(rpc.id, {});
				if (rpc.method === "tools/list" && !rpc.params?.cursor && this.cache?.tools) {
					this.cachedTools = true;
					return this.reply(rpc.id, this.cache.tools);
				}
			}
			const server = this.server ?? await this.ensureServer();
			if (options?.signal?.aborted || this.closed) return;
			this.inflight.add(`c:${rpc.id}`);
			if (rpc.method === "tools/list" && !rpc.params?.cursor) this.toolLists.add(rpc.id);
			this.touch();
			try {
				await server.send(message, options);
			} catch (error) {
				this.inflight.delete(`c:${rpc.id}`);
				this.touch();
				throw error;
			}
			return;
		}
		if (rpc.method !== undefined) {
			// The handshake with each server sends its own `initialized`.
			if (rpc.method === "notifications/initialized") return;
			if (rpc.method === "notifications/cancelled") {
				this.inflight.delete(`c:${rpc.params?.requestId}`);
				this.touch();
			}
		} else if (rpc.id !== undefined) {
			this.inflight.delete(`s:${rpc.id}`);
			this.touch();
		}
		// A stopped server has nothing to be told.
		await this.server?.send(message, options);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idleTimer);
		const server = this.server;
		this.server = undefined;
		if (server) await this.stop(server);
		for (const listener of this.closeListeners) listener();
	}

	onMessage(listener: Listener<[Message]>): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onError(listener: Listener<[Error]>): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onClose(listener: Listener<[]>): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
		(this.server as Transport | undefined)?.setProtocolVersion?.(version);
	}

	private async initialize(rpc: Rpc): Promise<void> {
		this.initializeParams = rpc.params;
		const cache = this.cache;
		if (cache && cache.requested === rpc.params?.protocolVersion) return this.reply(rpc.id!, cache.initialize);
		await this.ensureServer();
		this.reply(rpc.id!, this.cache!.initialize);
	}

	private ensureServer(): Promise<Transport> {
		return this.starting ??= this.spawn().catch((error) => {
			this.starting = undefined;
			throw error;
		});
	}

	private async spawn(): Promise<Transport> {
		const server = this.create();
		server.onMessage((message) => this.fromServer(server, message as Rpc));
		server.onError((error) => { for (const listener of this.errorListeners) listener(error); });
		server.onClose(() => this.serverClosed(server));
		try {
			await server.start();
			const initialize = await this.request(server, "initialize", this.initializeParams);
			const version = initialize.protocolVersion;
			if (typeof version === "string") server.setProtocolVersion?.(this.protocolVersion ?? version);
			await server.send({ jsonrpc: "2.0", method: "notifications/initialized" } as Message);
			const requested = String(this.initializeParams?.protocolVersion ?? "");
			const previous = this.cache;
			this.cache = { requested, initialize, tools: previous?.requested === requested ? previous.tools : undefined };
			if (this.cachedTools) {
				const tools = await this.request(server, "tools/list", undefined);
				if (JSON.stringify(tools) !== JSON.stringify(this.cache.tools)) {
					this.cache.tools = tools.nextCursor === undefined ? tools : undefined;
					this.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				}
			}
			writeCache(this.cachePath, this.cache);
		} catch (error) {
			await this.stop(server);
			throw error;
		}
		if (this.closed) {
			await this.stop(server);
			throw new Error("MCP transport is closed");
		}
		this.server = server;
		this.touch();
		return server;
	}

	private request(server: Transport, method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
		const id = `${OWN_ID}${++this.ownId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.ownReplies.delete(id);
				reject(new Error(`MCP server did not answer ${method} within ${this.requestTimeoutMs / 1000} s`));
			}, this.requestTimeoutMs);
			this.ownReplies.set(id, (reply) => {
				clearTimeout(timer);
				this.ownReplies.delete(id);
				if (reply.error !== undefined || !reply.result) reject(new Error(`MCP server failed ${method}: ${JSON.stringify(reply.error)}`));
				else resolve(reply.result);
			});
			server.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } as Message).catch((error) => {
				clearTimeout(timer);
				this.ownReplies.delete(id);
				reject(error);
			});
		});
	}

	private fromServer(server: Transport, message: Rpc): void {
		const own = typeof message.id === "string" && message.method === undefined ? this.ownReplies.get(message.id) : undefined;
		if (own) return own(message);
		if (this.stopped.has(server)) return;
		if (message.id !== undefined && message.method === undefined) {
			this.inflight.delete(`c:${message.id}`);
			if (this.toolLists.delete(message.id) && message.result && message.result.nextCursor === undefined && this.cache) {
				this.cache.tools = message.result;
				writeCache(this.cachePath, this.cache);
			}
		} else if (message.id !== undefined) this.inflight.add(`s:${message.id}`);
		this.touch();
		this.emit(message);
	}

	/** An exit the transport did not cause ends it, so the session reconnects as it would without it. */
	private serverClosed(server: Transport): void {
		if (this.stopped.has(server) || this.closed) return;
		for (const reply of [...this.ownReplies.values()]) reply({ jsonrpc: "2.0", error: "the server exited" });
		if (server === this.server) this.server = undefined;
		this.starting = undefined;
		void this.close();
	}

	private touch(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (!this.server || this.inflight.size || this.closed) return;
		this.idleTimer = setTimeout(() => {
			const server = this.server;
			if (!server || this.inflight.size) return;
			this.server = undefined;
			this.starting = undefined;
			this.toolLists.clear();
			void this.stop(server);
		}, this.idleMs);
		this.idleTimer.unref?.();
	}

	private async stop(server: Transport): Promise<void> {
		this.stopped.add(server);
		await server.close().catch(() => undefined);
	}

	private reply(id: string | number, result: Record<string, unknown>): void {
		queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, result }));
	}

	private emit(message: Rpc): void {
		for (const listener of this.messageListeners) listener(message as Message);
	}
}

function readCache(path: string): CachedAnswers | undefined {
	try {
		if (Date.now() - statSync(path).mtimeMs > CACHE_MAX_AGE_MS) return undefined;
		const cache = JSON.parse(readFileSync(path, "utf8")) as CachedAnswers;
		return typeof cache.requested === "string" && cache.initialize ? cache : undefined;
	} catch {
		return undefined;
	}
}

function writeCache(path: string, cache: CachedAnswers): void {
	try {
		const dir = join(path, "..");
		mkdirSync(dir, { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(cache));
		renameSync(temporary, path);
		const now = Date.now();
		for (const name of readdirSync(dir)) {
			const file = join(dir, name);
			if (now - statSync(file).mtimeMs > CACHE_PRUNE_MS) unlinkSync(file);
		}
	} catch {
		// The cache only saves a start; the next session asks the server again.
	}
}

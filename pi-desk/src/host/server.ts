import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AccessStore } from "./access.ts";
import { commandFrom, object, string } from "./commands.ts";
import { SessionWorker } from "./worker-client.ts";
import type { HostEvent, HostState, SessionView, WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import { RelayConnector, type RelayStatus, type RemoteAccess } from "./relay-connector.ts";
import { readAccount } from "./account-config.ts";
import type { NativeAccountIdentity } from "./account-identity.ts";
import { securityHeaders, serveClient } from "./static.ts";
import { readSessionHeader, SessionCatalog } from "./session-files.ts";
import { SavedSessionIndex, CatalogChanged } from "./saved-sessions.ts";
import { isControl } from "../shared/controls.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "./worker-errors.ts";
import { HostControl, removeHostRecord, type HostStatus } from "./host-control.ts";
import { API_HEADER, RELEASE, apiMatches, upgradeMessage } from "../shared/release.ts";

interface Options { cwd: string; port?: number; dataDir?: string; agentDir?: string; sessionDir?: string; publicOrigin?: string; proxy?: string }
interface ManagedSession { view: SessionView; worker?: SessionWorker }
interface EventClient { response: ServerResponse; device: string }
const json = (response: ServerResponse, code: number, value: unknown) => {
	response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
};
const cookie = (request: IncomingMessage) => /(?:^|;\s*)pi_desk=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "";

export class DeskHost {
	private options: Options;
	private access: AccessStore;
	private catalog?: SessionCatalog;
	private saved?: SavedSessionIndex;
	private catalogTimer?: ReturnType<typeof setTimeout>;
	private server = createServer((request, response) => { void this.handle(request, response); });
	private sessions = new Map<string, ManagedSession>();
	private clients = new Set<EventClient>();
	private watchers = new Set<(event: HostEvent) => void>();
	private relay?: RelayConnector;
	private relayStatus?: RelayStatus;
	private accountIdentity?: NativeAccountIdentity;
	private accountRevision = 0;
	private accountRetry?: ReturnType<typeof setTimeout>;
	private sequence = 0;
	private history: { id: number; frame: string }[] = [];
	private historyBytes = 0;
	private hostLease?: SessionLease;
	private heartbeat?: ReturnType<typeof setInterval>;
	private attemptWindow = new Map<string, { count: number; until: number }>();
	private closing = false;
	private closeJob?: Promise<void>;
	private control?: HostControl;
	private directory = "";
	private resolveClosed!: () => void;
	private rejectClosed!: (error: unknown) => void;
	readonly closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
	private clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
	origin = "";

	constructor(options: Options) {
		this.options = { ...options, cwd: realpathSync(options.cwd), agentDir: options.agentDir ?? getAgentDir() };
		// Access data is opened only after acquiring the host lease in start().
		this.access = undefined!;
		void this.closed.catch(() => {});
	}

	async start(): Promise<{ origin: string; pairingUrl: string }> {
		const directory = this.options.dataDir ?? join(this.options.agentDir!, "desk");
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.hostLease = new SessionLease(join(directory, "host"));
		try {
			this.access = new AccessStore(directory);
			this.catalog = new SessionCatalog(directory);
			this.saved = new SavedSessionIndex(directory, this.options.cwd, this.options.agentDir!, this.options.sessionDir,
				() => [...this.sessions.values()].flatMap(({ view }) => {
					const file = view.snapshot?.file ?? view.file;
					return file ? [dirname(file)] : [];
				}));
			for (const view of this.catalog.read()) this.sessions.set(view.key, { view });
			await new Promise<void>((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(this.options.port ?? 8910, "127.0.0.1", () => {
					this.server.off("error", reject);
					resolve();
				});
			});
			const address = this.server.address();
			if (!address || typeof address === "string") throw new Error("Cannot determine server address.");
			this.origin = `http://127.0.0.1:${address.port}`;
			this.control = new HostControl(this.origin);
			this.heartbeat = setInterval(() => {
				for (const client of this.clients) this.write(client.response, ": heartbeat\n\n");
			}, 20_000);
			this.heartbeat.unref();
			await this.connectAccount();
			this.control.publish(directory);
			return { origin: this.origin, pairingUrl: `${this.origin}/#pair=${this.access.invite()}` };
		} catch (error) {
			clearInterval(this.heartbeat);
			await this.saved?.close();
			this.relay?.close();
			clearTimeout(this.accountRetry); this.accountRevision++; this.accountIdentity?.close();
			await new Promise<void>(resolve => this.server.close(() => resolve()));
			try { if (this.control) removeHostRecord(directory, this.control.record.instance); }
			finally { this.hostLease.close(); }
			throw error;
		}
	}

	state(): HostState {
		return { release: RELEASE, name: hostname(), cwd: this.options.cwd, sessions: [...this.sessions.values()].map(item => item.view), relay: this.relayStatus };
	}

	private hostStatus(): HostStatus {
		const active = [...this.sessions.values()].filter(item => item.worker);
		return {
			release: RELEASE, instance: this.control!.record.instance, pid: process.pid, started: this.control!.record.started,
			origin: this.origin, stopping: this.closing, cwd: this.options.cwd, agentDir: this.options.agentDir!,
			sessionDir: this.options.sessionDir, relay: this.relayStatus,
			sessions: { active: active.length,
				working: active.filter(({ view }) => view.state === "starting" || view.snapshot?.activity !== "idle"
					|| view.controls?.some(control => control.state === "running")).length,
				questions: active.reduce((sum, { view }) => sum + (view.ui?.interactions.length ?? 0), 0) },
		};
	}

	private async connectAccount(): Promise<void> {
		const revision = ++this.accountRevision;
		clearTimeout(this.accountRetry); this.relay?.close(); this.relay = undefined;
		this.accountIdentity?.close(); this.accountIdentity = undefined; this.relayStatus = undefined;
		const saved = await readAccount(this.directory);
		if (this.closing || revision !== this.accountRevision) return;
		if (!saved) { this.emit({ type: "state", state: this.state() }); return; }
		const update = (status: RelayStatus) => {
			if (this.closing || revision !== this.accountRevision) return;
			this.relayStatus = status; this.emit({ type: "state", state: this.state() });
		};
		update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "connecting" });
		try {
			const { NativeAccountIdentity } = await import("./account-identity.ts");
			const identity = await NativeAccountIdentity.open(this.directory, saved.config, { proxy: this.options.proxy });
			if (this.closing || revision !== this.accountRevision) { identity.close(); return; }
			this.accountIdentity = identity;
			this.relay = new RelayConnector({ account: identity, appOrigin: saved.appOrigin, proxy: this.options.proxy,
				request: (access, request) => this.api(access, request),
				watch: handler => {
					this.watchers.add(handler); handler({ type: "state", state: this.state() });
					return () => this.watchers.delete(handler);
				}, status: update,
			});
			this.relay.start();
		} catch {
			if (this.closing || revision !== this.accountRevision) return;
			this.accountIdentity?.close(); this.accountIdentity = undefined;
			update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "offline",
				error: "Account identity is unavailable. Sign in on this computer and unlock its protected credential store." });
			this.accountRetry = setTimeout(() => { void this.connectAccount().catch(() => {}); }, 30_000);
			this.accountRetry.unref();
		}
	}

	private write(response: ServerResponse, frame: string): void {
		if (response.destroyed) return;
		if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
		response.write(frame);
	}

	private emit(event: HostEvent): void {
		const id = ++this.sequence;
		const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
		this.history.push({ id, frame });
		this.historyBytes += Buffer.byteLength(frame);
		while (this.history.length > 512 || this.historyBytes > 2 * 1024 * 1024) {
			this.historyBytes -= Buffer.byteLength(this.history.shift()!.frame);
		}
		for (const client of this.clients) this.write(client.response, frame);
		for (const handler of this.watchers) handler(event);
	}

	private workerEvent(key: string, message: WorkerMessage): void {
		const managed = this.sessions.get(key);
		if (!managed || this.closing) return;
		if (message.type === "control") {
			const controls = [...managed.view.controls ?? []].filter(control => control.id !== message.control.id);
			controls.push(message.control);
			managed.view = { ...managed.view, controls: controls.slice(-16) };
			if (message.control.kind === "close" && message.control.state === "completed") {
				managed.worker = undefined;
				managed.view = { ...managed.view, state: "closed", snapshot: undefined, ui: undefined, error: undefined };
			}
			this.emit({ type: "session", session: managed.view });
			this.persist(true);
			return;
		}
		if (message.type === "snapshot") {
			if (managed.view.leaf !== message.snapshot.leaf || managed.view.name !== message.snapshot.name
				|| managed.view.file !== message.snapshot.file) this.saved?.invalidate();
			managed.view = { ...managed.view, cwd: message.snapshot.cwd, file: message.snapshot.file,
				name: message.snapshot.name, leaf: message.snapshot.leaf, state: "ready", snapshot: message.snapshot, ui: message.snapshot.ui };
		} else if (message.type === "ui") managed.view = { ...managed.view, ui: message.snapshot,
			...(managed.view.ui && managed.view.ui.generation !== message.snapshot.generation
				? { state: "starting" as const, snapshot: undefined } : {}) };
		else if (message.type === "fatal") {
			managed.view = { ...managed.view, state: "failed", error: message.error, interrupted: true, snapshot: undefined, ui: undefined };
			const worker = managed.worker;
			void worker?.close().catch(() => {}).finally(() => {
				if (managed.worker === worker) managed.worker = undefined;
			});
		}
		else { this.emit({ type: "worker", key, message }); return; }
		this.emit({ type: "session", session: managed.view });
		this.persist();
	}

	private persist(immediate = false): void {
		if (immediate) {
			clearTimeout(this.catalogTimer); this.catalogTimer = undefined;
			this.catalog?.write([...this.sessions.values()].map(item => item.view));
		} else if (!this.catalogTimer) this.catalogTimer = setTimeout(() => this.persist(true), 500);
	}

	private createSession(cwd: string, sessionFile?: string, existing?: ManagedSession): string {
		if (sessionFile) {
			sessionFile = realpathSync(sessionFile);
			const active = [...this.sessions.values()].find(item => item.worker && item.view.state !== "failed"
				&& (item.view.snapshot?.file ?? item.view.file) === sessionFile);
			if (active) return active.view.key;
			cwd = readSessionHeader(sessionFile).cwd;
		}
		const key = existing?.view.key ?? randomUUID();
		const options: WorkerInit = { cwd: realpathSync(cwd), agentDir: this.options.agentDir, sessionFile, sessionDir: this.options.sessionDir,
			...(existing?.view.leaf !== undefined ? { leaf: existing.view.leaf } : {}) };
		const worker = new SessionWorker(options, message => {
			if (this.sessions.get(key)?.worker === worker) this.workerEvent(key, message);
		});
		const managed: ManagedSession = { view: { ...existing?.view, key, cwd: options.cwd, file: sessionFile,
			created: existing?.view.created ?? Date.now(), state: "starting", error: undefined, interrupted: false,
			snapshot: undefined, ui: undefined }, worker };
		this.sessions.set(key, managed);
		this.emit({ type: "session", session: managed.view });
		this.persist(true);
		void worker.start(options).then(snapshot => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed") return;
			managed.view = { ...managed.view, snapshot, ui: snapshot.ui, state: "ready" };
			this.saved?.invalidate();
			this.emit({ type: "session", session: managed.view });
			this.persist(true);
		}).catch(error => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed") return;
			managed.view = { ...managed.view, state: "failed", error: error instanceof Error ? error.message : String(error) };
			this.emit({ type: "session", session: managed.view });
			this.persist(true);
			void worker.close().catch(() => {});
		});
		return key;
	}

	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Use application/json.");
		const buffers: Buffer[] = [];
		let length = 0;
		for await (const chunk of request) {
			length += Buffer.byteLength(chunk);
			if (length > 1_100_000) throw new Error("Request is too large.");
			buffers.push(Buffer.from(chunk));
		}
		return object(JSON.parse(Buffer.concat(buffers).toString("utf8")));
	}

	private allowedOrigin(origin: string | undefined): boolean {
		return origin === this.origin || !!this.options.publicOrigin && origin === this.options.publicOrigin;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		securityHeaders(response);
		try {
			const allowedHosts = [new URL(this.origin).host, ...(this.options.publicOrigin ? [new URL(this.options.publicOrigin).host] : [])];
			if (!request.headers.host || !allowedHosts.includes(request.headers.host)) { json(response, 403, { error: "Unrecognized host." }); return; }
			const url = new URL(request.url ?? "/", this.origin);
			const operator = this.access.isOperator((request.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (request.headers.origin && !this.allowedOrigin(request.headers.origin)) {
				json(response, 403, { error: "Unrecognized request origin." }); return;
			}
			// Process controls are local-only and use a per-incarnation credential,
			// never the persistent operator/device credentials or relay routing.
			if (url.pathname.startsWith("/api/host/")) {
				if (!this.control?.authenticate((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
					json(response, 401, { error: "Local host control authentication required." }); return;
				}
				if (url.pathname === "/api/host/status" && request.method === "GET") {
					json(response, 200, this.hostStatus()); return;
				}
				if (request.method === "POST") {
					const data = await this.body(request);
					if (data.instance !== this.control.record.instance) { json(response, 409, { error: "The host changed." }); return; }
					if (url.pathname === "/api/host/stop") {
						json(response, 202, { instance: this.control.record.instance });
						setImmediate(() => { void this.close().catch(() => {}); });
						return;
					}
					if (url.pathname === "/api/host/invite" && !this.closing) {
						if (data.local !== true) { json(response, 400, { error: "Use account sign-in for remote access." }); return; }
						const destination = `${this.origin}/#pair=${this.access.invite()}`;
						json(response, 200, { instance: this.control.record.instance, url: destination });
						return;
					}
					if (url.pathname === "/api/host/account" && !this.closing) {
						void this.connectAccount().catch(() => {});
						json(response, 202, { instance: this.control.record.instance }); return;
					}
				}
				json(response, 404, { error: "Unknown host control." }); return;
			}
			if (this.closing) {
				response.setHeader("Connection", "close");
				json(response, 503, { error: "Pi Desk is shutting down. Reconnect after it restarts." }); return;
			}
			if (request.method !== "GET" && !operator && !this.allowedOrigin(request.headers.origin)) {
				json(response, 403, { error: "Unrecognized request origin." }); return;
			}
			if (url.pathname === "/desk-account.json" && request.method === "GET") { json(response, 200, { kind: "local", ...RELEASE }); return; }
			const clientApi = request.headers[API_HEADER.toLowerCase()] ?? (url.pathname === "/api/events" ? url.searchParams.get("api") : undefined);
			if (url.pathname.startsWith("/api/") && !apiMatches(clientApi)) {
				json(response, 426, { error: upgradeMessage("This browser/client", clientApi), release: RELEASE });
				return;
			}
			if (url.pathname === "/api/pair" && request.method === "POST") {
				const ip = request.socket.remoteAddress ?? "unknown";
				const attempts = this.attemptWindow.get(ip);
				const next = !attempts || attempts.until < Date.now() ? { count: 1, until: Date.now() + 60_000 }
					: { ...attempts, count: attempts.count + 1 };
				this.attemptWindow.set(ip, next);
				if (next.count > 12) { json(response, 429, { error: "Too many pairing attempts. Try again in a minute." }); return; }
				const data = await this.body(request);
				const paired = this.access.pair(string(data.token, 200), string(data.label, 100));
				const secure = request.headers.origin?.startsWith("https:") ? "; Secure" : "";
				response.setHeader("Set-Cookie", `pi_desk=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
				json(response, 200, paired.device);
				return;
			}
			const device = operator ? "operator" : this.access.authenticate(cookie(request));
			if (url.pathname.startsWith("/api/") && !device) { json(response, 401, { error: "Pair this browser to continue." }); return; }
			if (url.pathname === "/api/events" && request.method === "GET") {
				response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
				const client = { response, device: device! };
				this.clients.add(client);
				const last = Number(request.headers["last-event-id"]);
				const first = this.history[0]?.id ?? this.sequence + 1;
				if (Number.isSafeInteger(last) && last >= first - 1 && last <= this.sequence && request.headers["last-event-id"]) {
					for (const item of this.history) if (item.id > last) this.write(response, item.frame);
				} else this.write(response, `id: ${this.sequence}\ndata: ${JSON.stringify({ type: "state", state: this.state() })}\n\n`);
				request.on("close", () => this.clients.delete(client));
				return;
			}
			if (url.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "POST")) {
				const result = await this.api(device!, { method: request.method, path: `${url.pathname}${url.search}`,
					...(request.method === "POST" ? { body: await this.body(request) } : {}) });
				if (result.asset) {
					response.writeHead(result.status, { "Content-Type": result.asset.mimeType, "Cache-Control": "no-store", "Content-Disposition": "inline" });
					response.end(Buffer.from(result.asset.base64, "base64"));
				} else json(response, result.status, result.body);
				return;
			}
			if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
				await serveClient(this.clientDir, url.pathname, response);
				return;
			}
			json(response, 404, { error: "Not found." });
		} catch (error) {
			if (response.headersSent) { response.destroy(); return; }
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async api(device: string | RemoteAccess, request: ApiRequest): Promise<ApiResponse> {
		const reply = (body: unknown, status = 200): ApiResponse => ({ body, status });
		try {
			if (typeof device === "string" ? device !== "operator" && !this.access.hasDevice(device) : !device.authorized()) {
				return reply({ error: "Device access is no longer authorized." }, 401);
			}
			const url = new URL(request.path, this.origin);
			const data = request.body ?? {};
			if (url.pathname === "/api/state" && request.method === "GET") return reply(this.state());
			if (url.pathname === "/api/sessions" && request.method === "POST") {
				return reply({ key: this.createSession(string(data.cwd, 4000) || this.options.cwd) }, 202);
			}
			if (url.pathname === "/api/resume" && request.method === "POST") {
				const file = realpathSync(string(data.file, 4000));
				const old = [...this.sessions.values()].find(item => (item.view.snapshot?.file ?? item.view.file) === file);
				return reply({ key: this.createSession(this.options.cwd, file, old) }, 202);
			}
			const control = /^\/api\/sessions\/([a-f0-9-]+)\/(close|metadata)$/.exec(url.pathname);
			if (control && request.method === "POST") {
				const managed = this.sessions.get(control[1]!);
				if (!managed) throw new Error("Unknown session.");
				if (control[2] === "close") {
					if (!managed.worker) return reply({ accepted: true });
					return reply(managed.worker.submitControl({ kind: "close" }, string(data.generation, 100), string(data.id, 100)), 202);
				} else {
					if (managed.worker && data.generation !== managed.view.ui?.generation) throw new StaleGeneration();
					managed.view = { ...managed.view, pinned: data.pinned === true };
				}
				this.persist(true);
				this.emit({ type: "session", session: managed.view });
				return reply({});
			}
			const route = /^\/api\/sessions\/([a-f0-9-]+)\/(command|history|assets\/([a-f0-9]{64})|artifacts\/(sha256-[a-f0-9]{64})|files\/([a-f0-9]{64})(?:\/(text|chunk))?)$/.exec(url.pathname);
			if (route) {
				const managed = this.sessions.get(route[1]!);
				if (!managed) return reply({ error: "Unknown session." }, 404);
				if (!managed.worker || managed.view.state === "closed" || managed.view.state === "failed") throw new Error("Resume this saved session before using its controls.");
				const origin = { message: url.searchParams.get("message"), source: url.searchParams.get("source") ?? undefined };
				if (route[2] === "command" && request.method === "POST") {
					const command = commandFrom(data.command);
					if (["asset", "artifact", "file", "history", "snapshot", "shutdown"].includes(command.kind)) throw new Error("Use the corresponding session endpoint.");
					if (isControl(command)) return reply({ result: managed.worker.submitControl(command, string(data.generation, 100), string(data.id, 100)) }, 202);
					const result = await managed.worker.command(command, string(data.generation, 100), string(data.id, 100));
					return reply({ result: result ?? null });
				}
				if (route[2] === "history" && request.method === "GET") {
					return reply(await managed.worker.command(commandFrom({ kind: "history",
						before: url.searchParams.has("before") ? string(url.searchParams.get("before"), 100) : undefined,
						after: url.searchParams.get("after") ?? undefined, from: url.searchParams.get("from") ?? undefined,
						source: url.searchParams.has("source") ? string(url.searchParams.get("source"), 100) : undefined })));
				}
				if (route[3] && request.method === "GET") {
					const asset = await managed.worker.command(commandFrom({ kind: "asset", id: route[3], origin })) as { mimeType: string; base64: string };
					return { status: 200, body: null, asset };
				}
				if (route[4] && request.method === "GET") {
					return reply(await managed.worker.command(commandFrom({ kind: "artifact", id: route[4], origin,
						offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
						query: url.searchParams.has("query") ? url.searchParams.get("query") : undefined })));
				}
				if (route[5] && request.method === "GET") {
					return reply(await managed.worker.command(commandFrom({ kind: "file", id: route[5], origin, operation: route[6] ?? "info",
						version: url.searchParams.get("version"),
						offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
						line: url.searchParams.has("line") ? Number(url.searchParams.get("line")) : undefined })));
				}
			}
			if (url.pathname === "/api/history" && request.method === "GET") {
				return reply(await this.saved!.page({
					query: url.searchParams.get("query") ?? "",
					offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
					revision: url.searchParams.get("revision") ?? undefined,
					refresh: url.searchParams.get("refresh") === "1",
					cwd: url.searchParams.get("cwd") ?? undefined,
					scan: url.searchParams.get("scan") ?? undefined,
					named: url.searchParams.get("named") === "1",
					reader: url.searchParams.get("reader") ?? undefined,
				}));
			}
			if (url.pathname === "/api/history/cancel" && request.method === "POST") {
				this.saved!.cancel(string(request.body?.scan, 100), string(request.body?.reader, 100));
				return reply({});
			}
			if (typeof device !== "string") return reply({ error: "Not found." }, 404);
			if (url.pathname === "/api/devices" && request.method === "GET") return reply(this.access.devices());
			if (url.pathname === "/api/invite" && request.method === "POST") return reply({ token: this.access.invite() });
			if (url.pathname === "/api/revoke" && request.method === "POST") {
				const id = string(data.id, 100);
				this.access.revoke(id);
				for (const client of this.clients) if (client.device === id) client.response.end();
				return reply({});
			}
			return reply({ error: "Not found." }, 404);
		} catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) },
			error instanceof WorkerConnectionError ? 503 : error instanceof CatalogChanged || error instanceof StaleGeneration || error instanceof ReceiptConflict ? 409 : 400); }
	}

	close(): Promise<void> {
		return this.closeJob ??= this.stop().then(this.resolveClosed, error => { this.rejectClosed(error); throw error; });
	}

	private async stop(): Promise<void> {
		this.closing = true;
		const errors: unknown[] = [];
		try { this.persist(true); } catch (error) { errors.push(error); }
		clearInterval(this.heartbeat);
		clearTimeout(this.accountRetry); this.accountRevision++;
		this.relay?.close();
		this.accountIdentity?.close();
		try { await this.saved?.close(); } catch (error) { errors.push(error); }
		for (const client of this.clients) client.response.end();
		const workers = await Promise.allSettled([...this.sessions.values()].map(item => item.worker?.close()));
		for (const result of workers) if (result.status === "rejected") errors.push(result.reason);
		const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
		this.server.closeAllConnections();
		await closed;
		try { if (this.control) removeHostRecord(this.directory, this.control.record.instance); }
		catch (error) { errors.push(error); }
		finally { this.hostLease?.close(); }
		if (errors.length) throw new AggregateError(errors, "Host shutdown encountered errors; check the log.");
	}
}

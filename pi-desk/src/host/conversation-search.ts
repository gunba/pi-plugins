import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { record } from "../../../pi-agents/network.ts";
import { SEARCH_BATCH_BYTES, SEARCH_BATCH_ROWS, SEARCH_MAX_SOURCES, SEARCH_ORIGIN, SEARCH_SERVER, SEARCH_SYNC,
	searchId, searchInteger, searchPassage, searchRequest, searchResponse, searchSource, searchText,
	type SearchPacket, type SearchPassage, type SearchRequest, type SearchResponse, type SearchSource } from "../shared/conversation-search.ts";
import type { SearchScannerOptions } from "./search-scanner.ts";
import { SearchWorkerClient } from "./search-worker-client.ts";
import type { SearchWorkerConfig, SearchWorkerState } from "./search-worker.ts";

type Send = (packet: SearchPacket) => Promise<void>;
const indexScope = (binding: SearchBinding) => `workspace:${createHash("sha256").update(binding.scope).digest("hex")}`;
export interface SearchComputer { id: string; name?: string; online: boolean; operations: string[] }
export interface SearchBinding { scope: string; computers(): SearchComputer[]; send(id: string, packet: SearchPacket): Promise<void>; flush(): void }
type Inventory = { snapshot: string; ids: string[]; offset: number; scanned: number };
type Pull = { id: string; source: SearchSource; after: number; at: number };
type Peer = { epoch?: string; incoming?: Inventory; allowed: Set<string>; received: boolean; sent?: string; outgoing?: Inventory;
	versions: Map<string, number>; advertised: Set<string>; wanted: Map<string, SearchSource>; pending?: Pull; tail: Promise<void>; queued: number; hosting?: boolean };
type Awaiting = { computer: string; binding: SearchBinding; request: SearchRequest; resolve(value: SearchResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export interface ConversationSearchOptions {
	directory: string;
	modelDirectory?: string;
	proxy?: string;
	scanner(): SearchScannerOptions;
	settings(): { hold: boolean; send: boolean };
	self(): string;
}

/** Search is an auxiliary same-owner protocol; indexing failures must not take agent messaging down with it. */
export class ConversationSearch {
	private readonly options: ConversationSearchOptions;
	private worker?: SearchWorkerClient;
	private workerStarted = 0;
	private binding?: SearchBinding;
	private peers = new Map<string, Peer>();
	private queries = new Map<string, Awaiting>();
	private activeQueries = 0;
	private localRequested = false;
	private configSignature = "";
	private configWork: Promise<void> = Promise.resolve();
	private snapshot?: Promise<SearchWorkerState>;
	private closed = false;
	private lastError?: string;
	constructor(options: ConversationSearchOptions) { this.options = options; }
	operations(): string[] { return [SEARCH_SYNC, ...(this.options.settings().hold ? [SEARCH_SERVER] : [])]; }
	bind(binding: SearchBinding): void { this.unbind(); this.binding = binding; void this.configure().catch(error => this.error(error)); }
	unbind(binding?: SearchBinding): void {
		if (binding && this.binding !== binding) return;
		this.binding = undefined; this.peers.clear(); this.lastError = undefined;
		for (const query of this.queries.values()) { clearTimeout(query.timer); query.reject(Error("The search workspace disconnected.")); }
		this.queries.clear(); this.configSignature = "";
		if (this.worker) void this.configure().catch(error => this.error(error));
	}
	private error(error: unknown): void { this.lastError = `${new Date().toISOString()}: ${(error instanceof Error ? error.message : String(error)).slice(0, 450)}`; }
	private settings(): { semantic: boolean; exclude: string[] } {
		const path = join(this.options.directory, "settings.json");
		if (!existsSync(path)) return { semantic: true, exclude: [] };
		if (statSync(path).size > 1024 * 1024) throw Error("Conversation search settings exceed 1 MiB.");
		let parsed: unknown;
		try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw Error("Conversation search settings contain invalid JSON or cannot be read."); }
		const value = record(parsed);
		if (value.semantic !== undefined && typeof value.semantic !== "boolean") throw Error("Search semantic setting must be true or false.");
		if (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > 10_000)) throw Error("Invalid search exclusion list.");
		return { semantic: value.semantic !== false, exclude: (value.exclude as unknown[] | undefined ?? []).map(id => searchText(id, 200, "excluded native session")) };
	}
	private configure(): Promise<void> {
		if (this.closed) return Promise.reject(Error("Conversation search is closed."));
		// A worker that stopped (killed, out of memory, a native crash) is replaced, at most once a minute so a crash loop stays cheap.
		if (this.worker?.failed && Date.now() - this.workerStarted >= 60_000) {
			this.error(this.worker.failed); this.worker = undefined; this.configSignature = ""; this.snapshot = undefined;
		}
		const settings = this.settings(), role = this.options.settings(), scanner = this.options.scanner();
		const config: SearchWorkerConfig = { computer: this.options.self() || hostname(), capture: !!this.binding || this.localRequested, semantic: role.hold && settings.semantic,
			share: role.send, ...(role.hold && this.binding ? { scope: indexScope(this.binding) } : {}), scanner: { ...scanner, exclude: settings.exclude } };
		const signature = JSON.stringify(config);
		if (signature === this.configSignature) return this.configWork;
		this.configSignature = signature;
		if (!this.worker) {
			this.workerStarted = Date.now();
			this.worker = new SearchWorkerClient({ directory: this.options.directory, modelDirectory: this.options.modelDirectory,
				proxy: this.options.proxy, scanner: config.scanner }, local => { this.snapshot = undefined; if (local) this.binding?.flush(); });
		}
		const worker = this.worker;
		this.configWork = this.configWork.catch(() => {}).then(async () => {
			await worker.call({ action: "configure", config }); this.snapshot = undefined;
		}).catch(error => { this.configSignature = ""; throw error; });
		return this.configWork;
	}
	private async state(): Promise<SearchWorkerState> {
		await this.configure();
		return this.snapshot ??= this.worker!.call<SearchWorkerState>({ action: "state" }).catch(error => { this.snapshot = undefined; throw error; });
	}
	private peer(id: string): Peer {
		let peer = this.peers.get(id);
		if (!peer) this.peers.set(id, peer = { allowed: new Set(), received: false, versions: new Map(), advertised: new Set(), wanted: new Map(), tail: Promise.resolve(), queued: 0 });
		return peer;
	}
	disconnected(id: string): void {
		this.peers.delete(id);
		for (const [key, query] of this.queries) if (query.computer === id) { clearTimeout(query.timer); query.reject(Error("The conversation search server disconnected.")); this.queries.delete(key); }
	}
	announced(id: string, operations: readonly string[]): void {
		const peer = this.peer(id), holding = operations.includes(SEARCH_SERVER);
		if (peer.hosting !== holding) { peer.sent = undefined; peer.outgoing = undefined; peer.versions.clear(); peer.advertised.clear(); peer.hosting = holding; }
	}
	/** Each publish sends a bounded inventory/offer window, never the complete transcript backfill. */
	async publish(id: string, operations: readonly string[], send: Send): Promise<void> {
		const binding = this.binding;
		if (!binding || this.closed || !operations.includes(SEARCH_SYNC)) return;
		const peer = this.peer(id); this.announced(id, operations);
		try {
			const state = await this.state();
			if (this.binding !== binding || this.peers.get(id) !== peer) return;
			if (operations.includes(SEARCH_SERVER) && (state.scanner.ready || !this.options.settings().send)) {
				const sources = this.options.settings().send ? state.sources : [], ids = sources.map(source => source.id).sort();
				const snapshot = createHash("sha256").update(`${state.epoch}\0${Math.floor(Date.now() / 300_000)}\0${ids.join("\0")}`).digest("hex");
				if (peer.sent !== snapshot) {
					if (peer.outgoing?.snapshot !== snapshot) peer.outgoing = { snapshot, ids, offset: 0, scanned: state.coverage.last_scan ?? 0 };
					const outgoing = peer.outgoing;
					for (let batch = 0; batch < 4; batch++) {
						const page = outgoing.ids.slice(outgoing.offset, outgoing.offset + 256), done = outgoing.offset + page.length === outgoing.ids.length;
						await send({ type: "search-inventory", epoch: state.epoch, snapshot, offset: outgoing.offset, sources: page, done, scanned: outgoing.scanned });
						outgoing.offset += page.length;
						if (done) { peer.sent = snapshot; peer.advertised = new Set(ids); peer.outgoing = undefined; peer.versions.clear(); break; }
					}
					if (peer.outgoing) { setImmediate(() => { if (this.binding === binding) binding.flush(); }); return; }
				}
				const changed = sources.filter(source => peer.advertised.has(source.id) && peer.versions.get(source.id) !== source.version);
				if (changed.length) {
					const batch = changed.slice(0, 32); await send({ type: "search-offer", epoch: state.epoch, sources: batch });
					for (const source of batch) peer.versions.set(source.id, source.version);
					if (changed.length > batch.length) setImmediate(() => { if (this.binding === binding) binding.flush(); });
				}
			}
			if (this.options.settings().hold) await this.pull(id, peer, binding, send);
		} catch (error) { this.error(error); }
	}
	private async pull(id: string, peer: Peer, binding: SearchBinding, send: Send): Promise<void> {
		if (peer.pending && Date.now() - peer.pending.at < 30_000 || !peer.received || this.binding !== binding || this.peers.get(id) !== peer) return;
		peer.pending = undefined;
		for (const source of peer.wanted.values()) {
			const cursor = await this.worker!.call<number | undefined>({ action: "offer", scope: indexScope(binding), computer: id, source });
			if (this.binding !== binding || this.peers.get(id) !== peer) return;
			if (cursor === undefined || cursor >= source.cursor || !peer.allowed.has(source.id)) { peer.wanted.delete(source.id); continue; }
			const request = { id: randomUUID(), source, after: cursor, at: Date.now() }; peer.pending = request;
			await send({ type: "search-fetch", id: request.id, source: source.id, generation: source.generation, after: cursor, through: source.cursor }); return;
		}
	}
	/** Validate before queueing work. Responses and queries do not sit behind source backfill. */
	receive(id: string, raw: unknown, send: Send): Promise<void> {
		const binding = this.binding;
		if (!binding || this.closed) return Promise.reject(Error("The search workspace is not connected."));
		// A packet this computer can't accept is reported in search status; rejecting it would close the connection to
		// that computer, and agent messages, settings and copies with it, on every reconnect.
		let packet: SearchPacket;
		try { packet = this.packet(raw); } catch (error) { this.error(error); return Promise.resolve(); }
		const peer = this.peer(id);
		if (packet.type === "search-result") { this.result(id, packet, binding); return Promise.resolve(); }
		if (packet.type === "search-query") {
			void this.answer(packet, binding, send); return Promise.resolve();
		}
		if (++peer.queued > 64) { peer.queued--; return Promise.reject(Error("Too many queued search packets.")); }
		const work = peer.tail.then(async () => {
			if (this.binding !== binding || this.peers.get(id) !== peer) return;
			await this.configure(); await this.sync(id, peer, packet, binding, send);
		}).catch(error => { this.error(error); }).finally(() => { peer.queued--; });
		peer.tail = work; return work;
	}
	private async sync(id: string, peer: Peer, packet: Exclude<SearchPacket, { type: "search-query" | "search-result" }>, binding: SearchBinding, send: Send): Promise<void> {
		if (packet.type === "search-fetch") {
			try {
				if (!this.options.settings().send) throw Error("This computer no longer shares its conversations.");
				const passages = await this.worker!.call<SearchPassage[]>({ action: "export", source: packet.source, generation: packet.generation,
					after: packet.after, through: packet.through, maximum: SEARCH_BATCH_ROWS, bytes: SEARCH_BATCH_BYTES });
				if (!this.options.settings().send) throw Error("This computer no longer shares its conversations.");
				if (this.binding === binding && this.peers.get(id) === peer) await send({ type: "search-data", id: packet.id, source: packet.source,
					generation: packet.generation, after: packet.after, cursor: passages.at(-1)?.sequence ?? packet.after, passages });
			} catch (error) {
				if (this.binding === binding && this.peers.get(id) === peer) await send({ type: "search-data", id: packet.id, source: packet.source,
					generation: packet.generation, after: packet.after, cursor: packet.after, passages: [], error: error instanceof Error ? error.message.slice(0, 500) : "Source unavailable." });
			}
			return;
		}
		if (!this.options.settings().hold) return;
		if (packet.type === "search-inventory" || packet.type === "search-offer") {
			if (peer.epoch && peer.epoch !== packet.epoch) throw Error("A search source changed epoch without reconnecting.");
			peer.epoch = packet.epoch;
		}
		if (packet.type === "search-inventory") {
			if (packet.offset === 0) peer.incoming = { snapshot: packet.snapshot, ids: [], offset: 0, scanned: packet.scanned };
			const incoming = peer.incoming;
			if (!incoming || incoming.snapshot !== packet.snapshot || incoming.offset !== packet.offset || incoming.ids.length + packet.sources.length > SEARCH_MAX_SOURCES)
				throw Error("The search inventory is incomplete or out of order.");
			incoming.ids.push(...packet.sources); incoming.offset += packet.sources.length;
			if (packet.done) {
				if (new Set(incoming.ids).size !== incoming.ids.length) throw Error("The search inventory contains duplicate sources.");
				await this.worker!.call({ action: "inventory", scope: indexScope(binding), computer: id, epoch: packet.epoch, snapshot: packet.snapshot, sources: incoming.ids, scanned: incoming.scanned });
				peer.allowed = new Set(incoming.ids); peer.received = true; peer.incoming = undefined;
				for (const key of peer.wanted.keys()) if (!peer.allowed.has(key)) peer.wanted.delete(key);
				if (peer.pending && !peer.allowed.has(peer.pending.source.id)) peer.pending = undefined;
			}
			return;
		}
		if (packet.type === "search-offer") {
			for (const source of packet.sources) if (peer.allowed.has(source.id)) {
				const previous = peer.wanted.get(source.id);
				if (previous && previous.version > source.version) continue;
				peer.wanted.set(source.id, source);
				await this.worker!.call({ action: "offer", scope: indexScope(binding), computer: id, source });
				if (peer.pending?.source.id === source.id && peer.pending.source.generation !== source.generation) peer.pending = undefined;
			}
			await this.pull(id, peer, binding, send); return;
		}
		const pending = peer.pending;
		if (!pending || pending.id !== packet.id) return;
		if (packet.source !== pending.source.id || packet.generation !== pending.source.generation || packet.after !== pending.after
			|| packet.cursor !== packet.after + packet.passages.length) throw Error("The search response does not match its requested range.");
		if (packet.error) { pending.at = Date.now(); this.snapshot = undefined; this.error(Error(packet.error)); return; }
		if (!packet.passages.length && pending.after < pending.source.cursor) throw Error("The search source returned an empty unfinished range.");
		await this.worker!.call({ action: "import", scope: indexScope(binding), computer: id, source: pending.source, after: pending.after, passages: packet.passages });
		peer.pending = undefined;
		await this.pull(id, peer, binding, send);
	}
	private async answer(packet: Extract<SearchPacket, { type: "search-query" }>, binding: SearchBinding, send: Send): Promise<void> {
		let result: SearchResponse | undefined, error: string | undefined;
		try {
			if (!this.options.settings().hold && packet.request.action !== "status") throw Error("This computer does not host conversation search.");
			if (this.activeQueries >= 32) throw Error("Conversation search is busy; try again shortly.");
			this.activeQueries++;
			try { await this.configure(); result = await this.worker!.call<SearchResponse>({ action: "query", request: packet.request, remote: true }); this.decorate(result); }
			finally { this.activeQueries--; }
		} catch (cause) { error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500); }
		if (this.binding !== binding || this.closed) return;
		await send({ type: "search-result", id: packet.id, ...(result ? { result } : { error }) }).catch(() => {});
	}
	private decorate(result: SearchResponse): void {
		result.server = this.options.self() || "local";
		const computers = this.binding?.computers() ?? [];
		result.coverage.unreported_computers = computers.filter(computer => computer.online && computer.operations.includes(SEARCH_SYNC) && !this.peers.get(computer.id)?.received).length;
		result.coverage.unsupported_computers = computers.filter(computer => computer.online && !computer.operations.includes(SEARCH_SYNC)).length;
		result.coverage.offline_computers = computers.filter(computer => !computer.online).length;
		if (result.mode === "status" && this.lastError) result.issues = [...result.issues ?? [], this.lastError].slice(-10);
	}
	async request(value: unknown, target?: string): Promise<SearchResponse> {
		const request = searchRequest(value), binding = this.binding, computers = binding?.computers() ?? [];
		const local = target === "local" || target === this.options.self() || target?.toLowerCase() === hostname().toLowerCase();
		if (!target && this.options.settings().hold && computers.some(computer => computer.online && computer.operations.includes(SEARCH_SERVER)))
			throw Error("Several computers host conversation search; specify their computer name or ID in server.");
		if (target?.toLowerCase() === hostname().toLowerCase() && computers.some(computer => computer.online && computer.name?.toLowerCase() === target.toLowerCase()))
			throw Error("That computer name is ambiguous; use its ID or server: local.");
		if (local || !target && this.options.settings().hold) {
			this.localRequested = true; await this.configure();
			const result = await this.worker!.call<SearchResponse>({ action: "query", request, remote: false });
			if (this.binding !== binding) throw Error("The search workspace changed while the request was running.");
			this.decorate(result); return result;
		}
		const candidates = computers.filter(computer => computer.online && (computer.operations.includes(SEARCH_SERVER) || !!target && request.action === "status" && computer.operations.includes(SEARCH_SYNC))
			&& (!target || computer.id === target || computer.name?.toLowerCase() === target.toLowerCase()));
		if (!binding || !candidates.length) throw Error("No connected conversation-search server is available. Update the computer that keeps copies, or use server: local for this computer's keyword index.");
		if (candidates.length !== 1) throw Error("Several computers host conversation search; specify their computer name or ID in server.");
		if (this.queries.size >= 32) throw Error("Too many pending conversation searches; try again shortly.");
		const computer = candidates[0]!.id, id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.queries.delete(id); reject(Error("The conversation-search server did not answer in time.")); }, 30_000); timer.unref();
			this.queries.set(id, { computer, binding, request, resolve, reject, timer });
			void binding.send(computer, { type: "search-query", id, request }).catch(error => {
				const pending = this.queries.get(id); if (!pending) return; clearTimeout(timer); this.queries.delete(id); reject(error);
			});
		});
	}
	private result(computer: string, packet: Extract<SearchPacket, { type: "search-result" }>, binding: SearchBinding): void {
		const pending = this.queries.get(packet.id);
		if (!pending || pending.computer !== computer || pending.binding !== binding) return;
		clearTimeout(pending.timer); this.queries.delete(packet.id);
		if (packet.error || !packet.result) { pending.reject(Error(packet.error ?? "Invalid search response.")); return; }
		packet.result.server = computer;
		if (pending.request.action !== "status" && JSON.stringify(packet.result).length > pending.request.max_chars) { pending.reject(Error("The search server exceeded the requested response budget.")); return; }
		pending.resolve(packet.result);
	}
	private packet(raw: unknown): SearchPacket {
		if (Buffer.byteLength(JSON.stringify(raw)) > 2 * 1024 * 1024) throw Error("Search packet exceeds its size limit.");
		const p = record(raw), type = String(p.type), id = () => searchId(p.id);
		if (type === "search-query") return { type, id: id(), request: searchRequest(p.request) };
		if (type === "search-result") {
			if (p.error !== undefined) return { type, id: id(), error: searchText(p.error, 500, "search error") };
			if (JSON.stringify(p.result).length > 26_000) throw Error("Invalid search result size.");
			return { type, id: id(), result: searchResponse(p.result) };
		}
		if (type === "search-inventory") {
			if (!Array.isArray(p.sources) || p.sources.length > 256 || typeof p.done !== "boolean" || !p.done && !p.sources.length) throw Error("Invalid search inventory page.");
			return { type, epoch: searchId(p.epoch), snapshot: searchId(p.snapshot), offset: searchInteger(p.offset, 0, SEARCH_MAX_SOURCES, "inventory offset"),
				sources: p.sources.map(source => searchId(source)), done: p.done, scanned: searchInteger(p.scanned, 0, 8.64e15, "scan time") };
		}
		if (type === "search-offer") {
			if (!Array.isArray(p.sources) || p.sources.length > 32) throw Error("Invalid search source offer.");
			return { type, epoch: searchId(p.epoch), sources: p.sources.map(searchSource) };
		}
		const common = { id: id(), source: searchId(p.source), generation: searchId(p.generation), after: searchInteger(p.after, 0, Number.MAX_SAFE_INTEGER, "source cursor") };
		if (type === "search-fetch") return { type, ...common, through: searchInteger(p.through, common.after, Number.MAX_SAFE_INTEGER, "source boundary") };
		if (type === "search-data") {
			if (!Array.isArray(p.passages) || p.passages.length > SEARCH_BATCH_ROWS || Buffer.byteLength(JSON.stringify(p.passages)) > SEARCH_BATCH_BYTES + SEARCH_BATCH_ROWS)
				throw Error("Invalid search passage range.");
			return { type, ...common, cursor: searchInteger(p.cursor, common.after, Number.MAX_SAFE_INTEGER, "range cursor"), passages: p.passages.map(searchPassage),
				...(p.error === undefined ? {} : { error: searchText(p.error, 500, "source error") }) };
		}
		throw Error("Unknown search packet.");
	}
	async close(): Promise<void> {
		if (this.closed) return; this.closed = true; this.unbind(); await this.worker?.close();
	}
}

import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { SEARCH_ORIGIN, type SearchCoverage, type SearchPassage, type SearchRequest, type SearchResponse, type SearchSource } from "../shared/conversation-search.ts";
import { SearchEmbedder } from "./search-embedder.ts";
import { SearchScanner, type SearchScannerOptions } from "./search-scanner.ts";
import { SearchStore, type QueryScope } from "./search-store.ts";

export interface SearchWorkerOptions { directory: string; modelDirectory?: string; proxy?: string; scanner: SearchScannerOptions }
export interface SearchWorkerConfig { computer?: string; scope?: string; capture: boolean; semantic: boolean; share: boolean; scanner: SearchScannerOptions }
export type SearchWorkerCommand =
	| { action: "configure"; config: SearchWorkerConfig }
	| { action: "state" }
	| { action: "scan" }
	| { action: "inventory"; scope: string; computer: string; epoch: string; snapshot: string; sources: string[]; scanned: number }
	| { action: "offer"; scope: string; computer: string; source: SearchSource }
	| { action: "import"; scope: string; computer: string; source: SearchSource; after: number; passages: SearchPassage[] }
	| { action: "export"; source: string; generation: string; after: number; through: number; maximum: number; bytes: number }
	| { action: "query"; request: SearchRequest; remote: boolean }
	| { action: "close" };
export interface SearchWorkerState {
	epoch: string;
	sources: SearchSource[];
	scanner: SearchScanner["status"];
	coverage: SearchCoverage;
}

const port = parentPort;
if (!port) throw Error("Conversation search must run in its dedicated worker.");
const options = workerData as SearchWorkerOptions, store = new SearchStore(join(options.directory, "index.sqlite"));
let config: SearchWorkerConfig = { capture: false, semantic: false, share: true, scanner: options.scanner };
let revision = 0, closing = false, embedding = false, recentQuery = 0, backgroundError: string | undefined;
let notification: ReturnType<typeof setTimeout> | undefined, maintenance: ReturnType<typeof setInterval>;
let localChanged = false;
const changed = (local = false) => {
	localChanged ||= local;
	if (notification || closing) return;
	notification = setTimeout(() => { notification = undefined; port.postMessage({ type: "changed", local: localChanged }); localChanged = false; kick(); }, 250); notification.unref();
};
let scanner = new SearchScanner(store, options.scanner, () => changed(true));
const createEmbedder = () => new SearchEmbedder(options.modelDirectory ?? join(options.directory, "models"), { proxy: options.proxy, changed: () => changed() });
let embedder = createEmbedder();
const scope = (remote = false): QueryScope => ({ ...(config.scope ? { remote: config.scope } : {}), local: !remote || config.share, localComputer: config.computer });
function coverage(remote = false): SearchCoverage {
	const value = store.coverage(scope(remote), config.semantic ? embedder.error ? "error" : !embedder.ready ? "preparing" : "indexing" : "disabled", embedder.error ?? backgroundError);
	if (value.semantic === "indexing" && value.embedded_passages >= value.semantic_passages) value.semantic = "ready";
	value.scanning = config.capture && (!scanner.status.ready || scanner.status.scanning);
	value.warnings += scanner.status.warnings.length;
	return value;
}
function kick(): void {
	if (closing || embedding || backgroundError || !config.semantic) return;
	// A complete persisted index still needs the model to embed queries after a restart.
	if (!embedder.ready) { if (store.hasSemanticText(scope())) embedder.prepare(); return; }
	const batch = store.pending(scope(), Date.now() - recentQuery < 20_000 ? 4 : 16);
	if (!batch.length) return;
	embedding = true;
	void embedder.embed(batch.map(item => item.text)).then(vectors => {
		if (!closing) { store.putVectors(batch.map((item, index) => ({ id: item.id, hash: item.hash, vector: vectors[index]! }))); backgroundError = undefined; changed(); }
	}).catch(error => { backgroundError = error instanceof Error ? error.message : String(error); changed(); })
		.finally(() => { embedding = false; if (!closing && !backgroundError) setImmediate(kick); });
}
async function query(request: SearchRequest, remote: boolean): Promise<SearchResponse> {
	const before = revision; let vector: Float32Array | undefined, error: string | undefined;
	if (request.action === "search" && config.semantic && embedder.ready) {
		recentQuery = Date.now();
		try { [vector] = await embedder.embed([request.query], true); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
	}
	if (closing || revision !== before) throw Error("The search workspace changed while the request was running.");
	const current = coverage(remote); if (error) current.semantic_error = error.slice(0, 300);
	if (request.action === "search") return store.search(request, scope(remote), current, vector);
	if (request.action === "read") return store.read(request, scope(remote), current);
	return { origin: SEARCH_ORIGIN, mode: "status", coverage: current, hits: [], truncated: false, issues: [...scanner.status.warnings, ...store.issues(scope(remote))].slice(0, 10),
		warning: "Coverage includes only retained, synchronized, non-excluded history. Offline computers may have newer changes that have not arrived." };
}
async function handle(command: SearchWorkerCommand): Promise<unknown> {
	if (closing && command.action !== "close") throw Error("Conversation search is closing.");
	switch (command.action) {
		case "configure": {
			const previous = config; config = command.config; revision++;
			if (previous.scope !== config.scope || !config.semantic) store.dropVectorCache();
			if (previous.semantic && !config.semantic) { await embedder.close(); embedder = createEmbedder(); backgroundError = undefined; }
			if (!config.capture && previous.capture) { await scanner.close(); scanner = new SearchScanner(store, config.scanner, () => changed(true)); }
			scanner.configure(config.scanner, config.capture);
			if (config.capture) scanner.start();
			changed(true); kick(); return;
		}
		case "scan": await scanner.scan(); return;
		case "state": return { epoch: store.epoch, sources: store.localSources(), scanner: scanner.status, coverage: coverage() } satisfies SearchWorkerState;
		case "inventory": store.inventory(command.scope, command.computer, command.epoch, command.snapshot, command.sources, command.scanned); changed(); return;
		case "offer": { const result = store.offer(command.scope, command.computer, command.source); changed(); return result; }
		case "import": { const result = store.import(command.scope, command.computer, command.source, command.after, command.passages); changed(); kick(); return result; }
		case "export": return store.export(command.source, command.generation, command.after, command.through, command.maximum, command.bytes);
		case "query": return query(command.request, command.remote);
		case "close":
			if (closing) return;
			closing = true; clearInterval(maintenance); if (notification) clearTimeout(notification);
			await scanner.close(); await embedder.close(); store.close(); return;
	}
}
maintenance = setInterval(() => {
	try { store.maintenance(); backgroundError = undefined; kick(); changed(true); }
	catch (error) { backgroundError = error instanceof Error ? error.message : String(error); changed(); }
}, 60_000); maintenance.unref();
port.on("message", (message: { id: number; command: SearchWorkerCommand }) => {
	void handle(message.command).then(result => {
		port.postMessage({ id: message.id, result }); if (message.command.action === "close") port.close();
	}, error => { port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); });
});
port.postMessage({ type: "ready" });

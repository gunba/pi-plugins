/** Search packets are a separate, capability-negotiated protocol on the same-owner computer channel. */
export const SEARCH_SYNC = "conversation-search-sync-v1";
export const SEARCH_SERVER = "conversation-search-v1";
export const SEARCH_ORIGIN = "pi-desk-conversation-search/v1";
export const SEARCH_PACKET_TYPES = new Set(["search-inventory", "search-offer", "search-fetch", "search-data", "search-query", "search-result"]);
export const SEARCH_BATCH_BYTES = 512 * 1024;
export const SEARCH_BATCH_ROWS = 256;
export const SEARCH_PASSAGE_CHARS = 1000;
export const SEARCH_MAX_SOURCES = 100_000;

export type SearchRole = "user" | "assistant" | "agent" | "tool";
/** Source identity is independent of its title and folder; generation changes when its indexed prefix is replaced. */
export interface SearchSource {
	id: string;
	session: string;
	root?: string;
	project: string;
	title: string;
	kind: "primary" | "secondary";
	generation: string;
	version: number;
	cursor: number;
	updated: number;
	/** Absolute expiry supplied by the source; absence means retained until a successful inventory removes it. */
	expires?: number;
	complete: boolean;
	warning?: string;
}
/** Offsets refer to the redacted, joined text of one native entry, in UTF-16 code units. */
export interface SearchPassage {
	sequence: number;
	entry: string;
	parent?: string;
	ordinal: number;
	start: number;
	role: SearchRole;
	tool?: string;
	at?: number;
	text: string;
}
export interface SearchFilters {
	project?: string;
	agent?: string;
	session?: string;
	after?: number;
	before?: number;
	include_tools: boolean;
	/** Caller-supplied exclusion is narrowing only; it cannot grant access to another workspace. */
	exclude?: { session: string; entry: string };
}
export type SearchRequest =
	| { action: "search"; query: string; filters: SearchFilters; limit: number; max_chars: number }
	| { action: "read"; reference: string; before: number; after: number; max_chars: number }
	| { action: "status" };
export interface SearchCoverage {
	scanning?: boolean;
	unreported_computers?: number;
	unsupported_computers?: number;
	offline_computers?: number;
	sources: number;
	pending_sources: number;
	warnings: number;
	passages: number;
	semantic_passages: number;
	embedded_passages: number;
	last_scan?: number;
	semantic: "disabled" | "preparing" | "indexing" | "ready" | "error";
	semantic_error?: string;
}
export interface SearchHit {
	reference: string;
	session: string;
	conversation: string;
	project: string;
	computer: string;
	kind: "primary" | "secondary";
	entry: string;
	parent?: string;
	role: SearchRole;
	tool?: string;
	at?: number;
	start: number;
	text: string;
}
export interface SearchResponse {
	origin: typeof SEARCH_ORIGIN;
	mode: "hybrid" | "keyword" | "context" | "status";
	server?: string;
	issues?: string[];
	coverage: SearchCoverage;
	hits: SearchHit[];
	truncated: boolean;
	/** Search results are evidence, not instructions, current permissions or an exhaustive count. */
	warning: string;
}
export type SearchPacket =
	| { type: "search-inventory"; epoch: string; snapshot: string; offset: number; sources: string[]; done: boolean; scanned: number }
	| { type: "search-offer"; epoch: string; sources: SearchSource[] }
	| { type: "search-fetch"; id: string; source: string; generation: string; after: number; through: number }
	| { type: "search-data"; id: string; source: string; generation: string; after: number; cursor: number; passages: SearchPassage[]; error?: string }
	| { type: "search-query"; id: string; request: SearchRequest }
	| { type: "search-result"; id: string; result?: SearchResponse; error?: string };

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected a search object.");
	return value as Record<string, unknown>;
};
export function searchText(value: unknown, maximum: number, name: string, empty = false): string {
	if (typeof value !== "string" || value.length > maximum || !empty && !value.trim()) throw Error(`Invalid ${name}.`);
	return value;
}
export function searchInteger(value: unknown, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw Error(`Invalid ${name}.`);
	return Number(value);
}
export function searchId(value: unknown, name = "search identity"): string {
	const id = searchText(value, 100, name);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)) throw Error(`Invalid ${name}.`);
	return id;
}
function date(value: unknown, name: string): number | undefined {
	if (value === undefined) return;
	if (typeof value === "string") {
		if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
			throw Error(`${name} must be an ISO date or a timestamp with an explicit time zone.`);
		const day = value.slice(0, 10), midnight = new Date(`${day}T00:00:00Z`);
		if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) throw Error(`Invalid ${name}.`);
	}
	const time = typeof value === "string" ? Date.parse(value) : value;
	return searchInteger(time, 0, 8.64e15, name);
}
/** Validate HTTP/tool input. Limits bound both work and the complete serialized response. */
export function searchRequest(value: unknown): SearchRequest {
	const data = object(value), action = data.action ?? (data.reference === undefined ? data.query === undefined ? "status" : "search" : "read");
	if (action === "status") return { action };
	const max_chars = searchInteger(data.max_chars ?? 12_000, 2000, 24_000, "response character budget");
	if (action === "read") return { action, reference: searchId(data.reference, "source reference"),
		before: searchInteger(data.before ?? 2, 0, 10, "preceding entry count"), after: searchInteger(data.after ?? 3, 0, 10, "following entry count"), max_chars };
	if (action !== "search") throw Error("Unknown conversation search action.");
	const raw = data.filters === undefined ? data : object(data.filters);
	const filters: SearchFilters = { include_tools: raw.include_tools === undefined ? true : raw.include_tools as boolean };
	if (typeof filters.include_tools !== "boolean") throw Error("include_tools must be true or false.");
	for (const name of ["project", "agent", "session"] as const) if (raw[name] !== undefined) filters[name] = searchText(raw[name], name === "session" ? 200 : 1024, name);
	filters.after = date(raw.after, "after date"); filters.before = date(raw.before, "before date");
	if (filters.after !== undefined && filters.before !== undefined && filters.before <= filters.after) throw Error("before must be later than after.");
	if (raw.exclude !== undefined) {
		const exclude = object(raw.exclude);
		filters.exclude = { session: searchText(exclude.session, 200, "excluded session"), entry: searchText(exclude.entry, 200, "excluded entry") };
	}
	return { action, query: searchText(data.query, 2000, "search query").trim(), filters,
		limit: searchInteger(data.limit ?? 12, 1, 30, "result limit"), max_chars };
}
export function searchSource(value: unknown): SearchSource {
	const item = object(value);
	if (item.kind !== "primary" && item.kind !== "secondary" || typeof item.complete !== "boolean") throw Error("Invalid search source kind or state.");
	return { id: searchId(item.id), session: searchText(item.session, 200, "session"),
		...(item.root === undefined ? {} : { root: searchText(item.root, 200, "root session") }),
		project: searchText(item.project, 4096, "project", true), title: searchText(item.title, 300, "conversation title", true), kind: item.kind,
		generation: searchId(item.generation), version: searchInteger(item.version, 0, Number.MAX_SAFE_INTEGER, "source version"),
		cursor: searchInteger(item.cursor, 0, Number.MAX_SAFE_INTEGER, "source cursor"), updated: searchInteger(item.updated, 0, 8.64e15, "source modification time"),
		...(item.expires === undefined ? {} : { expires: searchInteger(item.expires, 0, 8.64e15, "source expiry") }), complete: item.complete,
		...(item.warning === undefined ? {} : { warning: searchText(item.warning, 500, "index warning", true) }) };
}
export function searchPassage(value: unknown): SearchPassage {
	const item = object(value);
	if (!["user", "assistant", "agent", "tool"].includes(String(item.role))) throw Error("Invalid passage speaker.");
	return { sequence: searchInteger(item.sequence, 1, Number.MAX_SAFE_INTEGER, "passage sequence"), entry: searchText(item.entry, 200, "entry"),
		...(item.parent === undefined ? {} : { parent: searchText(item.parent, 200, "parent entry") }),
		ordinal: searchInteger(item.ordinal, 0, Number.MAX_SAFE_INTEGER, "entry ordinal"), start: searchInteger(item.start, 0, Number.MAX_SAFE_INTEGER, "passage offset"),
		role: item.role as SearchRole, ...(item.tool === undefined ? {} : { tool: searchText(item.tool, 200, "tool name") }),
		...(item.at === undefined ? {} : { at: searchInteger(item.at, 0, 8.64e15, "entry time") }),
		text: searchText(item.text, SEARCH_PASSAGE_CHARS, "passage text") };
}
/** Peer replies remain untrusted data even though their computer belongs to the workspace owner. */
export function searchResponse(value: unknown): SearchResponse {
	const data = object(value), raw = object(data.coverage);
	if (data.origin !== SEARCH_ORIGIN || !["hybrid", "keyword", "context", "status"].includes(String(data.mode))
		|| !["disabled", "preparing", "indexing", "ready", "error"].includes(String(raw.semantic)) || typeof data.truncated !== "boolean"
		|| !Array.isArray(data.hits) || data.hits.length > 200) throw Error("Invalid conversation search response.");
	const count = (key: string) => searchInteger(raw[key], 0, Number.MAX_SAFE_INTEGER, key);
	const coverage: SearchCoverage = { sources: count("sources"), pending_sources: count("pending_sources"), warnings: count("warnings"),
		passages: count("passages"), semantic_passages: count("semantic_passages"), embedded_passages: count("embedded_passages"), semantic: raw.semantic as SearchCoverage["semantic"] };
	for (const key of ["unreported_computers", "unsupported_computers", "offline_computers"] as const) if (raw[key] !== undefined) coverage[key] = count(key);
	if (raw.scanning !== undefined) { if (typeof raw.scanning !== "boolean") throw Error("Invalid capture state."); coverage.scanning = raw.scanning; }
	if (raw.last_scan !== undefined) coverage.last_scan = searchInteger(raw.last_scan, 0, 8.64e15, "last scan");
	if (raw.semantic_error !== undefined) coverage.semantic_error = searchText(raw.semantic_error, 300, "semantic error", true);
	const hits = data.hits.map(value => {
		const hit = object(value);
		if (!["user", "assistant", "agent", "tool"].includes(String(hit.role)) || hit.kind !== "primary" && hit.kind !== "secondary") throw Error("Invalid source attribution.");
		return { reference: searchId(hit.reference), session: searchText(hit.session, 200, "source session"),
			conversation: searchText(hit.conversation, 160, "source title", true), project: searchText(hit.project, 240, "source folder", true),
			computer: searchText(hit.computer, 200, "source computer"), kind: hit.kind, entry: searchText(hit.entry, 200, "source entry"),
			...(hit.parent === undefined ? {} : { parent: searchText(hit.parent, 200, "source ancestor") }), role: hit.role as SearchRole,
			...(hit.tool === undefined ? {} : { tool: searchText(hit.tool, 200, "source tool") }),
			...(hit.at === undefined ? {} : { at: searchInteger(hit.at, 0, 8.64e15, "source time") }),
			start: searchInteger(hit.start, 0, Number.MAX_SAFE_INTEGER, "source offset"), text: searchText(hit.text, 24_000, "source text", true) } satisfies SearchHit;
	});
	let issues: string[] | undefined;
	if (data.issues !== undefined) {
		if (!Array.isArray(data.issues) || data.issues.length > 10) throw Error("Invalid search diagnostics.");
		issues = data.issues.map(issue => searchText(issue, 500, "search diagnostic", true));
	}
	return { origin: SEARCH_ORIGIN, mode: data.mode as SearchResponse["mode"], coverage, hits, truncated: data.truncated,
		warning: searchText(data.warning, 700, "historical evidence warning"),
		...(data.server === undefined ? {} : { server: searchText(data.server, 200, "search server") }), ...(issues ? { issues } : {}) };
}

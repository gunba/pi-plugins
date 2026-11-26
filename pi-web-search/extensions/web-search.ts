import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getPresentation } from "../../pi-ui/index.ts";
import { isLocalUrl, readDirect } from "./direct.ts";
import { renderSearchResult } from "./render.ts";
import { parallelKey, saveParallelKey } from "./settings.ts";
import { recordServiceUsage } from "../../pi-service-usage/index.ts";
export { parallelKey } from "./settings.ts";

/**
 * Web search and page reading for every model, through Parallel's MCP server. Without a key it is free and
 * rate-limited; with an API key, saved from Desk's Accounts & connections into web-search.json in Pi's agent folder or
 * set as PARALLEL_API_KEY, the account is billed at the Search and Extract APIs' prices and the limits are higher.
 * Pages the service could not read, and local network addresses it cannot reach, are read from this computer.
 */
export const ENDPOINT = "https://mcp.parallel.ai/mcp?tools=web_search,web_fetch";
const TIMEOUT_MS = 90_000;
/** Excerpts kept per search result, and results kept per search: a week of searches averaged 12,000 characters each. */
const RESULT_CHARS = 1_200, RESULTS = 8;
/** Text kept per fetched page. */
const PAGE_CHARS = 12_000;

export const SEARCH_PARAMETERS = Type.Object({
	goal: Type.String({ minLength: 1, description: "What to find, as a sentence." }),
	queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "2–3 keyword searches of 3–6 words." }),
}, { additionalProperties: false });
export const FETCH_PARAMETERS = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	goal: Type.Optional(Type.String({ description: "Excerpts focus on it." })),
	full: Type.Optional(Type.Boolean({ description: "Whole text, not excerpts." })),
}, { additionalProperties: false });
type SearchParams = Static<typeof SEARCH_PARAMETERS>;
type FetchParams = Static<typeof FETCH_PARAMETERS>;

type Page = { url: string; title?: string; publish_date?: string; excerpts?: string[]; full_content?: string; direct?: boolean };
type Failure = { url?: string; error?: string; message?: string; error_type?: string; http_status_code?: number | null };
type Payload = { results?: Page[]; errors?: Failure[]; warnings?: unknown[]; session_id?: string };
export type WebDetails = { results?: { url: string; title?: string }[]; errors?: number };

/** One JSON-RPC message from a response, which the server sends as JSON or as a server-sent event stream. */
function message(body: string, type: string, id: number): { result?: unknown; error?: { message?: string } } | undefined {
	if (!/event-stream/.test(type)) return body.trim() ? JSON.parse(body) : undefined;
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const value = JSON.parse(line.slice(5));
		if (value?.id === id) return value;
	}
	return undefined;
}

/**
 * A Streamable HTTP MCP client for one server and key: a session per process, opened on first use and reopened if it
 * lapses. With a key, each call's cost, which the server reports in its result, is recorded in service usage.
 */
export class McpClient {
	private session?: string;
	private opening?: Promise<void>;
	private next = 1;
	private readonly endpoint: string;
	private readonly fetchImpl: typeof fetch;
	private readonly key?: string;

	constructor(endpoint = ENDPOINT, fetchImpl: typeof fetch = fetch, key?: string) {
		this.endpoint = endpoint;
		this.fetchImpl = fetchImpl;
		this.key = key;
	}

	private async post(method: string, params: unknown, signal: AbortSignal, notification = false) {
		const id = this.next++;
		const response = await this.fetchImpl(this.endpoint, { method: "POST", signal, headers: {
			"content-type": "application/json", accept: "application/json, text/event-stream",
			...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
			...(this.session ? { "mcp-session-id": this.session } : {}),
		}, body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id }) }) });
		const session = response.headers.get("mcp-session-id");
		if (session) this.session = session;
		const body = await response.text();
		return { response, body, id };
	}

	private open(signal: AbortSignal): Promise<void> {
		return this.opening ??= (async () => {
			const { response, body } = await this.post("initialize", { protocolVersion: "2025-06-18", capabilities: {},
				clientInfo: { name: "pi-web-search", version: "1" } }, signal);
			if (!response.ok) throw new Error(`Parallel search did not start a session: HTTP ${response.status} ${body.slice(0, 200)}`);
			await this.post("notifications/initialized", {}, signal, true);
		})().catch(error => { this.opening = undefined; this.session = undefined; throw error; });
	}

	/** Calls a tool and returns its text; a lapsed session is reopened once. */
	async call(tool: string, args: Record<string, unknown>, signal: AbortSignal, reopened = false): Promise<string> {
		await this.open(signal);
		const { response, body, id } = await this.post("tools/call", { name: tool, arguments: args }, signal);
		if ((response.status === 404 || response.status === 400 && /session/i.test(body)) && !reopened) {
			this.opening = undefined; this.session = undefined;
			return this.call(tool, args, signal, true);
		}
		if (this.key && (response.status === 401 || response.status === 403))
			throw new Error(`Parallel refused this computer's API key (HTTP ${response.status}). Check it in Settings → Accounts & connections.`);
		if (this.key && response.status === 402) throw new Error("Parallel says the account is out of credit (HTTP 402). Add credit at platform.parallel.ai.");
		if (response.status === 429) throw new Error(this.key ? "Parallel is rate-limiting requests right now. Try again shortly."
			: "Parallel's free search is rate-limited right now. Try again shortly; a Parallel API key in Settings → Accounts & connections raises the limit.");
		// A refused request (4xx) is not charged; any other reply without a reported cost may have been.
		if (this.key && !response.ok && response.status >= 500) this.record(tool);
		if (!response.ok) throw new Error(`Parallel search failed: HTTP ${response.status} ${body.slice(0, 300)}`);
		const reply = message(body, response.headers.get("content-type") ?? "", id);
		if (reply?.error) throw new Error(`Parallel search failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
		const result = reply?.result as { content?: { type: string; text?: string }[]; isError?: boolean; _meta?: Record<string, unknown> } | undefined;
		if (this.key) {
			const usage = result?._meta?.["parallel/usage"];
			this.record(tool, Array.isArray(usage) ? usage.reduce((sum: number, item: { cost_usd?: unknown }) => sum + (typeof item?.cost_usd === "number" ? item.cost_usd : 0), 0) : undefined);
		}
		const text = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
		if (result?.isError) throw new Error(`Parallel search failed: ${text.slice(0, 500)}`);
		return text;
	}

	private record(tool: string, cost?: number): void {
		const warning = recordServiceUsage(getAgentDir(), { service: "parallel", operation: tool === "web_search" ? "search" : "extract", cost, estimated: true });
		if (warning) console.error(warning);
	}
}

/** One client for each key in use, so a key saved or removed while a conversation runs takes effect at its next call. */
const clients = new Map<string, McpClient>();
const client = (key = parallelKey()) => {
	let found = clients.get(key ?? "");
	if (!found) clients.set(key ?? "", found = new McpClient(ENDPOINT, fetch, key));
	return found;
};

function parse(text: string): Payload {
	try { return JSON.parse(text) as Payload; } catch { throw new Error(`Parallel search returned something unexpected: ${text.slice(0, 300)}`); }
}

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()} […]`;
}

const FAILURES: Record<string, string> = { connect_error: "could not connect", http_error: "the site returned an error", timeout: "timed out" };
function failures(payload: Payload): Unread[] {
	return (payload.errors ?? []).map(error => {
		const reason = error.message ?? error.error ?? FAILURES[error.error_type ?? ""] ?? error.error_type ?? "could not be read";
		return { url: error.url ?? "?", reason: `${reason}${error.http_status_code ? ` (HTTP ${error.http_status_code})` : ""}` };
	});
}

/**
 * Without a key the server rate-limits by its own session ID, which each result returns and the conversation's next
 * call passes back, and takes the model's name for its analytics. Calls with a key take neither.
 */
const parallelSessions = new Map<string, string>();
const callerArgs = (ctx: ExtensionContext, key: string | undefined) => {
	if (key) return {};
	const session = parallelSessions.get(ctx.sessionManager.getSessionId());
	return { ...(ctx.model ? { client_model: ctx.model.id } : {}), ...(session ? { session_id: session } : {}) };
};
const remember = (ctx: ExtensionContext, payload: Payload) => {
	if (typeof payload.session_id === "string" && payload.session_id) parallelSessions.set(ctx.sessionManager.getSessionId(), payload.session_id);
	return payload;
};
const timed = (signal: AbortSignal | undefined) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);

/** The search results and fetch failures a call comes down to. */
type Unread = { url: string; reason: string };
type Found = { pages: Page[]; failures: Unread[] };

function searchText({ pages, failures }: Found): AgentToolResult<WebDetails> {
	const lines = pages.map((page, index) => [`${index + 1}. ${page.title?.trim() || page.url}`, `   ${page.url}${page.publish_date ? ` · ${page.publish_date}` : ""}`,
		...page.excerpts?.length ? [clip(page.excerpts.join("\n…\n"), RESULT_CHARS).replace(/^/gm, "   ")] : []].join("\n"));
	const text = [pages.length ? lines.join("\n\n") : "No results.", ...failures.length ? [failures.map(({ url, reason }) => `${url}: ${reason}`).join("\n")] : [],
		...pages.length ? ["web_fetch reads more of a page."] : []].join("\n\n");
	return { content: [{ type: "text", text }], structuredContent: JSON.parse(JSON.stringify({ pages, failures })),
		details: { results: pages.map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })) } };
}

function fetchText({ pages, failures }: Found): AgentToolResult<WebDetails> {
	const sections = pages.map(page => [`## ${page.title?.trim() || page.url}`, page.direct ? `${page.url} · read from this computer` : page.url,
		clip(page.full_content ?? page.excerpts?.join("\n…\n") ?? "", PAGE_CHARS) || "(no text)"].join("\n"));
	const text = [...sections, ...failures.length ? [failures.map(({ url, reason }) => `Could not read ${url}: ${reason}`).join("\n")] : []].join("\n\n") || "Nothing was read.";
	return { content: [{ type: "text", text }], structuredContent: JSON.parse(JSON.stringify({ pages, failures })),
		details: { results: pages.map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })),
		...(failures.length ? { errors: failures.length } : {}) } };
}

/**
 * Parallel's index holds some pages under several URLs that differ only in a cache-busting query, such as
 * ai.google.dev's pricing page four times in one result list. Copies with the same host, path and title become one
 * result with all their excerpts, so they leave room for other pages.
 */
function distinct(pages: Page[]) {
	const kept = new Map<string, Page>();
	for (const page of pages) {
		let id = page.url;
		try { const url = new URL(page.url); id = `${url.host}${url.pathname.replace(/\/$/, "")}\n${page.title?.trim() ?? ""}`; } catch {}
		const first = kept.get(id);
		if (!first) kept.set(id, { ...page });
		else if (page.excerpts?.length) first.excerpts = [...new Set([...first.excerpts ?? [], ...page.excerpts])];
	}
	return [...kept.values()];
}

export async function search(params: SearchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, key = parallelKey(), mcp = client(key)): Promise<AgentToolResult<WebDetails>> {
	const payload = remember(ctx, parse(await mcp.call("web_search", { objective: params.goal, search_queries: params.queries, ...callerArgs(ctx, key) }, timed(signal))));
	return searchText({ pages: distinct(payload.results ?? []).slice(0, RESULTS), failures: failures(payload) });
}

export async function fetchPages(params: FetchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, key = parallelKey(), mcp = client(key)): Promise<AgentToolResult<WebDetails>> {
	const invalid = params.urls.filter(url => !/^https?:$/.test((() => { try { return new URL(url).protocol; } catch { return ""; } })()));
	if (invalid.length) throw new Error(`Not http(s) URLs: ${invalid.join(", ")}`);
	const urls = params.urls.filter(url => !isLocalUrl(url));
	let found: Found = { pages: [], failures: [] };
	if (urls.length) try {
		const payload = remember(ctx, parse(await mcp.call("web_fetch", { urls, ...(params.goal ? { objective: params.goal.slice(0, 200) } : {}),
			...(params.full ? { full_content: true } : {}), ...callerArgs(ctx, key) }, timed(signal))));
		found = { pages: payload.results ?? [], failures: failures(payload) };
	} catch (error) {
		if (signal?.aborted) throw error;
		found.failures = urls.map(url => ({ url, reason: (error as Error).message }));
	}
	// Sites that turn away crawlers' data-centre addresses often answer this computer.
	const unread = [...params.urls.filter(isLocalUrl).map(url => ({ url, reason: "" })), ...found.failures];
	const direct = await Promise.all(unread.map(async ({ url, reason }) => ({ url, reason, read: await readDirect(url, timed(signal)) })));
	for (const { url, reason, read } of direct) {
		if (typeof read !== "string") found.pages.push({ url: read.url, ...(read.title ? { title: read.title } : {}), full_content: read.text, direct: true });
	}
	found.failures = direct.filter(item => typeof item.read === "string")
		.map(({ url, reason, read }) => ({ url, reason: reason ? `${reason}; from this computer, ${read}` : read as string }));
	return fetchText(found);
}

/** The Parallel key for terminal and older Desk clients; current Desk merges it into Accounts & connections. */
function publishSettings(pi: ExtensionAPI): void {
	const remote = getPresentation(pi);
	if (!remote?.capabilities.includes("details") || remote.suspended) return;
	const key = parallelKey(), fromEnvironment = !!process.env.PARALLEL_API_KEY?.trim();
	remote.publish("web-search", { kind: "details", surface: "settings", title: "Web search", data: {
		summary: "web_search and web_fetch use Parallel: free and rate-limited without a key, billed to the account with one. Applies to every conversation on this computer.",
		fields: [{ label: "Service", value: key ? "Parallel (API key)" : "Parallel (free)" }],
		controls: fromEnvironment ? [] : [{ kind: "text", secret: true, label: "Parallel API key", value: "",
			placeholder: key ? "Saved; enter a new key to replace it" : "Paste a key from platform.parallel.ai",
			help: "Saved in this computer's Pi folder (web-search.json), readable only by you.", action: { id: "parallel-key", label: "Save Parallel key" } }],
	}, actions: key && !fromEnvironment ? [{ id: "parallel-remove", label: "Remove Parallel key", destructive: true }] : [] }, {
		"parallel-key": value => { if (typeof value === "string" && value.trim()) { saveParallelKey(value.trim()); publishSettings(pi); } },
		"parallel-remove": () => { saveParallelKey(undefined); publishSettings(pi); },
	});
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	// Another conversation may have saved or removed the key; agent_end keeps this one's page current.
	pi.on("session_start", () => publishSettings(pi));
	pi.on("agent_end", () => publishSettings(pi));
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: "Search the web.",
		promptSnippet: "Search the web",
		promptGuidelines: ["Read pages with web_fetch, not curl; one web_search per question; cite sources as Markdown links."],
		parameters: SEARCH_PARAMETERS,
		renderResult: renderSearchResult,
		execute: (_id, params, signal, _update, ctx) => search(params as SearchParams, signal, ctx),
	});
	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description: "Read web pages, PDFs and files by URL. Use the browser for pages behind a sign-in.",
		promptSnippet: "Read web pages",
		parameters: FETCH_PARAMETERS,
		renderResult: renderSearchResult,
		execute: (_id, params, signal, _update, ctx) => fetchPages(params as FetchParams, signal, ctx),
	});
}

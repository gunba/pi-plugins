import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getPresentation } from "../../pi-ui/index.ts";
import { renderSearchResult } from "./render.ts";
import { exaKey, saveExaKey } from "./settings.ts";
import { recordServiceUsage } from "../../pi-service-usage/index.ts";
export { exaKey } from "./settings.ts";

/**
 * Web search and page reading for every model. Parallel's search service (its MCP server, free without an account)
 * runs them unless this computer has an Exa API key, saved from Desk's Accounts & connections into web-search.json in
 * Pi's agent folder, or set as EXA_API_KEY. Then Exa runs them.
 */
export const ENDPOINT = "https://search.parallel.ai/mcp";
const EXA = "https://api.exa.ai";
const TIMEOUT_MS = 90_000;
/** Excerpts kept per search result. */
const RESULT_CHARS = 1_500;
/** Text kept per fetched page. */
const PAGE_CHARS = 12_000;

export const SEARCH_PARAMETERS = Type.Object({
	goal: Type.String({ minLength: 1, description: "What the search must find, as a sentence; it may name preferred sources or dates." }),
	queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5, description: "Short keyword searches for the goal, 3–6 words each; 2–3 work best." }),
}, { additionalProperties: false });
export const FETCH_PARAMETERS = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20, description: "Pages, PDFs or files to read." }),
	goal: Type.Optional(Type.String({ description: "What to look for; the excerpts returned focus on it." })),
	full: Type.Optional(Type.Boolean({ description: "Each page's whole text instead of excerpts; can be very long." })),
}, { additionalProperties: false });
type SearchParams = Static<typeof SEARCH_PARAMETERS>;
type FetchParams = Static<typeof FETCH_PARAMETERS>;

type Page = { url: string; title?: string; publish_date?: string; excerpts?: string[]; full_content?: string };
type Failure = { url?: string; error?: string; message?: string; error_type?: string; http_status_code?: number | null };
type Payload = { results?: Page[]; errors?: Failure[]; warnings?: unknown[] };
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

/** A Streamable HTTP MCP client for one server: a session per process, opened on first use and reopened if it lapses. */
export class McpClient {
	private session?: string;
	private opening?: Promise<void>;
	private next = 1;
	private readonly endpoint: string;
	private readonly fetchImpl: typeof fetch;

	constructor(endpoint = ENDPOINT, fetchImpl: typeof fetch = fetch) {
		this.endpoint = endpoint;
		this.fetchImpl = fetchImpl;
	}

	private async post(method: string, params: unknown, signal: AbortSignal, notification = false) {
		const id = this.next++;
		const response = await this.fetchImpl(this.endpoint, { method: "POST", signal, headers: {
			"content-type": "application/json", accept: "application/json, text/event-stream",
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
		if (response.status === 429) throw new Error("Parallel's free search is rate-limited right now. Try again shortly; "
			+ "an Exa API key in Settings → Accounts & connections moves this computer's searches to Exa.");
		if (!response.ok) throw new Error(`Parallel search failed: HTTP ${response.status} ${body.slice(0, 300)}`);
		const reply = message(body, response.headers.get("content-type") ?? "", id);
		if (reply?.error) throw new Error(`Parallel search failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
		const result = reply?.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
		const text = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
		if (result?.isError) throw new Error(`Parallel search failed: ${text.slice(0, 500)}`);
		return text;
	}
}

let shared: McpClient | undefined;
const client = () => shared ??= new McpClient();

function parse(text: string): Payload {
	try { return JSON.parse(text) as Payload; } catch { throw new Error(`Parallel search returned something unexpected: ${text.slice(0, 300)}`); }
}

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()} […]`;
}

const FAILURES: Record<string, string> = { connect_error: "could not connect", http_error: "the site returned an error", timeout: "timed out" };
function failures(payload: Payload): string[] {
	return (payload.errors ?? []).map(error => {
		const reason = error.message ?? error.error ?? FAILURES[error.error_type ?? ""] ?? error.error_type ?? "could not be read";
		return `${error.url ?? "?"}: ${reason}${error.http_status_code ? ` (HTTP ${error.http_status_code})` : ""}`;
	});
}

const callerArgs = (ctx: ExtensionContext) => ({ session_id: ctx.sessionManager.getSessionId(), ...(ctx.model ? { model_name: ctx.model.id } : {}) });
const timed = (signal: AbortSignal | undefined) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);

/** The search results and fetch failures both services come down to. */
type Found = { pages: Page[]; failures: string[] };

function searchText({ pages, failures }: Found): AgentToolResult<WebDetails> {
	const lines = pages.map((page, index) => [`${index + 1}. ${page.title?.trim() || page.url}`, `   ${page.url}${page.publish_date ? ` · ${page.publish_date}` : ""}`,
		...page.excerpts?.length ? [clip(page.excerpts.join("\n…\n"), RESULT_CHARS).replace(/^/gm, "   ")] : []].join("\n"));
	const text = [pages.length ? lines.join("\n\n") : "No results.", ...failures.length ? [failures.join("\n")] : [],
		...pages.length ? ["web_fetch reads more of a page."] : []].join("\n\n");
	return { content: [{ type: "text", text }], details: { results: pages.map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })) } };
}

function fetchText({ pages, failures }: Found): AgentToolResult<WebDetails> {
	const sections = pages.map(page => [`## ${page.title?.trim() || page.url}`, page.url,
		clip(page.full_content ?? page.excerpts?.join("\n…\n") ?? "", PAGE_CHARS) || "(no text)"].join("\n"));
	const text = [...sections, ...failures.length ? [failures.map(line => `Could not read ${line}`).join("\n")] : []].join("\n\n") || "Nothing was read.";
	return { content: [{ type: "text", text }], details: { results: pages.map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })),
		...(failures.length ? { errors: failures.length } : {}) } };
}

async function exa(path: string, body: Record<string, unknown>, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
	let response: Response, text: string;
	const record = (cost?: number) => {
		const warning = recordServiceUsage(getAgentDir(), { service: "exa", operation: path.slice(1), cost, estimated: true });
		if (warning) console.error(warning);
	};
	try {
		response = await fetchImpl(`${EXA}${path}`, { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
		text = await response.text();
	} catch (error) { record(); throw error; }
	let payload: Record<string, unknown> | undefined;
	try { payload = JSON.parse(text); } catch { /* The request may still have been charged. */ }
	const cost = (payload?.costDollars as { total?: unknown } | undefined)?.total;
	// A request Exa refused (4xx) is not charged; any other reply without a cost may have been.
	if (typeof cost === "number") record(cost); else if (response.status < 400 || response.status >= 500) record();
	if (response.status === 401 || response.status === 403) throw new Error(`Exa refused this computer's API key (HTTP ${response.status}). Check it in Settings → Accounts & connections.`);
	if (response.status === 402) throw new Error("Exa says the account is out of credit (HTTP 402). Add credit at dashboard.exa.ai.");
	if (response.status === 429) throw new Error("Exa is rate-limiting requests right now. Try again shortly.");
	if (!response.ok) throw new Error(`Exa failed: HTTP ${response.status} ${text.slice(0, 300)}`);
	if (!payload || typeof payload !== "object") throw new Error(`Exa returned something unexpected: ${text.slice(0, 300)}`);
	return payload;
}
type ExaPage = { url: string; title?: string | null; publishedDate?: string | null; highlights?: string[]; text?: string };
const exaPage = (page: ExaPage): Page => ({ url: page.url, ...(page.title ? { title: page.title } : {}), ...(page.publishedDate ? { publish_date: page.publishedDate.slice(0, 10) } : {}),
	...(page.highlights?.length ? { excerpts: page.highlights } : {}), ...(page.text !== undefined ? { full_content: page.text } : {}) });
/** Results localized to this computer's country, from its locale (en-AU gives AU). */
const country = () => /^[a-z]{2,3}-([A-Z]{2})\b/.exec(Intl.DateTimeFormat().resolvedOptions().locale)?.[1];

/** Each query is its own Exa search, guided by the goal; results are interleaved by rank and deduplicated. */
async function exaSearch(params: SearchParams, key: string, signal: AbortSignal): Promise<Found> {
	const location = country();
	const replies = await Promise.all(params.queries.map(query => exa("/search", { query, type: "auto", numResults: 5, objective: params.goal,
		...(location ? { userLocation: location } : {}), contents: { highlights: { maxCharacters: RESULT_CHARS } } }, key, signal)));
	const lists = replies.map(reply => (reply.results ?? []) as ExaPage[]), pages: Page[] = [], seen = new Set<string>();
	for (let rank = 0; pages.length < 10 && lists.some(list => rank < list.length); rank++)
		for (const list of lists) {
			const page = list[rank];
			if (page && !seen.has(page.url) && pages.length < 10) { seen.add(page.url); pages.push(exaPage(page)); }
		}
	return { pages, failures: [] };
}

async function exaFetch(params: FetchParams, key: string, signal: AbortSignal): Promise<Found> {
	const reply = await exa("/contents", { urls: params.urls, ...params.full ? { text: true }
		: params.goal ? { highlights: { query: params.goal, maxCharacters: 4_000 } } : { text: { maxCharacters: PAGE_CHARS } } }, key, signal);
	const statuses = (reply.statuses ?? []) as { id: string; status: string; error?: { tag?: string; httpStatusCode?: number | null } }[];
	return { pages: ((reply.results ?? []) as ExaPage[]).map(exaPage),
		failures: statuses.filter(status => status.status !== "success").map(status =>
			`${status.id}: ${status.error?.tag ?? "could not be read"}${status.error?.httpStatusCode ? ` (HTTP ${status.error.httpStatusCode})` : ""}`) };
}

export async function search(params: SearchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, mcp = client()): Promise<AgentToolResult<WebDetails>> {
	const key = exaKey();
	if (key) return searchText(await exaSearch(params, key, timed(signal)));
	const payload = parse(await mcp.call("web_search", { objective: params.goal, search_queries: params.queries, ...callerArgs(ctx) }, timed(signal)));
	return searchText({ pages: payload.results ?? [], failures: failures(payload) });
}

export async function fetchPages(params: FetchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, mcp = client()): Promise<AgentToolResult<WebDetails>> {
	const invalid = params.urls.filter(url => !/^https?:$/.test((() => { try { return new URL(url).protocol; } catch { return ""; } })()));
	if (invalid.length) throw new Error(`Not http(s) URLs: ${invalid.join(", ")}`);
	const key = exaKey();
	if (key) return fetchText(await exaFetch(params, key, timed(signal)));
	const payload = parse(await mcp.call("web_fetch", { urls: params.urls, ...(params.goal ? { objective: params.goal.slice(0, 200) } : {}),
		...(params.full ? { full_content: true } : {}), ...callerArgs(ctx) }, timed(signal)));
	return fetchText({ pages: payload.results ?? [], failures: failures(payload) });
}

/** Exa settings for terminal and older Desk clients; current Desk merges them into Accounts & connections. */
function publishSettings(pi: ExtensionAPI): void {
	const remote = getPresentation(pi);
	if (!remote?.capabilities.includes("details") || remote.suspended) return;
	const key = exaKey(), fromEnvironment = !!process.env.EXA_API_KEY?.trim();
	remote.publish("web-search", { kind: "details", surface: "settings", title: "Web search", data: {
		summary: "web_search and web_fetch use Parallel's free search unless this computer has an Exa API key; then they use Exa, "
			+ "which ranks higher in independent tests and is billed per request. Applies to every conversation on this computer.",
		fields: [{ label: "Service", value: key ? "Exa" : "Parallel (free)" }],
		controls: fromEnvironment ? [] : [{ kind: "text", secret: true, label: "Exa API key", value: "",
			placeholder: key ? "Saved; enter a new key to replace it" : "Paste a key from dashboard.exa.ai",
			help: "Saved in this computer's Pi folder (web-search.json), readable only by you.", action: { id: "exa-key", label: "Save Exa key" } }],
	}, actions: key && !fromEnvironment ? [{ id: "exa-remove", label: "Remove Exa key", destructive: true }] : [] }, {
		"exa-key": value => { if (typeof value === "string" && value.trim()) { saveExaKey(value.trim()); publishSettings(pi); } },
		"exa-remove": () => { saveExaKey(undefined); publishSettings(pi); },
	});
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	// Another conversation may have saved or removed the key; agent_end keeps this one's page current.
	pi.on("session_start", () => publishSettings(pi));
	pi.on("agent_end", () => publishSettings(pi));
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: "Search the web for current information. Returns ranked pages with excerpts that usually answer the goal directly.",
		promptSnippet: "Search the web",
		promptGuidelines: ["Use web_search to find current facts and web_fetch to read pages (not curl or scripts); one web_search per independent question, and cite sources with Markdown links."],
		parameters: SEARCH_PARAMETERS,
		renderResult: renderSearchResult,
		execute: (_id, params, signal, _update, ctx) => search(params as SearchParams, signal, ctx),
	});
	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description: "Read web pages, PDFs and other files by URL, including pages that need JavaScript: excerpts focused on the goal, or the whole text. For pages behind a sign-in, use the browser tools.",
		promptSnippet: "Read web pages",
		parameters: FETCH_PARAMETERS,
		renderResult: renderSearchResult,
		execute: (_id, params, signal, _update, ctx) => fetchPages(params as FetchParams, signal, ctx),
	});
}

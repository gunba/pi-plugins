import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderSearchResult } from "./render.ts";

/**
 * Web search and page reading for every model, through Parallel's search service (its MCP server, which is free
 * without an account). A Parallel API key raises the free rate limits: PARALLEL_API_KEY, or a "parallel" entry
 * ({ "type": "api_key", "key": "…" }) in Pi's auth.json.
 */
export const ENDPOINT = "https://search.parallel.ai/mcp";
const TIMEOUT_MS = 90_000;
/** Excerpts kept per search result; the whole result is cut again by pi-output-budget. */
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

function apiKey(): string | undefined {
	if (process.env.PARALLEL_API_KEY?.trim()) return process.env.PARALLEL_API_KEY.trim();
	try {
		const entry = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"))?.parallel;
		return typeof entry?.key === "string" && entry.key.trim() ? entry.key.trim() : undefined;
	} catch { return undefined; }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
		const id = this.next++, key = apiKey();
		const response = await this.fetchImpl(this.endpoint, { method: "POST", signal, headers: {
			"content-type": "application/json", accept: "application/json, text/event-stream",
			...(this.session ? { "mcp-session-id": this.session } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}),
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
			+ "a Parallel API key (PARALLEL_API_KEY, or \"parallel\" in Pi's auth.json) raises the limit.");
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

export async function search(params: SearchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, mcp = client()): Promise<AgentToolResult<WebDetails>> {
	const payload = parse(await mcp.call("web_search", { objective: params.goal, search_queries: params.queries, ...callerArgs(ctx) }, timed(signal)));
	const kept = payload.results ?? [];
	const lines = kept.map((page, index) => [`${index + 1}. ${page.title?.trim() || page.url}`, `   ${page.url}${page.publish_date ? ` · ${page.publish_date}` : ""}`,
		...page.excerpts?.length ? [clip(page.excerpts.join("\n…\n"), RESULT_CHARS).replace(/^/gm, "   ")] : []].join("\n"));
	const notes = failures(payload);
	const text = [kept.length ? lines.join("\n\n") : "No results.", ...notes.length ? [notes.join("\n")] : [],
		...kept.length ? ["web_fetch reads more of a page."] : []].join("\n\n");
	return { content: [{ type: "text", text }],
		details: { results: kept.map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })) } };
}

export async function fetchPages(params: FetchParams, signal: AbortSignal | undefined, ctx: ExtensionContext, mcp = client()): Promise<AgentToolResult<WebDetails>> {
	const urls = params.urls;
	const invalid = urls.filter(url => !/^https?:$/.test((() => { try { return new URL(url).protocol; } catch { return ""; } })()));
	if (invalid.length) throw new Error(`Not http(s) URLs: ${invalid.join(", ")}`);
	const payload: Payload = urls.length ? parse(await mcp.call("web_fetch", { urls, ...(params.goal ? { objective: params.goal.slice(0, 200) } : {}),
		...(params.full ? { full_content: true } : {}), ...callerArgs(ctx) }, timed(signal))) : {};
	const sections = (payload.results ?? []).map(page => [`## ${page.title?.trim() || page.url}`, page.url,
		clip(page.full_content ?? page.excerpts?.join("\n…\n") ?? "", PAGE_CHARS) || "(no text)"].join("\n"));
	const notes = failures(payload).map(line => `Could not read ${line}`);
	const text = [...sections, ...notes.length ? [notes.join("\n")] : []].join("\n\n") || "Nothing was read.";
	return { content: [{ type: "text", text }],
		details: { results: (payload.results ?? []).map(page => ({ url: page.url, ...(page.title ? { title: page.title } : {}) })),
			...(payload.errors?.length ? { errors: payload.errors.length } : {}) } };
}

export default function webSearchExtension(pi: ExtensionAPI): void {
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

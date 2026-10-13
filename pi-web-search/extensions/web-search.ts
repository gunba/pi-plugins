import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
	CODEX_TOOL_OUTPUT_TOKEN_BUDGET,
	isChatGptCodexModel,
} from "../../pi-codex-compat/extensions/model-tools.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { renderSearchResult } from "./render.ts";
import { requestService } from "../../pi-codex-service/index.ts";
import { describePage, fetchPages, type PageResult } from "./page-fetch.ts";

const searchQuery = Type.Object(
	{
		q: Type.String({ description: "Search query." }),
		recency: Type.Optional(
			Type.Integer({
				description: "Only include results from this many recent days.",
				minimum: 0,
			}),
		),
		domains: Type.Optional(
			Type.Array(Type.String(), {
				description: "Only include results from these domains.",
			}),
		),
	},
	{ additionalProperties: false },
);

const openOperation = Type.Object(
	{
		ref_id: Type.String({ description: "Search reference ID or URL to open." }),
		lineno: Type.Optional(
			Type.Integer({ description: "Line number to position the page at.", minimum: 0 }),
		),
	},
	{ additionalProperties: false },
);

const clickOperation = Type.Object(
	{
		ref_id: Type.String({ description: "Reference ID containing the numbered link." }),
		id: Type.Integer({ description: "Numbered link ID to open.", minimum: 0 }),
	},
	{ additionalProperties: false },
);

const findOperation = Type.Object(
	{
		ref_id: Type.String({ description: "Search reference ID or URL to search within." }),
		pattern: Type.String({ description: "Text pattern to find." }),
	},
	{ additionalProperties: false },
);

const screenshotOperation = Type.Object(
	{
		ref_id: Type.String({ description: "PDF reference ID or URL." }),
		pageno: Type.Integer({ description: "Zero-indexed PDF page number.", minimum: 0 }),
	},
	{ additionalProperties: false },
);

const financeOperation = Type.Object(
	{
		ticker: Type.String({ description: "Ticker symbol." }),
		type: StringEnum(["equity", "fund", "crypto", "index"] as const),
		market: Type.Optional(
			Type.String({
				description:
					'ISO 3166-1 alpha-3 country code, "OTC", or an empty string for cryptocurrency.',
			}),
		),
	},
	{ additionalProperties: false },
);

const weatherOperation = Type.Object(
	{
		location: Type.String({ description: 'Location in "Country, Area, City" format.' }),
		start: Type.Optional(
			Type.String({ description: "Start date in YYYY-MM-DD format. Defaults to today." }),
		),
		duration: Type.Optional(
			Type.Integer({ description: "Number of days to return. Defaults to 7.", minimum: 1 }),
		),
	},
	{ additionalProperties: false },
);

const sportsOperation = Type.Object(
	{
		tool: Type.Optional(StringEnum(["sports"] as const)),
		fn: StringEnum(["schedule", "standings"] as const),
		league: StringEnum(
			["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const,
		),
		team: Type.Optional(
			Type.String({ description: "Common three- or four-letter broadcast team alias." }),
		),
		opponent: Type.Optional(Type.String()),
		date_from: Type.Optional(Type.String({ description: "Start date in YYYY-MM-DD format." })),
		date_to: Type.Optional(Type.String({ description: "End date in YYYY-MM-DD format." })),
		num_games: Type.Optional(Type.Integer({ minimum: 1 })),
		locale: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const timeOperation = Type.Object(
	{
		utc_offset: Type.String({ description: 'UTC offset such as "+03:00".' }),
	},
	{ additionalProperties: false },
);

// Only the operations conversations use. Codex web search also offers sports, finance, weather, time,
// PDF screenshots and image search; none were used in 90 days, so they are not declared to the model.
export const WEB_SEARCH_PARAMETERS = Type.Object(
	{
		search_query: Type.Optional(
			Type.Array(searchQuery, { description: "Up to four web searches.", maxItems: 4 }),
		),
		open: Type.Optional(Type.Array(openOperation, { description: "Open pages by reference ID or URL." })),
		click: Type.Optional(Type.Array(clickOperation, { description: "Follow numbered links in opened pages." })),
		find: Type.Optional(Type.Array(findOperation, { description: "Find text in opened pages." })),
		check: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), {
				description: "Check up to 50 URLs load, without reading them: ok, not_found, blocked, http_error or network_error.",
				maxItems: 50,
			}),
		),
		response_length: Type.Optional(StringEnum(["short", "medium", "long"] as const)),
	},
	{ additionalProperties: false },
);

export type SearchQuery = {
	q: string;
	recency?: number;
	domains?: string[];
};

export type WebSearchParams = {
	search_query?: SearchQuery[];
	image_query?: SearchQuery[];
	open?: Array<{ ref_id: string; lineno?: number }>;
	click?: Array<{ ref_id: string; id: number }>;
	find?: Array<{ ref_id: string; pattern: string }>;
	screenshot?: Array<{ ref_id: string; pageno: number }>;
	finance?: Array<{
		ticker: string;
		type: "equity" | "fund" | "crypto" | "index";
		market?: string;
	}>;
	weather?: Array<{ location: string; start?: string; duration?: number }>;
	sports?: Array<{
		tool?: "sports";
		fn: "schedule" | "standings";
		league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
		team?: string;
		opponent?: string;
		date_from?: string;
		date_to?: string;
		num_games?: number;
		locale?: string;
	}>;
	time?: Array<{ utc_offset: string }>;
	check?: string[];
	response_length?: "short" | "medium" | "long";
};

export type WebSearchDetails = {
	/** The Codex model that ran the search, when Codex was used. */
	model?: string;
	results?: unknown[];
	/** Pages read or checked directly or in Chrome. */
	pages?: Array<Omit<PageResult, "text">>;
};

type UnknownRecord = Record<string, unknown>;

export type WebSearchDependencies = {
	fetchImpl?: typeof globalThis.fetch;
};

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSearchResponse(text: string): { output: string; results?: unknown[] } {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("Codex search returned invalid JSON");
	}
	if (!isRecord(payload) || typeof payload.output !== "string") {
		throw new Error("Codex search response did not contain output");
	}
	return {
		output: payload.output,
		results: Array.isArray(payload.results) ? payload.results : undefined,
	};
}

const COMMANDS = ["search_query", "image_query", "open", "click", "find", "screenshot", "finance", "weather", "sports", "time"] as const;
const NOT_ACCESSIBLE = /URL (\S+) is not accessible via this tool\./g;
const SEPARATOR = "\n" + "-".repeat(80) + "\n";

/** The Codex model for search: this conversation's, else the computer's default Codex model, else any signed-in one. */
export function searchModel(ctx: ExtensionContext): ExtensionContext["model"] | undefined {
	if (ctx.model && isChatGptCodexModel(ctx.model)) return ctx.model;
	const available = ctx.modelRegistry.getAvailable().filter(model => isChatGptCodexModel(model));
	if (!available.length) return;
	let preferred: string | undefined;
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
		if (settings.defaultProvider === "openai-codex") preferred = settings.defaultModel;
	} catch { /* No saved default. */ }
	return available.find(model => model.id === preferred)
		?? [...available].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

function pageSection(result: PageResult): string {
	return describePage(result) + (result.text ? `\n\n${result.text}${result.truncated ? "\n[…truncated]" : ""}` : "");
}

export async function executeWebSearch(
	params: WebSearchParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	dependencies: WebSearchDependencies = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	if (signal?.aborted) throw new Error("web_search aborted");
	const abort = signal ?? new AbortController().signal;
	const { check, ...commands } = params;
	const requested = COMMANDS.filter(name => commands[name]?.length);
	const sections: string[] = [], pages: PageResult[] = [];
	let model: ExtensionContext["model"] | undefined, results: unknown[] | undefined;
	if (requested.length) {
		model = searchModel(ctx);
		if (model) {
			const text = await requestService(ctx, model, {
				path: "alpha/search", codex: true, label: "Codex search",
				maxResponseBytes: 32 * 1024 * 1024,
				body: {
					id: ctx.sessionManager.getSessionId(),
					model: model.id,
					commands,
					settings: {
						allowed_callers: ["direct"],
						external_web_access: true,
					},
					max_output_tokens: CODEX_TOOL_OUTPUT_TOKEN_BUDGET,
				},
			}, signal, dependencies.fetchImpl);
			const response = parseSearchResponse(text);
			results = response.results;
			sections.push(response.output);
			// Codex reports bot-protected and missing pages alike, and can skip opens batched with a search.
			// Fetch those here so the outcome is known.
			const skipped = (commands.open ?? []).map(item => item.ref_id)
				.filter(ref => /^https?:\/\//.test(ref) && !response.output.includes(`"ref_id":${JSON.stringify(ref)}`));
			const refused = [...new Set([...[...response.output.matchAll(NOT_ACCESSIBLE)].map(match => match[1]!.replace(/[.,;]+$/, "")), ...skipped])]
				.filter(url => /^https?:\/\//.test(url));
			if (refused.length) {
				const fetched = await fetchPages(refused, { text: true, maxChars: 12_000 }, abort);
				pages.push(...fetched);
				sections.push(`Codex search did not open ${refused.length === 1 ? "this page" : "these pages"}, so ${refused.length === 1 ? "it was" : "they were"} fetched directly:\n\n${fetched.map(pageSection).join(SEPARATOR)}`);
			}
		} else {
			const urls = (commands.open ?? []).map(item => item.ref_id).filter(ref => /^https?:\/\//.test(ref));
			const unsupported = requested.filter(name => name !== "open");
			if (!urls.length && !check?.length) throw new Error("Web search needs a ChatGPT login on this computer. Without one, web_search can only open or check URLs; use the browser tools to search.");
			if (urls.length) {
				const fetched = await fetchPages(urls, { text: true, maxChars: 12_000 }, abort);
				pages.push(...fetched);
				sections.push(fetched.map(pageSection).join(SEPARATOR));
			}
			if (unsupported.length || urls.length < (commands.open?.length ?? 0))
				sections.push(`Not done: ${[...unsupported, ...(urls.length < (commands.open?.length ?? 0) ? ["open by reference ID"] : [])].join(", ")}. These need Codex search, which needs a ChatGPT login on this computer.`);
		}
	}
	if (check?.length) {
		const checked = await fetchPages(check.map(url => url.trim()), { text: false, maxChars: 2000 }, abort);
		pages.push(...checked);
		const counts = checked.reduce<Record<string, number>>((all, page) => ({ ...all, [page.outcome]: (all[page.outcome] ?? 0) + 1 }), {});
		sections.push(`Checked ${checked.length} URL${checked.length === 1 ? "" : "s"}: ${Object.entries(counts).map(([outcome, count]) => `${count} ${outcome}`).join(", ")}\n\n${checked.map(describePage).join("\n")}`);
	}
	if (!sections.length) throw new Error("Give web_search at least one search, page or URL to check.");
	return {
		content: [{ type: "text", text: sections.join(SEPARATOR) }],
		details: {
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			...(results ? { results } : {}),
			...(pages.length ? { pages: pages.map(({ text: _text, ...page }) => page) } : {}),
		},
	};
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "web.run",
		description:
			"Search the web, open pages, follow links, find text and check URLs, through the ChatGPT login whatever model this conversation uses. Sites that refuse automated clients are opened in Chrome. For sign-ins or forms use the browser tools.",
		promptSnippet: "Search the web, open pages and check links",
		promptGuidelines: [
			"Use web_search when asked to search or to verify current facts; batch independent searches in one call, and cite sources with Markdown links.",
			"Open or check URLs with web_search, not curl or scripts. \"blocked\" means the site refused automated access, not that the page is missing.",
		],
		parameters: WEB_SEARCH_PARAMETERS,
		renderResult: renderSearchResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWebSearch(params as WebSearchParams, signal, ctx);
		},
	});
}

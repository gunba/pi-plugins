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
import { renderSearchResult } from "./render.ts";
import { requestService } from "../../pi-codex-service/index.ts";

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

export const WEB_SEARCH_PARAMETERS = Type.Object(
	{
		search_query: Type.Optional(
			Type.Array(searchQuery, {
				description: "Query the internet search engine. Batch up to four queries.",
				maxItems: 4,
			}),
		),
		image_query: Type.Optional(
			Type.Array(searchQuery, {
				description: "Query the image search engine. Batch up to two queries.",
				maxItems: 2,
			}),
		),
		open: Type.Optional(
			Type.Array(openOperation, { description: "Open pages by reference ID or URL." }),
		),
		click: Type.Optional(
			Type.Array(clickOperation, { description: "Open numbered links from fetched pages." }),
		),
		find: Type.Optional(
			Type.Array(findOperation, { description: "Find text patterns in pages." }),
		),
		screenshot: Type.Optional(
			Type.Array(screenshotOperation, { description: "Take screenshots of PDF pages." }),
		),
		finance: Type.Optional(
			Type.Array(financeOperation, { description: "Look up market prices." }),
		),
		weather: Type.Optional(
			Type.Array(weatherOperation, { description: "Look up weather forecasts." }),
		),
		sports: Type.Optional(
			Type.Array(sportsOperation, { description: "Look up sports schedules or standings." }),
		),
		time: Type.Optional(
			Type.Array(timeOperation, { description: "Get the current time for UTC offsets." }),
		),
		response_length: Type.Optional(
			StringEnum(["short", "medium", "long"] as const, {
				description: "Amount of search output to return.",
			}),
		),
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
	response_length?: "short" | "medium" | "long";
};

export type WebSearchDetails = {
	model: string;
	results?: unknown[];
};

type UnknownRecord = Record<string, unknown>;

export type WebSearchDependencies = {
	fetchImpl?: typeof globalThis.fetch;
};

export type WebSearchActivationState = {
	enabled: boolean;
	eligible?: boolean;
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

export async function executeWebSearch(
	params: WebSearchParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	dependencies: WebSearchDependencies = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const model = ctx.model;
	if (!model || !isChatGptCodexModel(model)) {
		throw new Error("web_search requires a ChatGPT Codex model");
	}
	if (signal?.aborted) throw new Error("web_search aborted");
	const text = await requestService(ctx, model, {
		path: "alpha/search", codex: true, label: "Codex search",
		maxResponseBytes: 32 * 1024 * 1024,
		body: {
			id: ctx.sessionManager.getSessionId(),
			model: model.id,
			commands: params,
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: CODEX_TOOL_OUTPUT_TOKEN_BUDGET,
		},
	}, signal, dependencies.fetchImpl);
	const result = parseSearchResponse(text);
	return {
		content: [{ type: "text", text: result.output }],
		details: {
			model: `${model.provider}/${model.id}`,
			results: result.results,
		},
	};
}

export function syncWebSearchTool(
	activeTools: string[],
	model: ExtensionContext["model"],
	state: WebSearchActivationState,
): { activeTools: string[]; state: WebSearchActivationState } {
	const currentlyActive = activeTools.includes("web_search");
	let eligible = state.eligible ?? currentlyActive;
	if (state.enabled && !currentlyActive) eligible = false;
	if (!state.enabled && currentlyActive) eligible = true;
	const base = activeTools.filter((name) => name !== "web_search");
	const enabled = eligible && isChatGptCodexModel(model);
	return {
		activeTools: enabled ? [...base, "web_search"] : base,
		state: { enabled, eligible },
	};
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	let activationState: WebSearchActivationState = { enabled: false };
	const syncTools = (model: ExtensionContext["model"]): void => {
		const result = syncWebSearchTool(pi.getActiveTools(), model, activationState);
		activationState = result.state;
		if (result.activeTools.join("\0") !== pi.getActiveTools().join("\0")) {
			pi.setActiveTools(result.activeTools);
		}
	};
	pi.on("session_start", (_event, ctx) => syncTools(ctx.model));
	pi.on("model_select", (event) => syncTools(event.model));
	pi.registerTool({
		name: "web_search",
		label: "web.run",
		description:
			"Access the internet through Codex standalone search. Supports batched web/image queries, opening results or URLs, clicking links, finding page text, PDF screenshots, finance, weather, sports, and time. The request always uses the currently selected ChatGPT Codex model and never selects a fallback or summary model.",
		promptSnippet:
			"Access the internet through Codex standalone search using the currently selected model",
		promptGuidelines: [
			"Use web_search when the user asks to search or when current, unstable information must be verified.",
			"Batch independent searches in one web_search call, with no more than four search_query entries.",
			"When web_search returns sources, cite the supporting pages with Markdown links.",
		],
		parameters: WEB_SEARCH_PARAMETERS,
		renderResult: renderSearchResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWebSearch(params as WebSearchParams, signal, ctx);
		},
	});
}

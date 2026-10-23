import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { renderSearchResult, searchDisplayText } from "./render.ts";
import { requestService } from "../../pi-codex-service/index.ts";
import { describePage, fetchPages, type PageResult } from "./page-fetch.ts";

const referenced = (description: string) => Type.String({ description });

// Only the operations conversations use. Codex web search also offers sports, finance, weather, time,
// PDF screenshots and image search; none were used in 90 days, so they are not declared to the model.
export const WEB_SEARCH_PARAMETERS = Type.Object(
	{
		search_query: Type.Optional(Type.Array(Type.Object({
			q: Type.String(),
			recency: Type.Optional(Type.Integer({ description: "Only the last this many days." })),
			domains: Type.Optional(Type.Array(Type.String())),
		}), { maxItems: 4 })),
		open: Type.Optional(Type.Array(Type.Object({
			ref_id: referenced("Result ID or URL."),
			lineno: Type.Optional(Type.Integer({ description: "Line to start at." })),
		}))),
		click: Type.Optional(Type.Array(Type.Object({ ref_id: referenced("Opened page's ID."), id: Type.Integer({ description: "Link number." }) }))),
		find: Type.Optional(Type.Array(Type.Object({ ref_id: referenced("Opened page's ID or URL."), pattern: Type.String() }))),
		check: Type.Optional(Type.Array(Type.String(), { description: "URLs to check load, without reading them.", maxItems: 50 })),
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
	open?: Array<{ ref_id: string; lineno?: number }>;
	click?: Array<{ ref_id: string; id: number }>;
	find?: Array<{ ref_id: string; pattern: string }>;
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

const COMMANDS = ["search_query", "open", "click", "find"] as const;
const NOT_ACCESSIBLE = /URL (\S+) is not accessible via this tool\./g;
// Codex's own fetch failures: "restricted URL", 403s from bot protection, timeouts, content types it does not read.
const FETCH_FAILED = /Failed to fetch (https?:\/\/\S+?): /g;

/**
 * Codex search output as plain text. Citation markers become [turn0view0] and [3] Link text, keeping the IDs open,
 * click and find take; ChatGPT's quoting limits and empty error headers are dropped.
 */
export function plainSearchText(output: string): string {
	return searchDisplayText(output.replace(/^Internal Error \(\)\n?/gm, "").replace(/ ?\[wordlim: \d+\]/g, ""));
}
const SEPARATOR = "\n" + "-".repeat(80) + "\n";
/** The max_output_tokens a search asks Codex for. */
const SEARCH_OUTPUT_TOKENS = 10_000;

/** A model reached through a ChatGPT (Codex) sign-in, whose account search uses. */
function isChatGptCodexModel(model: { provider?: string; api?: string } | null | undefined): boolean {
	const provider = model?.provider?.trim().toLowerCase() ?? "", api = model?.api?.trim().toLowerCase();
	return api === "openai-codex-responses" || ["codex", "openai-codex", "chatgpt"].includes(provider);
}

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
					max_output_tokens: SEARCH_OUTPUT_TOKENS,
				},
			}, signal, dependencies.fetchImpl);
			const response = parseSearchResponse(text);
			results = response.results;
			sections.push(plainSearchText(response.output));
			// Codex reports bot-protected and missing pages alike, and can skip opens batched with a search.
			// Fetch those here so the outcome is known.
			const skipped = (commands.open ?? []).map(item => item.ref_id)
				.filter(ref => /^https?:\/\//.test(ref) && !response.output.includes(`"ref_id":${JSON.stringify(ref)}`));
			const reported = [...response.output.matchAll(NOT_ACCESSIBLE), ...response.output.matchAll(FETCH_FAILED)].map(match => match[1]!.replace(/[.,;]+$/, ""));
			const refused = [...new Set([...reported, ...skipped])]
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
			"Use web_search to search, verify current facts, and open or check URLs (not curl or scripts); batch independent searches and cite sources with Markdown links. \"blocked\" means the site refused automated access, not that the page is missing.",
		],
		parameters: WEB_SEARCH_PARAMETERS,
		renderResult: renderSearchResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeWebSearch(params as WebSearchParams, signal, ctx);
		},
	});
}

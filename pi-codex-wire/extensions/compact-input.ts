import { clampThinkingLevel, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages, convertResponsesTools, createGrammarToolInputProperties, splitDeferredTools } from "./serializer.ts";
import type { JsonObject } from "./diagnostics.ts";

/** Public Pi serializers preserve native tool arguments, results, images and reasoning. */
export function compactInput(model: Model<Api>, context: Context, thinking: NonNullable<ExtensionContext["thinkingLevel"]>): JsonObject {
	const supportsGrammar = model.compat && "supportsOpenAIGrammarTools" in model.compat
		? model.compat.supportsOpenAIGrammarTools === true : false;
	const compat = model.compat as { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean } | undefined;
	const deferredToolsMode = compat?.supportsAdditionalTools ? "additional-tools" : compat?.supportsToolSearch ? "tool-search" : undefined;
	const placement = splitDeferredTools(context, deferredToolsMode !== undefined);
	const toolOptions = { strict: null, supportsStrictMode: false, supportsOpenAIGrammarTools: supportsGrammar };
	const level = clampThinkingLevel(model, thinking);
	const effort = level === "off" ? undefined : (model.thinkingLevelMap?.[level] ?? level);
	return {
		model: model.id, instructions: context.systemPrompt ?? "", parallel_tool_calls: true,
		input: convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), {
			includeSystemPrompt: false,
			grammarToolInputProperties: createGrammarToolInputProperties(context.tools, supportsGrammar),
			deferredTools: placement.deferred, deferredToolsMode, toolOptions,
		}),
		tools: convertResponsesTools(placement.immediate, toolOptions),
		...(effort !== undefined && effort !== null ? { reasoning: { effort } } : {}),
	};
}

export function codexRequestAuth(baseUrl: string, token: string | undefined, modelHeaders?: Record<string, string>, extra?: Record<string, string | null>): { url: string; headers: Headers } {
	const endpoint = new URL(baseUrl);
	if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") throw new Error("Native compaction requires the ChatGPT Codex endpoint.");
	const path = endpoint.pathname.replace(/\/+$/, "");
	endpoint.pathname = path.endsWith("/codex/responses") ? path : path.endsWith("/codex") ? `${path}/responses` : `${path}/codex/responses`;
	let account: unknown;
	try { account = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id; }
	catch { /* Report no token contents. */ }
	if (!token || typeof account !== "string" || !account) throw new Error("Native compaction requires a Codex account token.");
	const headers = new Headers(modelHeaders);
	for (const [name, value] of Object.entries(extra ?? {})) {
		if (value === null) headers.delete(name); else headers.set(name, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", account);
	return { url: endpoint.toString(), headers };
}

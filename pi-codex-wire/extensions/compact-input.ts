import { clampThinkingLevel, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages, convertResponsesTools, createGrammarToolInputProperties,
	getCurrentSystemPrompt, getDeclaredTools, normalizeContext, resolveTranscriptTools } from "./serializer.ts";
import type { JsonObject } from "./diagnostics.ts";

/** Public Pi serializers preserve native tool arguments, results, images and reasoning. */
export function compactInput(model: Model<Api>, context: Context, thinking: NonNullable<ExtensionContext["thinkingLevel"]>): JsonObject {
	const supportsGrammar = model.compat && "supportsOpenAIGrammarTools" in model.compat
		? model.compat.supportsOpenAIGrammarTools === true : false;
	const compat = model.compat as { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean } | undefined;
	const transcript = normalizeContext(context);
	const placement = resolveTranscriptTools(transcript.messages, !!(compat?.supportsAdditionalTools || compat?.supportsToolSearch));
	const toolOptions = { strict: null, supportsStrictMode: false, supportsOpenAIGrammarTools: supportsGrammar };
	const level = clampThinkingLevel(model, thinking);
	const effort = level === "off" ? undefined : (model.thinkingLevelMap?.[level] ?? level);
	return {
		model: model.id, instructions: getCurrentSystemPrompt(transcript.messages), parallel_tool_calls: true,
		input: convertResponsesMessages(model, transcript, new Set(["openai", "openai-codex", "opencode"]), {
			includeSystemPrompt: false,
			grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(transcript.messages), supportsGrammar),
			supportsAdditionalTools: compat?.supportsAdditionalTools,
			supportsToolSearch: compat?.supportsToolSearch,
			toolOptions,
		}),
		tools: convertResponsesTools(placement.requestTools, toolOptions),
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

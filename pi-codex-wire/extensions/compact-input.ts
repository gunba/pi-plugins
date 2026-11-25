import { clampThinkingLevel, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages, convertResponsesTools, createGrammarToolInputProperties, getDeclaredTools, getInitialSystemMessage,
	getResponsesToolSupport, getSystemMessageText, prepareResponsesPrompt, normalizeContext, resolveTranscript, resolveTranscriptTools } from "./serializer.ts";
import type { JsonObject } from "./diagnostics.ts";

const legacySystemPromptOption = { includeSystemPrompt: false };
let inlineCodexPrompt: boolean | undefined;

function usesInlineCodexPrompt(model: Model<Api>): boolean {
	// Pi 1.6 couples inline Codex prompts with configuration updates. Older converters honor this option;
	// probing it keeps compaction aligned with the native provider without depending on package locations.
	return inlineCodexPrompt ??= convertResponsesMessages(model, normalizeContext({ systemPrompt: "probe", messages: [] }),
		new Set(["openai-codex"]), { ...legacySystemPromptOption, supportsMidConvoSystemMessages: false }).length > 0;
}

/**
 * The request Pi's openai-codex-responses provider builds for this context, before Wire shapes it: the same
 * instructions, tools and input items. A compaction request then continues the conversation's own requests. One
 * that describes the prompt, the tools or an item differently is read as a different conversation: nothing is taken
 * from the prompt cache, and GPT-6.2 models discard the reasoning in it, so the checkpoint is written without it.
 */
export function compactInput(model: Model<Api>, context: Context, thinking: NonNullable<ExtensionContext["thinkingLevel"]>): JsonObject {
	const supportsGrammar = model.compat && "supportsOpenAIGrammarTools" in model.compat
		? model.compat.supportsOpenAIGrammarTools === true : false;
	const compat = model.compat as { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean; supportsMidConvoSystemMessages?: boolean; supportsMidConvoEffort?: boolean; supportsStrictMode?: boolean } | undefined;
	// As Pi's openai-codex-responses provider places tools; Pi before 1.4.0 took a boolean here.
	const support = { supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools: compat?.supportsAdditionalTools ?? false, supportsToolSearch: compat?.supportsToolSearch ?? false };
	const transcript = resolveTranscript(normalizeContext(context), support.supportsMidConvoSystemMessages);
	const placement = resolveTranscriptTools(transcript.messages, getResponsesToolSupport?.(support)
		?? (support.supportsAdditionalTools || support.supportsToolSearch) as unknown as Parameters<typeof resolveTranscriptTools>[1]);
	const toolOptions = { strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true, supportsOpenAIGrammarTools: supportsGrammar };
	const level = clampThinkingLevel(model, thinking);
	const inline = usesInlineCodexPrompt(model);
	const offEffort = inline && model.reasoning ? (model.thinkingLevelMap?.off === undefined ? "none" : model.thinkingLevelMap.off) : undefined;
	const nativeEffort = level === "off" ? offEffort : (model.thinkingLevelMap?.[level] ?? level);
	const configurationUpdateEffort = inline && compat?.supportsMidConvoEffort ? nativeEffort ?? undefined : undefined;
	const providers = new Set(["openai", "openai-codex", "opencode"]);
	const options = {
		...(inline ? {} : legacySystemPromptOption),
		grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(transcript.messages), supportsGrammar),
		...support, toolOptions, configurationUpdateEffort,
	};
	const prepared = prepareResponsesPrompt?.(model, transcript, providers, { ...options, effortBaseline: "initial" });
	const effort = prepared ? prepared.requestEffortBaseline ?? nativeEffort
		: configurationUpdateEffort === undefined ? nativeEffort : "medium";
	const initial = getInitialSystemMessage(transcript.messages);
	return {
		model: model.id, ...(!inline ? { instructions: initial ? getSystemMessageText(initial) : "" } : {}), parallel_tool_calls: true,
		input: prepared?.input ?? convertResponsesMessages(model, transcript, providers, options),
		tools: prepared?.requestTools ?? convertResponsesTools(placement.requestTools, toolOptions),
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

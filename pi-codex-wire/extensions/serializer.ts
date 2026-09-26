import { createRequire } from "node:module";
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";

// Pi reloads this TypeScript module. Keep the cached native helper independent
// of the export list so an upgrade cannot retain the old serializer surface.
const require = createRequire(import.meta.url);
const { loadNative } = require("./native-import.mjs") as {
	loadNative(specifier: string): unknown;
};
export const { convertResponsesMessages, convertResponsesTools } = loadNative(
	"@earendil-works/pi-ai/api/openai-responses-shared",
) as typeof import("@earendil-works/pi-ai/api/openai-responses-shared");
export const { createGrammarToolInputProperties } = loadNative(
	"@earendil-works/pi-ai/api/constrained-sampling",
) as typeof import("@earendil-works/pi-ai/api/constrained-sampling");
export const { normalizeContext, getCurrentSystemPrompt, getDeclaredTools, resolveTranscriptTools } = loadNative(
	"@earendil-works/pi-ai/utils/transcript",
) as typeof import("@earendil-works/pi-ai/utils/transcript");

/** Match the provider's grammar declarations, including tools removed after earlier calls. */
export function responseReplay(model: Model<Api>, context: TranscriptContext, message: AssistantMessage) {
	return convertResponsesMessages(model, normalizeContext({ messages: [message] }),
		new Set(["openai", "openai-codex", "opencode"]), {
			includeSystemPrompt: false,
			grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(context.messages),
				model.compat && "supportsOpenAIGrammarTools" in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false),
		}).filter(item => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
}

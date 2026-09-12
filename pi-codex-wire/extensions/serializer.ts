import { createRequire } from "node:module";

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
export const { splitDeferredTools } = loadNative(
	"@earendil-works/pi-ai/utils/deferred-tools",
) as typeof import("@earendil-works/pi-ai/utils/deferred-tools");

import { createRequire } from "node:module";

// Pi exposes the pi-ai root to extensions, but not its serializer subpaths.
// Resolve our runtime dependency through Node so both bundled Pi and SDK
// loaders use the package exports instead of rewriting a subpath root alias.
const require = createRequire(import.meta.url);
export const { convertResponsesMessages, convertResponsesTools, createGrammarToolInputProperties, splitDeferredTools, isRetryableAssistantError } = require("./serializer.mjs") as
  typeof import("@earendil-works/pi-ai/api/openai-responses-shared") &
  typeof import("@earendil-works/pi-ai/api/constrained-sampling") &
  typeof import("@earendil-works/pi-ai/utils/deferred-tools") &
  typeof import("@earendil-works/pi-ai/utils/retry");

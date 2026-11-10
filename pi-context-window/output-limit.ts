import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelCapacity } from "./config.ts";

// Pi's clampMaxTokensToContext (pi-ai 1.5.1, api/simple-options.js): a margin of 15% of the input, or 4,096 tokens
// when that would leave less than 32,768 for the reply.
const SAFETY_TOKENS = 4096, SAFETY_RATIO = 0.15, MIN_OUTPUT_WITH_RATIO = 32_768;

/** The output Pi allows a request with input tokens in a context window. */
export function outputRoom(window: number, input: number): number {
	let room = window - input - Math.max(SAFETY_TOKENS, Math.ceil(input * SAFETY_RATIO));
	if (room < MIN_OUTPUT_WITH_RATIO) room = Math.min(MIN_OUTPUT_WITH_RATIO, window - input - SAFETY_TOKENS);
	return Math.max(1, room);
}

/**
 * Pi caps a reply at the room the model's context window leaves after the input, and a context budget lowers that
 * window. Near the budget, replies were cut to a few thousand tokens while still thinking: four Claude turns in a row
 * stopped at about 4,880 tokens with 492,000 of a 500,000 budget used. The budget decides when a conversation
 * compacts, not how long a reply may be, so a turn's output cap comes from what the model accepts.
 */
export default function outputLimit(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model, payload = event.payload as { model?: unknown; max_tokens?: unknown } | undefined;
		if (!model || model.api !== "anthropic-messages" || !payload || typeof payload !== "object" || payload.model !== model.id) return;
		const sent = payload.max_tokens;
		// Turn requests ask for the model's limit, so a lower cap is Pi's fit to the window.
		if (typeof sent !== "number" || sent >= model.maxTokens) return;
		const capacity = modelCapacity(model), input = ctx.getContextUsage()?.tokens;
		if (capacity <= model.contextWindow || input == null) return;
		const allowed = Math.min(model.maxTokens, outputRoom(capacity, input));
		if (allowed > sent) return { ...payload, max_tokens: allowed };
	});
}

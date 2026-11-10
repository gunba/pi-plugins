import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelCapacity } from "./config.ts";

// Pi's clampMaxTokensToContext (pi-ai 1.5.1, api/simple-options.js): a margin of 15% of the input, or 4,096 tokens
// when that would leave less than 32,768 for the reply.
const SAFETY_TOKENS = 4096, SAFETY_RATIO = 0.15, MIN_OUTPUT_WITH_RATIO = 32_768;

/** The hidden message that asks a model to carry on after its reply reached the model's output limit. */
export const OUTPUT_LIMIT_MESSAGE = "pi-context-window/output-limit";
/** Replies in a row that are continued after reaching the output limit before the conversation waits for the user. */
export const CONTINUATIONS = 3;

const continuation = (tokens: number) => `Your last reply reached the model's output limit of ${tokens.toLocaleString("en-US")} tokens and was cut off. `
	+ "Carry on from exactly where it stopped, without repeating or summarising what came before. If one step is too large for "
	+ "a single reply, such as a long file, split it into smaller steps.";

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
	continueAfterLimit(pi);
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

type Reply = { role?: string; stopReason?: string; provider?: string; model?: string; usage?: { output?: number } };

/**
 * A reply that reaches the model's output limit ends the turn, and Pi leaves the conversation waiting: an Opus turn
 * thought for 128,000 tokens, its limit, and nothing happened until "Continue" was typed. What it wrote, thinking
 * included, stays in the conversation, so it is asked to carry on, a few times in a row at most. A reply cut short below
 * the limit is cut by the context window instead, which Pi recovers from by compacting and trying again.
 */
function continueAfterLimit(pi: ExtensionAPI): void {
	let cut: number | undefined, continued = 0;
	pi.on("input", () => { continued = 0; });
	pi.on("agent_end", (event, ctx) => {
		const reply = [...event.messages as Reply[]].reverse().find(message => message.role === "assistant"), model = ctx.model;
		const output = reply?.usage?.output ?? 0;
		cut = reply?.stopReason === "length" && model && reply.provider === model.provider && reply.model === model.id
			&& model.maxTokens > 0 && output >= model.maxTokens ? output : undefined;
		if (reply && reply.stopReason !== "length") continued = 0;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const tokens = cut;
		cut = undefined;
		if (tokens === undefined || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (continued >= CONTINUATIONS) {
			ctx.ui.notify(`${CONTINUATIONS + 1} replies in a row reached the model's output limit, so the conversation is waiting for you.`, "warning");
			return;
		}
		continued++;
		pi.sendMessage({ customType: OUTPUT_LIMIT_MESSAGE, content: continuation(tokens), display: false }, { deliverAs: "followUp", triggerTurn: true });
	});
}

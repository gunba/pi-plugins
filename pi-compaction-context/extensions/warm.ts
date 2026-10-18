import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { cacheExpired, promptCacheState } from "../../pi-context-window/prompt-cache.ts";
import { SIDE_REQUEST_HEADER } from "./brief.ts";
import type { SentRequest } from "./in-place.ts";

/**
 * Keeps a conversation's prompt cache from expiring while it waits for a command it left running: that command will
 * wake it when it finishes, and a wake after expiry pays for the whole context again (a one-hour Claude cache write
 * costs nineteen times its read). The conversation's last request is sent again with a one-token answer, which reads
 * the cache and so renews it; nothing enters the conversation. Pi records it as cache_warm usage, as its own warmer does.
 */
export const WARM_EVENT = "pi:warm";
export type WarmProbe = { session: string; result?: Promise<boolean> };

type Writer = { appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown };

export async function warmCache(ctx: ExtensionContext, sent: SentRequest | undefined): Promise<boolean> {
	const model = ctx.model;
	if (!model || !sent || sent.model !== `${model.provider}/${model.id}`) return false;
	// Only Anthropic's lifetimes are known, and only a cache still alive can be renewed.
	if (sent.api !== "anthropic-messages") return false;
	const branch = ctx.sessionManager.getBranch() as never;
	if (!promptCacheState(model, branch) || cacheExpired(model, branch)) return false;
	const payload = JSON.parse(sent.payload) as Record<string, unknown>;
	// Budget thinking derives its budget from max_tokens, and Anthropic keys the cache on it (Pi's isReplayable).
	if ((payload.thinking as { type?: string } | undefined)?.type === "enabled") return false;
	payload.max_tokens = 1;
	const result = await ctx.modelRegistry.complete(model, { systemPrompt: "", messages: [{ role: "user", content: "Warm.", timestamp: Date.now() }] },
		{ sessionId: ctx.sessionManager.getSessionId(), headers: { [SIDE_REQUEST_HEADER]: "1" }, onPayload: () => payload });
	if (result.stopReason === "error" || result.stopReason === "aborted") return false;
	(ctx.sessionManager as unknown as Writer).appendUsage?.call(ctx.sessionManager, "cache_warm", model.provider, model.id, result.usage, "a command it left running is still going");
	return result.usage.cacheRead > 0;
}

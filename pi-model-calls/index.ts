import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { recordServiceUsage } from "../pi-service-usage/index.ts";
import { modelCalls, OPERATION, spentToday } from "./settings.ts";

/**
 * ask_model: free-text model calls for programs, with the model, effort and API key chosen in Desk's Settings. The key
 * is passed with each request, so the call is billed to it even when the provider also has a subscription sign-in.
 */
const PARAMETERS = Type.Object({
	prompt: Type.String({ description: "The request, with the text it needs." }),
	system: Type.Optional(Type.String({ description: "Instructions that frame the answer." })),
	max_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Output token limit, including reasoning. Default 16000." })),
});
const OUTPUT = Type.Object({ text: Type.String(), cost: Type.Number(), truncated: Type.Optional(Type.Boolean()) });
const DEFAULT_TOKENS = 16_000;
/** Calls one process may have in flight; Promise.all over many items queues the rest instead of tripping rate limits. */
const PARALLEL = 8;

let running = 0;
const waiting: (() => void)[] = [];
async function turn<T>(work: () => Promise<T>): Promise<T> {
	if (running < PARALLEL) running++;
	else await new Promise<void>(resolve => waiting.push(resolve));
	try { return await work(); }
	finally { const next = waiting.shift(); if (next) next(); else running--; }
}

async function ask(params: Static<typeof PARAMETERS>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	const agentDir = getAgentDir(), settings = modelCalls(agentDir);
	if (!settings.provider || !settings.model || !settings.effort || !settings.apiKey)
		throw new Error("No model is set up for ask_model on this computer. The user can choose one, with an API key, in Desk: Settings → Accounts & connections → Model calls.");
	const model = ctx.modelRegistry.find(settings.provider, settings.model);
	if (!model) throw new Error("ask_model's model, " + settings.provider + "/" + settings.model + ", is not in Pi's catalog. The user can choose another in Settings.");
	const limit = settings.dailyLimit!, spent = spentToday(agentDir);
	if (spent >= limit) throw new Error("ask_model has spent $" + spent.toFixed(2) + " of its $" + limit + " daily limit, which resets at 00:00 UTC. The user can raise it in Settings.");
	const maxTokens = Math.min(params.max_tokens ?? DEFAULT_TOKENS, model.maxTokens || Infinity);
	const reasoning = settings.effort === "off" ? undefined : settings.effort as never;
	const message: AssistantMessage = await turn(() => ctx.modelRegistry.streamSimple(model, {
		...(params.system ? { systemPrompt: params.system } : {}),
		messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
	}, { apiKey: settings.apiKey, reasoning, maxTokens, signal }).result());
	const reported = message.usage?.cost.total, failed = message.stopReason === "error" || message.stopReason === "aborted";
	// A failed request's zero usage may be a placeholder rather than proof that nothing was billed.
	const cost = failed && !reported ? undefined : reported;
	const warning = recordServiceUsage(agentDir, { service: model.provider, operation: OPERATION, cost, estimated: true });
	if (message.stopReason === "aborted") throw new Error("Stopped.");
	if (message.stopReason === "error") throw new Error(message.errorMessage || "The model request failed.");
	const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
	const truncated = message.stopReason === "length";
	return {
		content: [{ type: "text", text }, ...truncated ? [{ type: "text" as const, text: "(Stopped at max_tokens.)" }] : [],
			...warning ? [{ type: "text" as const, text: warning }] : []],
		details: { model: model.provider + "/" + model.id, effort: settings.effort, cost: cost ?? 0 },
		structuredContent: { text, cost: cost ?? 0, ...truncated ? { truncated } : {} },
		usage: message.usage,
	};
}

export default function modelCallsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_model",
		label: "Ask model",
		description: "Ask the model set in Settings for free text, billed to its API key; returns {text,cost}. "
			+ "For summarising, drafting, extracting or judging text inside programs; typed answers over many items are cheaper with "
			+ "models.classify. The model and its effort are fixed in Desk's Settings, which also sets a daily spending limit. "
			+ "Up to 8 calls run at once; more wait their turn. truncated: the answer reached max_tokens.",
		promptSnippet: "Ask the Settings model for free text",
		parameters: PARAMETERS,
		outputSchema: OUTPUT,
		execute: (_id, params, signal, _update, ctx) => ask(params as Static<typeof PARAMETERS>, signal, ctx),
	});
}

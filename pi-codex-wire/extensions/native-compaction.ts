import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRetryableAssistantError, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { SettingsManager, convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, CHECKPOINT_CAPTION, assertCheckpointContext, checkpointMessages, checkpointUsage, compactionPrefix, entryCheckpoint, projectCheckpoints, type Checkpoint } from "./checkpoint.ts";
import { restorePrunedSession } from "../../pi-session-memory/extensions/session-memory.ts";

type Settings = Pick<SettingsManager, "getRetrySettings" | "getProviderRetrySettings" | "getHttpIdleTimeoutMs">;
export interface CompactOperation {
	ctx: ExtensionContext;
	context: Context;
	signal: AbortSignal;
	reason: "manual" | "threshold" | "overflow";
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	timeoutMs: number;
}
type Compactor = (operation: CompactOperation) => Promise<Checkpoint>;
const stateKey = Symbol.for("pi.codex-wire.checkpoints.v1");
type State = { compactors: WeakMap<object, Compactor>; sources: Map<string, () => SessionEntry[]> };
const shared = globalThis as typeof globalThis & { [stateKey]?: State };
// Pi loads extension entrypoints independently. Child and parent loaders must share ownership.
const { compactors, sources } = shared[stateKey] ??= { compactors: new WeakMap(), sources: new Map() };

export function registerCompactor(provider: object, compactor: Compactor): void { compactors.set(provider, compactor); }
export function inheritCompactor(source: object, target: object): void {
	const compactor = compactors.get(source);
	if (compactor) compactors.set(target, compactor);
}
export function guardCheckpointContext(context: Context, provider: string, sessionId: string): void {
	assertCheckpointContext(context, provider, sources.get(sessionId)?.());
}

export async function retryCompaction<T>(produce: () => Promise<T>, settings: ReturnType<Settings["getRetrySettings"]>, signal: AbortSignal,
	notify: (attempt: number, maximum: number, delayMs: number) => void): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try { return await produce(); }
		catch (error) {
			signal.throwIfAborted();
			const errorMessage = error instanceof Error ? error.message : "Codex compaction failed";
			if (!settings.enabled || attempt >= settings.maxRetries
				|| !isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage)) throw error;
			const ms = settings.baseDelayMs * 2 ** attempt;
			notify(attempt + 1, settings.maxRetries, ms);
			await delay(ms, undefined, { signal });
		}
	}
}

/** Shared by the top-level extension and SDK children; it never edits the Pi runtime. */
export default function nativeCompaction(pi: ExtensionAPI, suppliedSettings?: Settings): void {
	const guards = new Map<string, { original: Provider; installed: Provider }>();
	let registeredSession: string | undefined;
	const guardSelected = (ctx: ExtensionContext) => {
		if (!ctx.model || ctx.model.provider === "openai-codex" || guards.has(ctx.model.provider)) return;
		if (!ctx.sessionManager.buildContextEntries().some(entry => entryCheckpoint(entry) !== undefined)) return;
		const original = ctx.modelRegistry.getProvider(ctx.model.provider);
		if (!original) return;
		const installed: Provider = { ...original,
			stream: (model, context, options) => {
				guardCheckpointContext(context, model.provider, options?.sessionId ?? ctx.sessionManager.getSessionId());
				return original.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				guardCheckpointContext(context, model.provider, options?.sessionId ?? ctx.sessionManager.getSessionId());
				return original.streamSimple(model, context, options);
			},
		};
		pi.registerProvider(installed);
		guards.set(original.id, { original, installed });
	};
	pi.on("session_start", (_event, ctx) => {
		registeredSession = ctx.sessionManager.getSessionId();
		sources.set(registeredSession, () => ctx.sessionManager.buildContextEntries());
		guardSelected(ctx);
	});
	pi.on("model_select", (_event, ctx) => { guardSelected(ctx); });
	pi.on("context", (event, ctx) => ({ messages: projectCheckpoints(event.messages, ctx.sessionManager.getBranch()) }));
	pi.on("session_shutdown", (_event, ctx) => {
		if (registeredSession) sources.delete(registeredSession);
		for (const { original, installed } of guards.values()) {
			if (ctx.modelRegistry.getProvider(original.id) === installed) pi.registerProvider(original);
		}
		guards.clear();
	});
	const settingsFor = (ctx: ExtensionContext): Settings => {
		if (suppliedSettings) return suppliedSettings;
		const settings = SettingsManager.create(ctx.cwd,
			process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), { projectTrusted: ctx.isProjectTrusted() });
		if (settings.drainErrors().length) throw new Error("Cannot read the configured compaction retry and timeout settings.");
		return settings;
	};
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const model = ctx.model;
			const endpoint = model?.provider === "openai-codex" ? new URL(model.baseUrl) : undefined;
			if (!model || model.provider !== "openai-codex" || endpoint?.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") {
				if (ctx.sessionManager.buildContextEntries().some(entry => entryCheckpoint(entry) !== undefined)) {
					ctx.ui.notify("This checkpoint requires a Codex model for compaction.", "error");
					return { cancel: true };
				}
				return;
			}
			const provider = ctx.modelRegistry.getProvider(model.provider);
			const compact = provider && compactors.get(provider);
			if (!compact) throw new Error("Native Codex compaction is unavailable in this session.");
			const settings = settingsFor(ctx);
			const entries = compactionPrefix(event.branchEntries, event.preparation.firstKeptEntryId);
			const active = new Set(pi.getActiveTools());
			const context: Context = {
				systemPrompt: ctx.getSystemPrompt() + (event.customInstructions ? `\n\nCompaction instructions:\n${event.customInstructions}` : ""),
				messages: convertToLlm(checkpointMessages(entries)),
				tools: pi.getAllTools().filter(tool => active.has(tool.name)),
			};
			const timeout = settings.getProviderRetrySettings().timeoutMs ?? settings.getHttpIdleTimeoutMs();
			const checkpoint = await retryCompaction(() => compact({ ctx, context, signal: event.signal, reason: event.reason,
				thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), timeoutMs: timeout === 0 ? 2_147_483_647 : timeout }),
				settings.getRetrySettings(), event.signal,
				(attempt, maximum, ms) => ctx.ui.notify(`Retrying Codex compaction ${attempt}/${maximum} in ${ms}ms.`, "warning"));
			event.signal.throwIfAborted();
			return { compaction: { summary: `${CHECKPOINT_CAPTION}\nCheckpoint: ${randomUUID()}`, details: { [CHECKPOINT]: checkpoint }, usage: checkpointUsage(checkpoint, model),
				firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		} catch (error) {
			if (!event.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : "Codex compaction failed.", "error");
			// Pi catches hook errors. Explicit cancellation prevents an unintended prose fallback.
			return { cancel: true };
		}
	});
	pi.on("session_before_tree", async (event, ctx) => {
		if (!event.preparation.userWantsSummary) return;
		try {
			restorePrunedSession(ctx.sessionManager);
			if (!event.preparation.entriesToSummarize.some(entry => entryCheckpoint(entry) !== undefined)) return;
			if (ctx.model?.provider !== "openai-codex") throw new Error("Select a Codex model to summarize a branch containing a Codex checkpoint.");
			const settings = settingsFor(ctx);
			const providerSettings = settings.getProviderRetrySettings();
			const timeout = providerSettings.timeoutMs ?? settings.getHttpIdleTimeoutMs();
			const instruction = event.preparation.replaceInstructions && event.preparation.customInstructions
				? event.preparation.customInstructions
				: "Summarize the conversation branch being left for a return to another branch. Preserve the user's objective, constraints, completed work, open questions and concrete next steps."
					+ (event.preparation.customInstructions ? `\n\nAdditional focus:\n${event.preparation.customInstructions}` : "");
			const context: Context = { systemPrompt: ctx.getSystemPrompt(),
				messages: [...convertToLlm(checkpointMessages(ctx.sessionManager.buildContextEntries())),
					{ role: "user", content: instruction, timestamp: Date.now() }] };
			const sessionId = randomUUID();
			const level = ctx.thinkingLevel ?? pi.getThinkingLevel();
			const response = await retryCompaction(async () => {
				const result = await ctx.modelRegistry.complete(ctx.model!, context, {
					signal: event.signal, sessionId, cacheRetention: "none",
					timeoutMs: timeout === 0 ? 2_147_483_647 : timeout, ...providerSettings,
					...(level !== "off" ? { reasoningEffort: level } : {}),
				});
				event.signal.throwIfAborted();
				if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? "Branch summary did not complete.");
				return result;
			}, settings.getRetrySettings(), event.signal,
				(attempt, maximum, ms) => ctx.ui.notify(`Retrying branch summary ${attempt}/${maximum} in ${ms}ms.`, "warning"));
			const summary = response.content.filter(part => part.type === "text").map(part => part.text).join("");
			if (!summary.trim()) throw new Error("Codex returned an empty branch summary.");
			event.signal.throwIfAborted();
			return { summary: { summary, usage: response.usage } };
		} catch (error) {
			if (!event.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : "Branch summary failed.", "error");
			return { cancel: true };
		}
	});
}

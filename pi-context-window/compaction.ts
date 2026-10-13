import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { COMPACTION_FAILURE_ENTRY, RETRY_AFTER_MINUTES, compactionHeld, compactionKey, failures, type Failure } from "./compaction-state.ts";

export { compactionHeld, compactionKey } from "./compaction-state.ts";
type Budget = { reserveTokens: number; keepRecentTokens: number };

/**
 * A failed compaction holds automatic compaction back. Pi otherwise retries before every turn, resending the
 * whole conversation (about 800,000 tokens, two minutes) to fail the same way. A transient failure, such as a
 * network or server error, is retried after a pause; any other waits until something it depends on changes.
 */
export function recordCompactionFailure(sessionId: string, key: string, message: string, now = Date.now()): Failure {
	const error = { stopReason: "error", errorMessage: message } as AssistantMessage;
	const transient = !isContextOverflow(error) && isRetryableAssistantError(error);
	const failure = { message, key, at: now, until: transient ? now + RETRY_AFTER_MINUTES * 60_000 : undefined, reported: false };
	failures.set(sessionId, failure);
	return failure;
}

/**
 * Pi gives a prose summary 80% of the compaction reserve, thinking included: 13,107 tokens by default. A
 * 1M-token conversation's summaries took 13,265 and then 20,880, so every attempt hit the cap. Allow a sixteenth
 * of the window instead, within the model's output limit and the room the reserve and kept messages leave at the
 * checkpoint. Returns the reserve that gives Pi that budget.
 */
export function summaryReserve(model: { contextWindow: number; maxTokens: number }, settings: Budget): number {
	const room = settings.reserveTokens + settings.keepRecentTokens;
	const budget = Math.min(model.maxTokens > 0 ? model.maxTokens : Infinity,
		Math.max(Math.floor(0.8 * settings.reserveTokens), Math.min(Math.floor(model.contextWindow / 16), room)));
	return Math.max(settings.reserveTokens, Math.ceil(budget / 0.8));
}

function failureText(failure: Pick<Failure, "message"> & Partial<Failure>): string {
	const message = failure.message.trim().replace(/([^.!?])$/, "$1.");
	if (failure.key === undefined) return message;
	return `${message} ${failure.until !== undefined ? `Pi will try again in ${RETRY_AFTER_MINUTES} minutes.`
		: "Automatic compaction is paused until the model, its context budget or its compaction settings change. Compact manually to try again now."}`;
}

export default function compactionPolicy(pi: ExtensionAPI): void {
	let attempt: string | undefined;
	pi.on("session_before_compact", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId(), { settings } = event.preparation;
		const key = compactionKey(ctx.model, settings, ctx.thinkingLevel ?? pi.getThinkingLevel());
		// Codex Wire runs first and applies the same hold to Codex models.
		if (event.reason !== "manual" && compactionHeld(sessionId, key)) return { cancel: true };
		attempt = key;
		// Pi's prose summary reads its budget from the preparation it passes on to compact().
		if (ctx.model && ctx.model.provider !== "openai-codex") {
			const reserveTokens = summaryReserve(ctx.model, settings);
			if (reserveTokens > settings.reserveTokens) event.preparation.settings = { ...settings, reserveTokens };
		}
	});
	pi.on("session_compact", (_event, ctx) => {
		attempt = undefined;
		failures.delete(ctx.sessionManager.getSessionId());
	});
	// Failures stay in the conversation; a notification alone is gone before anyone reads it.
	pi.on("session_compact_failed", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId(), key = attempt;
		attempt = undefined;
		const recorded = failures.get(sessionId);
		// A manual compaction that never started ("Nothing to compact") reports to whoever asked for it.
		const failure = recorded && !recorded.reported ? recorded
			: event.aborted || !event.errorMessage || key === undefined && event.reason === "manual" ? undefined
			: key !== undefined ? recordCompactionFailure(sessionId, key, event.errorMessage)
			: { message: event.errorMessage };
		if (!failure) return;
		if ("reported" in failure) failure.reported = true;
		pi.appendEntry(COMPACTION_FAILURE_ENTRY, { text: failureText(failure) });
	});
}

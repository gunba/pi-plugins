import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { COMPACTION_FAILURE_ENTRY, RETRY_AFTER_MINUTES, compactionHeld, compactionKey, failures, type Failure } from "./compaction-state.ts";
import { effortSetting } from "../pi-effort/src/shared.ts";

export { compactionHeld, compactionKey } from "./compaction-state.ts";

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
 * Runs a compaction request again after a transient failure, such as a dropped stream or a server error, with
 * Pi's retry settings: up to maxRetries more attempts, waiting baseDelayMs and then twice as long each time.
 */
export async function retryCompaction<T>(produce: () => Promise<T>, settings: { enabled: boolean; maxRetries: number; baseDelayMs: number },
	signal: AbortSignal, notify: (attempt: number, maximum: number, delayMs: number) => void): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try { return await produce(); }
		catch (error) {
			signal.throwIfAborted();
			const errorMessage = error instanceof Error ? error.message : "Compaction failed";
			if (!settings.enabled || attempt >= settings.maxRetries
				|| !isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage)) throw error;
			const ms = settings.baseDelayMs * 2 ** attempt;
			notify(attempt + 1, settings.maxRetries, ms);
			await delay(ms, undefined, { signal });
		}
	}
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
		const sessionId = ctx.sessionManager.getSessionId();
		// Automatic effort moves the level between runs; only the user's own choice is a reason to try again.
		const key = compactionKey(ctx.model, event.preparation.settings, effortSetting(sessionId, ctx.thinkingLevel ?? pi.getThinkingLevel()));
		// Codex Wire runs first and applies the same hold to Codex models; pi-compaction-context records its
		// failures under this same key.
		if (event.reason !== "manual" && compactionHeld(sessionId, key)) return { cancel: true };
		attempt = key;
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

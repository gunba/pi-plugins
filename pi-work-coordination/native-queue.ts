import type { AgentSession } from "@earendil-works/pi-coding-agent";

// Desk's bundle and Pi's extension loader can instantiate this module separately.
const ADMISSION_GUARDS = Symbol.for("pi-work-coordination/native-admission-guards");
const shared = globalThis as typeof globalThis & { [ADMISSION_GUARDS]?: WeakMap<object, { readonly admittingPrompt: boolean }> };
const admissionGuards = shared[ADMISSION_GUARDS] ??= new WeakMap<object, { readonly admittingPrompt: boolean }>();

/** Native input preparation can be asynchronous while isIdle() is still true. */
export const nativePromptPreparing = (sessionManager: object): boolean => admissionGuards.get(sessionManager)?.admittingPrompt ?? false;

/** Observe public admission; do not inspect, export or rewrite native queues. */
export class NativeQueueGuard {
	private nextTurn = 0;
	private preparing = 0;
	get pending(): boolean { return this.nextTurn > 0 || this.preparing > 0; }
	get admittingPrompt(): boolean { return this.preparing > 0; }

	constructor(session: AgentSession, suspended: () => boolean) {
		admissionGuards.set(session.sessionManager, this);
		const prompt = session.prompt.bind(session), custom = session.sendCustomMessage.bind(session);
		session.prompt = async (text, options) => {
			if (suspended()) throw new Error("This conversation is held for an update.");
			this.preparing++;
			let acknowledged = false;
			const acknowledge = () => { if (!acknowledged) { acknowledged = true; this.preparing--; } };
			try {
				return await prompt(text, { ...options, preflightResult: result => {
					// Native 'started' means deferred next-turn context has been injected.
					// Commands handled without a model turn and queued steering do not consume it.
					if (result === "started") this.nextTurn = 0;
					acknowledge(); options?.preflightResult?.(result);
				} });
			} finally { acknowledge(); }
		};
		session.sendCustomMessage = async (message, options) => {
			if (options?.deliverAs !== "nextTurn") return custom(message, options);
			this.nextTurn++;
			try { await custom(message, options); }
			catch (error) { this.nextTurn = Math.max(0, this.nextTurn - 1); throw error; }
		};
	}
}

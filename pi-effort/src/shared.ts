// Kept free of Pi imports so Desk and other plugins can read it.

/** A conversation's automatic effort, as other plugins and Desk see it. */
export interface EffortView {
	/** Whether automatic effort is on and the conversation's model supports it. */
	auto: boolean;
	/** Whether the conversation's model supports it at all. */
	usable: boolean;
	/** The level the user chose. The level in use can sit below it while a stretch runs. */
	setting: string;
}

const key = Symbol.for("pi.effort.v1");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, EffortView> };
// The extension and its readers load this module separately; they share one record per session.
export const views = shared[key] ??= new Map<string, EffortView>();

/**
 * The level the user chose for a conversation. Use it in place of the current level wherever the choice matters
 * and the level of the moment does not: a helper's inherited level, or what a retried compaction depends on.
 */
export function effortSetting(sessionId: string, current: string | undefined): string | undefined {
	const view = views.get(sessionId);
	return view?.auto ? view.setting : current;
}

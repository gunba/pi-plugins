/** Effort levels in rising order. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** How many levels below the user's setting a stretch of work may run. */
export const DEPTH = 2;

/** Automatic effort never goes below this level, and leaves a setting at or below it alone. */
const FLOOR = "medium";

/** The level `down` steps below `setting`, counting only the levels the model offers. */
export function levelBelow(setting: string, down: number, offered: readonly string[]): string {
	const ladder = LEVELS.filter(level => offered.includes(level) && LEVELS.indexOf(level) >= LEVELS.indexOf(FLOOR)) as string[];
	const at = ladder.indexOf(setting);
	return at < 0 ? setting : ladder[Math.max(0, at - down)]!;
}

/**
 * What the classifier made of a message. `demand` runs from 0 (a quick answer or one simple step) through 1
 * (contained work) to 2 (as much as the most demanding work in the conversation, or unclear). `short` is the
 * probability that the message says work already done fell short.
 */
export interface Rating { demand: number; short: number }

/**
 * How far below the setting a stretch may start, from what the user wrote. Without a rating (the classifier
 * failed, or there were no words to rate) it starts at the setting, as does a conversation's first message:
 * the setting is the user's own judgement of the conversation, and nothing yet says this part is lighter.
 */
export function startDown(rating: Rating | undefined, first: boolean): number {
	if (first || !rating || rating.short >= 0.5 || rating.demand >= 1.4) return 0;
	return rating.demand < 0.8 ? 2 : 1;
}

/** What a run has done so far. */
export interface Work { steps: number; edits: number; planned: boolean }

/**
 * How far below the setting a run may still be once it has done this much. A lower start is a bet that the work
 * is light; a run that takes many steps, edits several times or makes a plan has shown it is not.
 */
export function downAfter(work: Work): number {
	if (work.steps >= 25 || work.edits >= 4) return 0;
	return work.steps >= 8 || work.edits >= 2 || work.planned ? 1 : 2;
}

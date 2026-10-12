/** Jordan's quest log: things to do, kept on each computer and shared by Desk, Pi agents and his Dot. No runtime imports. */

export type QuestKind = "main" | "side" | "daily";
export type QuestState = "open" | "done" | "abandoned";
/** Who added or changed a quest. Agents are identified by their conversation's agent id. */
export interface QuestActor { kind: "you" | "dot" | "agent"; id?: string; label?: string }
export interface QuestStep { title: string; done: boolean }
export interface Quest {
	id: string;
	title: string;
	notes?: string;
	kind: QuestKind;
	state: QuestState;
	/** YYYY-MM-DD in the log's time zone. */
	due?: string;
	steps?: QuestStep[];
	source: QuestActor;
	/** Message the agent that added it when it is done or abandoned. */
	notify?: boolean;
	created: number;
	updated: number;
	completed?: number;
}
export interface QuestEvent { seq: number; at: number; by: QuestActor; action: "added" | "updated" | "completed" | "reopened" | "abandoned" | "moved"; quest: string; title: string }
/** When scheduled reviews may change the list. Direct requests are always allowed. */
export interface QuestHours { days: number[]; start: number; end: number; timeZone: string }
export interface QuestView {
	/** Open quests in order, then those completed today. */
	quests: Quest[];
	hours: QuestHours;
	today: string;
	onDuty: boolean;
	/** Local dates with at least one completed quest, newest first. */
	completedDays: string[];
	revision: number;
}
export type QuestCommand =
	| { action: "add"; title: string; kind?: QuestKind; notes?: string; due?: string; steps?: string[] }
	| { action: "update"; id: string; title?: string; kind?: QuestKind; notes?: string; due?: string | null; steps?: QuestStep[] }
	| { action: "complete" | "reopen" | "abandon"; id: string }
	| { action: "move"; id: string; before?: string }
	| { action: "hours"; hours: Partial<Omit<QuestHours, "timeZone">> };

export const QUEST_KINDS: QuestKind[] = ["daily", "main", "side"];
export const QUEST_KIND_NAMES: Record<QuestKind, string> = { daily: "Daily", main: "Main", side: "Side" };
export const defaultHours = (timeZone: string): QuestHours => ({ days: [1, 2, 3, 4, 5], start: 9, end: 17, timeZone });

/** The local date (YYYY-MM-DD), weekday (0 = Sunday) and hour in a time zone. */
export function localTime(at: number, timeZone: string): { date: string; weekday: number; hour: number } {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
		.formatToParts(at).map(part => [part.type, part.value]));
	return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!), hour: Number(parts.hour) % 24 };
}
export function isOnDuty(hours: QuestHours, at = Date.now()): boolean {
	const now = localTime(at, hours.timeZone);
	return hours.days.includes(now.weekday) && now.hour >= hours.start && now.hour < hours.end;
}
/** Whether a quest belongs under Today: a daily, or due today or earlier. */
export function isToday(quest: Quest, today: string): boolean { return quest.kind === "daily" || !!quest.due && quest.due <= today; }

/** Consecutive working days ending today (or yesterday, if nothing is done yet today) with a completion. */
export function questStreak(completedDays: Iterable<string>, hours: QuestHours, at = Date.now()): number {
	const done = new Set(completedDays);
	let streak = 0, day = new Date(`${localTime(at, hours.timeZone).date}T12:00:00Z`), first = true;
	for (let guard = 0; guard < 400; guard++, day = new Date(day.getTime() - 86_400_000)) {
		const date = day.toISOString().slice(0, 10), working = hours.days.includes(day.getUTCDay());
		if (done.has(date)) streak++;
		else if (working && !first) break;
		first = false;
	}
	return streak;
}

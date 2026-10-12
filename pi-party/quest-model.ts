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
	/** Weekdays (0 = Sunday) a recurring daily applies; it reopens by itself on each of them. */
	repeat?: number[];
	/** When the quest giver (Jordan or his Dot) took the finished quest; until then it waits with a "?". */
	turnedIn?: number;
	source: QuestActor;
	/** Message the agent that added it when it is done or abandoned. */
	notify?: boolean;
	created: number;
	updated: number;
	completed?: number;
}
export interface QuestEvent { seq: number; at: number; by: QuestActor; action: "added" | "updated" | "completed" | "reopened" | "abandoned" | "moved" | "turned_in"; quest: string; title: string }
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
	| { action: "add"; title: string; kind?: QuestKind; notes?: string; due?: string; steps?: string[]; repeat?: number[] }
	| { action: "update"; id: string; title?: string; kind?: QuestKind; notes?: string; due?: string | null; steps?: QuestStep[]; repeat?: number[] | null }
	| { action: "complete" | "reopen" | "abandon"; id: string }
	/** Turn in one finished quest, or every finished quest the actor may change. */
	| { action: "turnin"; id?: string }
	| { action: "move"; id: string; before?: string }
	| { action: "hours"; hours: Partial<Omit<QuestHours, "timeZone">> };

export const QUEST_KINDS: QuestKind[] = ["daily", "main", "side"];
export const QUEST_KIND_NAMES: Record<QuestKind, string> = { daily: "Daily", main: "Important", side: "Minor" };
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
/** Finished but not yet turned in. */
export function isReady(quest: Quest): boolean { return quest.state === "done" && !(quest.turnedIn && quest.completed && quest.turnedIn >= quest.completed); }

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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Every day", "Weekdays", or the day names. */
export function repeatLabel(days: number[]): string {
	const set = [...new Set(days)].sort();
	if (set.length === 7) return "Every day";
	if (set.join() === "1,2,3,4,5") return "Weekdays";
	if (set.join() === "0,6") return "Weekends";
	return set.map(day => DAY_NAMES[day]).join(" ");
}

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
	/** A deadline, YYYY-MM-DD in the log's time zone: it can be done any time before. */
	due?: string;
	/** The day it happens, like an appointment: it waits under Upcoming and joins Daily on that day. */
	scheduled?: string;
	steps?: QuestStep[];
	/** A repeating daily's schedule; it reopens by itself on each due date. */
	repeat?: QuestRepeat;
	/** For a repeating or scheduled quest that is not due yet, the date it next joins Daily (computed). */
	next?: string;
	/** When the quest giver (Jordan or his Dot) took the finished quest; until then it waits with a "?". */
	turnedIn?: number;
	source: QuestActor;
	/** Message the agent that added it when it is done or abandoned. */
	notify?: boolean;
	created: number;
	updated: number;
	completed?: number;
}
/**
 * When a repeating quest is due, in the log's time zone. The cadence counts from the start date, never from when it was
 * last done, so doing it late neither shifts the schedule nor adds a second copy.
 */
export interface QuestRepeat {
	/** Every this many units: 1 is every day, week or month. */
	every: number;
	unit: "day" | "week" | "month";
	/** YYYY-MM-DD the cadence counts from, and the first due date. */
	from: string;
	/** Weekly only: the weekdays it is due (0 = Sunday); defaults to the start date's weekday. */
	weekdays?: number[];
}
export interface QuestEvent { seq: number; at: number; by: QuestActor; action: "added" | "updated" | "completed" | "reopened" | "abandoned" | "moved" | "turned_in"; quest: string; title: string }
/** When scheduled reviews may change the list. Direct requests are always allowed. */
export interface QuestHours { days: number[]; start: number; end: number; timeZone: string }
export interface QuestView {
	/** Open quests and finished ones waiting to be turned in, in order. Repeating quests appear on and after their due dates until done. */
	quests: Quest[];
	/** Scheduled quests before their day and repeating quests not due again yet, soonest first, with the date in next. */
	upcoming?: Quest[];
	hours: QuestHours;
	today: string;
	onDuty: boolean;
	/** Local dates with at least one completed quest, newest first. */
	completedDays: string[];
	revision: number;
}
export type QuestCommand =
	| { action: "add"; title: string; kind?: QuestKind; notes?: string; due?: string; scheduled?: string; steps?: string[]; repeat?: Partial<QuestRepeat> }
	| { action: "update"; id: string; title?: string; kind?: QuestKind; notes?: string; due?: string | null; scheduled?: string | null; steps?: QuestStep[]; repeat?: Partial<QuestRepeat> | null }
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

export function isToday(quest: Quest, today: string): boolean { return quest.kind === "daily" || !!quest.due && quest.due <= today || !!quest.scheduled && quest.scheduled <= today; }

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

// Schedules work on whole calendar dates (days since 1970-01-01, a Thursday), so time zones and daylight saving cannot skew them.
const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
const dateOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (day: number) => (day + 4) % 7;
const mondayOf = (day: number) => day - (day + 3) % 7;
/** Whether a repeating quest is due on a date. */
export function isDueOn(repeat: QuestRepeat, date: string): boolean {
	const day = dayNumber(date), start = dayNumber(repeat.from);
	if (day < start) return false;
	if (repeat.unit === "day") return (day - start) % repeat.every === 0;
	if (repeat.unit === "week") return (repeat.weekdays ?? [weekdayOf(start)]).includes(weekdayOf(day)) && (mondayOf(day) - mondayOf(start)) / 7 % repeat.every === 0;
	const months = (Number(date.slice(0, 4)) - Number(repeat.from.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(repeat.from.slice(5, 7));
	const monthLength = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
	return months % repeat.every === 0 && Number(date.slice(8, 10)) === Math.min(Number(repeat.from.slice(8, 10)), monthLength);
}
const period = (repeat: QuestRepeat) => repeat.every * (repeat.unit === "day" ? 1 : repeat.unit === "week" ? 7 : 31) + 7;
/** The latest due date on or before a date, if it has started. */
export function lastDue(repeat: QuestRepeat, date: string): string | undefined {
	const start = dayNumber(repeat.from);
	for (let day = dayNumber(date), end = day - period(repeat); day >= start && day > end; day--) if (isDueOn(repeat, dateOf(day))) return dateOf(day);
	return undefined;
}
/** The first due date after a date. */
export function nextDue(repeat: QuestRepeat, after: string): string {
	for (let day = Math.max(dayNumber(after) + 1, dayNumber(repeat.from)), end = day + period(repeat); day <= end; day++) if (isDueOn(repeat, dateOf(day))) return dateOf(day);
	return repeat.from;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
/** "Every day", "Every 2 days", "Tue Fri", "Every 2 weeks on Mon", "Monthly on the 15th". */
export function repeatLabel(repeat: QuestRepeat): string {
	const n = repeat.every;
	if (repeat.unit === "day") return n === 1 ? "Every day" : `Every ${n} days`;
	if (repeat.unit === "month") return `${n === 1 ? "Monthly" : `Every ${n} months`} on the ${ordinal(Number(repeat.from.slice(8, 10)))}`;
	const days = [...new Set(repeat.weekdays ?? [weekdayOf(dayNumber(repeat.from))])].sort();
	const names = days.length === 7 ? "every day" : days.join() === "1,2,3,4,5" ? "weekdays" : days.join() === "0,6" ? "weekends" : days.map(day => DAY_NAMES[day]).join(" ");
	return n === 1 ? names[0]!.toUpperCase() + names.slice(1) : `Every ${n} weeks on ${names}`;
}

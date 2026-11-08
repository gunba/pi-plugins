import { HOUR_MINUTE, localDate, localDateTime, localTime } from "./local-format.ts";
import type { SessionView } from "../shared/protocol.ts";
import { asksInBackground, openQuestions } from "../shared/attention.ts";
import { agentInventory } from "./agent-inventory.ts";

export function sessionActivity(session: Pick<SessionView, "state" | "snapshot" | "ui" | "interrupted" | "reconnecting" | "updating" | "kept" | "controls">): string {
	if (session.updating) return "updating";
	if (session.state !== "closed" && session.controls?.some(control => control.kind === "close" && control.state === "running")) return "closing";
	if (session.state === "closed" && session.kept) return "sleeping";
	if (session.state === "closed" || session.state === "failed") return session.state;
	if (session.reconnecting) return "connecting";
	if (session.ui?.interactions.some(item => !item.settings && !asksInBackground(item.form))) return "waiting";
	return session.interrupted ? "interrupted" : session.snapshot?.activity ?? session.state;
}
export function activityLabel(state: string): string {
	switch (state) {
		case "running": case "working": return "Working";
		case "waiting": case "attention": return "Needs input";
		case "idle": case "ready": return "Idle";
		case "error": return "Needs attention";
		case "failed": return "Unavailable";
		case "interrupted": return "Stopped";
		case "starting": return "Starting";
		case "updating": return "Updating";
		case "closing": return "Closing";
		case "sleeping": return "Closed";
		case "connecting": return "Connecting";
		case "online": return "Online";
		case "offline": return "Offline";
		case "closed": return "Closed";
		default: return state;
	}
}

/** When a conversation's watch wakes it: the time today, the weekday and time within a week, otherwise the date and time. */
export function wakeLabel(at: number, now = Date.now()): string {
	const time = localTime(at, HOUR_MINUTE);
	if (new Date(at).toDateString() === new Date(now).toDateString()) return `Wakes ${time}`;
	return `Wakes ${localDate(at, at - now < 6 * 86_400_000 ? { weekday: "short" } : { day: "numeric", month: "short" })} ${time}`;
}
/** States in which a pending wake says more than the activity itself. */
export const showsWake = (state: string) => ["idle", "ready", "sleeping", "closed", "interrupted"].includes(state);

/** An interval as the sidebar states it: "30 secs", "5 mins", "6 hrs", in the largest unit that is a whole number. */
export function everyLabel(seconds: number): string {
	const [count, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hr"] : seconds % 60 === 0 ? [seconds / 60, "min"] : [seconds, "sec"];
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * What a conversation that isn't working is still waiting on: agents it started, a watch on a command, or a time a watch
 * wakes it. Undefined when nothing is under way, or when its own activity (working, needs input) says more.
 */
export function backgroundWork(session: Parameters<typeof sessionActivity>[0] & Pick<SessionView, "watching" | "wakes" | "waiting" | "watchEvery">):
	{ kind: "agents" | "wake" | "watch"; label: string; title: string } | undefined {
	const activity = sessionActivity(session);
	if (!showsWake(activity)) return;
	const running = activity !== "sleeping" && activity !== "closed";
	const agents = running ? agentInventory(session.ui?.views ?? []).current : [];
	if (agents.length) return { kind: "agents", label: agents.length === 1 ? "Agent working" : `${agents.length} agents working`,
		title: `Waiting on ${agents.map(view => view.title).join(", ")}` };
	if (session.wakes) return { kind: "wake", label: wakeLabel(session.wakes),
		title: `A watch wakes it ${localDateTime(session.wakes)}${session.state === "closed" ? "; Desk reopens it then" : ""}` };
	// Running, its watches are listed by its view; asleep, by what Desk kept when it closed.
	const watches = session.ui?.views.find(view => view.id === "pi-watch")?.badges?.[0]?.description
		?? session.waiting?.map(item => `${item.title}${item.detail ? `: ${item.detail}` : ""}`).join("\n");
	if (session.watching) return { kind: "watch", label: session.watchEvery ? `Watching \u00b7 ${everyLabel(session.watchEvery)}` : "Watching",
		title: watches ? `Watching:\n${watches}` : "A watch wakes it when something happens" };
}

/**
 * What a sidebar row shows of a conversation: its dot, its status, and how many questions it asked without waiting,
 * those Desk keeps while it sleeps included. A question gives the dot its question mark, whatever else the
 * conversation waits on: a wake's or a watch's green ring said there was nothing to do. `unseen`: it has news no one
 * has looked at (shared/attention.ts); `finished` then says it is done, with nothing to wake it.
 */
export function rowStatus(session: Parameters<typeof backgroundWork>[0] & Pick<SessionView, "questions">, unseen: boolean):
	{ dot: string; label: string; title?: string; questions: number; finished: boolean } {
	const background = backgroundWork(session), activity = sessionActivity(session);
	const finished = unseen && !background && ["idle", "ready", "sleeping", "error"].includes(activity);
	const label = background?.label ?? (finished && activity !== "error" ? "Finished" : activityLabel(activity));
	const questions = openQuestions(session).filter(item => asksInBackground(item.form)).length;
	// An idle conversation still waiting on something is not done: its dot and label say what it waits on.
	const dot = questions ? "waiting" : background && (activity === "idle" || activity === "ready") ? "background" : finished && activity !== "error" ? "finished" : activity;
	return { dot, label, ...(background ? { title: background.title } : {}), questions, finished };
}

/**
 * Where the sidebar lists a conversation: 0 at work or waiting for the user; 1 only waiting for a watch or timer to wake
 * it, open or asleep (closed, kept to be woken); 2 closed. Those waiting and those closed fold away, each under its own
 * heading.
 */
export function sidebarGroup(session: Parameters<typeof backgroundWork>[0] & Pick<SessionView, "questions">): 0 | 1 | 2 {
	// A question keeps it in view whatever else it waits on, asleep too. One asked without waiting leaves the
	// conversation idle, so its activity doesn't say so, yet the window title counts it (question-alerts.ts).
	if (openQuestions(session).length) return 0;
	if (session.state === "closed" || session.state === "failed") return session.kept && (session.wakes || session.watching) ? 1 : 2;
	const waits = backgroundWork(session)?.kind;
	return waits === "wake" || waits === "watch" ? 1 : 0;
}

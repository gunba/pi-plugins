import type { SessionView } from "../shared/protocol.ts";
import { agentInventory } from "./agent-inventory.ts";

export function sessionActivity(session: Pick<SessionView, "state" | "snapshot" | "ui" | "interrupted" | "reconnecting" | "updating" | "kept" | "controls">): string {
	if (session.updating) return "updating";
	if (session.state !== "closed" && session.controls?.some(control => control.kind === "close" && control.state === "running")) return "closing";
	if (session.state === "closed" && session.kept) return "sleeping";
	if (session.state === "closed" || session.state === "failed") return session.state;
	if (session.reconnecting) return "connecting";
	if (session.ui?.interactions.some(item => !item.settings)) return "waiting";
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
	const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (new Date(at).toDateString() === new Date(now).toDateString()) return `Wakes ${time}`;
	return `Wakes ${new Date(at).toLocaleDateString([], at - now < 6 * 86_400_000 ? { weekday: "short" } : { day: "numeric", month: "short" })} ${time}`;
}
/** States in which a pending wake says more than the activity itself. */
export const showsWake = (state: string) => ["idle", "ready", "sleeping", "closed", "interrupted"].includes(state);

/**
 * What a conversation that isn't working is still waiting on: agents it started, a watch on a command, or a time a watch
 * wakes it. Undefined when nothing is under way, or when its own activity (working, needs input) says more.
 */
/** An interval as the sidebar states it: "30 secs", "5 mins", "6 hrs", in the largest unit that is a whole number. */
export function everyLabel(seconds: number): string {
	const [count, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hr"] : seconds % 60 === 0 ? [seconds / 60, "min"] : [seconds, "sec"];
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function backgroundWork(session: Parameters<typeof sessionActivity>[0] & Pick<SessionView, "watching" | "wakes" | "waiting" | "watchEvery">):
	{ label: string; title: string } | undefined {
	const activity = sessionActivity(session);
	if (!showsWake(activity)) return;
	const running = activity !== "sleeping" && activity !== "closed";
	const agents = running ? agentInventory(session.ui?.views ?? []).current : [];
	if (agents.length) return { label: agents.length === 1 ? "Agent working" : `${agents.length} agents working`,
		title: `Waiting on ${agents.map(view => view.title).join(", ")}` };
	if (session.wakes) return { label: wakeLabel(session.wakes),
		title: `A watch wakes it ${new Date(session.wakes).toLocaleString()}${session.state === "closed" ? "; Desk reopens it then" : ""}` };
	// Running, its watches are listed by its view; asleep, by what Desk kept when it closed.
	const watches = session.ui?.views.find(view => view.id === "pi-watch")?.badges?.[0]?.description
		?? session.waiting?.map(item => `${item.title}${item.detail ? `: ${item.detail}` : ""}`).join("\n");
	if (session.watching) return { label: session.watchEvery ? `Watching \u00b7 ${everyLabel(session.watchEvery)}` : "Watching",
		title: watches ? `Watching:\n${watches}` : "A watch wakes it when something happens" };
}

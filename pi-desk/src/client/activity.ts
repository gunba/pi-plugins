import type { SessionView } from "../shared/protocol.ts";

export function sessionActivity(session: Pick<SessionView, "state" | "snapshot" | "ui" | "interrupted">): string {
	if (session.state === "closed" || session.state === "failed") return session.state;
	if (session.ui?.interactions.some(item => !item.settings)) return "waiting";
	return session.interrupted ? "interrupted" : session.snapshot?.activity ?? session.state;
}
export function leadingActivity(states: readonly string[]): string {
	const normalized = states.map(state => state === "working" ? "running" : state === "attention" ? "waiting" : state === "ready" ? "idle" : state);
	return ["waiting", "error", "failed", "running", "starting", "connecting", "idle", "interrupted", "offline", "closed"]
		.find(state => normalized.includes(state)) ?? "closed";
}
export function activityLabel(state: string): string {
	switch (state) {
		case "running": case "working": return "Working";
		case "waiting": case "attention": return "Needs input";
		case "idle": case "ready": return "Idle";
		case "error": return "Needs attention";
		case "failed": case "interrupted": return "Stopped";
		case "starting": return "Starting";
		case "connecting": return "Connecting";
		case "online": return "Online";
		case "offline": return "Offline";
		case "closed": return "Closed";
		default: return state;
	}
}

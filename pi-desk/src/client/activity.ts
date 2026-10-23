import type { SessionView } from "../shared/protocol.ts";

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
		case "sleeping": return "Not running";
		case "connecting": return "Connecting";
		case "online": return "Online";
		case "offline": return "Offline";
		case "closed": return "Closed";
		default: return state;
	}
}

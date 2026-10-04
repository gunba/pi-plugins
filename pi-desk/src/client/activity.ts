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

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "paused" | "network-offline" | "denied" | "upgrade" | "closed";
export interface HostPresence { online: boolean; seen: number; checked: number }
export interface ConnectionInterruption { at: number; code?: number; reason: string }

interface Status {
	connection: ConnectionState;
	presence?: HostPresence;
}
/** Directory presence is a recent host report, not permission to send commands. */
export function connectionLabel(value: Status, now = Date.now()): string {
	if (value.connection === "reconnecting" && value.presence && !value.presence.online
		&& now - value.presence.checked < 90_000) return "Waiting for computer";
	return ({
		connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting",
		paused: "App paused", "network-offline": "This device is offline",
		denied: "Access unavailable", upgrade: "Update required", closed: "Disconnected",
	} satisfies Record<ConnectionState, string>)[value.connection];
}
export function connectionTone(value: Status): string {
	return value.connection === "connected" ? "online"
		: value.connection === "connecting" || value.connection === "reconnecting" ? "connecting"
			: value.connection === "upgrade" || value.connection === "denied" ? "attention"
				: value.connection === "paused" || value.connection === "closed" ? "paused" : "offline";
}
export function interruptionReason(code: number): string {
	switch (code) {
		case 1000: return "Connection closed";
		case 1006: return "Network or relay connection lost";
		case 1008: case 4002: return "Connection protocol rejected";
		case 1012: return "Computer connection restarted";
		case 1013: return "Connection temporarily unavailable";
		case 4001: return "Authorization refresh required";
		case 4003: return "Incompatible application version";
		case 4004: return "Authorization expired or connection timed out";
		default: return "Connection interrupted";
	}
}

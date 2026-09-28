export interface RuntimeUpdateState {
	current: string;
	pending?: string;
	phase: "idle" | "preparing" | "waiting" | "applying" | "failed";
	message?: string;
	activeSessions?: number;
}

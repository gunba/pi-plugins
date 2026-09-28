export interface RuntimeUpdateState {
	current: string;
	pending?: string;
	pendingId?: string;
	phase: "idle" | "preparing" | "waiting" | "applying" | "failed";
	message?: string;
	activeSessions?: number;
	available?: string;
	checkedAt?: number;
	checking?: boolean;
	checkError?: string;
}

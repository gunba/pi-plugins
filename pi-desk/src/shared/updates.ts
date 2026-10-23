export interface RuntimeUpdateState {
	current: string;
	pending?: string;
	pendingId?: string;
	phase: "idle" | "preparing" | "applying" | "failed";
	message?: string;
	activeSessions?: number;
	available?: string;
	checkedAt?: number;
	checking?: boolean;
	checkError?: string;
	/** Whether this computer updates itself, and moves idle conversations onto the new version, unasked. */
	automatic?: { host: boolean; conversations: boolean };
	/** Open conversations still running an older Desk than this host. */
	outdated?: number;
	/** Why an available update has not been installed automatically yet. */
	waiting?: string;
}

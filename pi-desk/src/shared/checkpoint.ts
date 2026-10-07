/** Private host/worker lifecycle IPC, not a model tool or client command. */
export type CheckpointAction = "inspect" | "hold" | "release";
export interface CheckpointSnapshot {
	session: string;
	file: string;
	cwd: string;
	leaf: string | null;
	running: boolean;
}
export interface UpdateCheckpoint {
	id: string;
	source: string;
	target: string;
	state: "held" | "committed" | "complete" | "cancelled";
	created: number;
	/** Present on host-only handoffs; sessions below are retained native-checkpoint migration data. */
	workers?: { key: string; instance: string; restored?: boolean; error?: string }[];
	/** Controller-confirmed selection failure permits the supervisor to reattach the source host. */
	resumeSource?: boolean;
	sessions: (CheckpointSnapshot & { key: string; dispatched?: boolean; restored?: boolean; error?: string })[];
}

/** A host-only update handoff: private host lifecycle state, not a model tool or client command. */
export interface UpdateCheckpoint {
	id: string;
	source: string;
	target: string;
	state: "held" | "committed" | "complete" | "cancelled";
	created: number;
	/** The running workers the replacement host adopts. */
	workers: { key: string; instance: string; restored?: boolean; error?: string }[];
	/** Controller-confirmed selection failure permits the supervisor to reattach the source host. */
	resumeSource?: boolean;
}

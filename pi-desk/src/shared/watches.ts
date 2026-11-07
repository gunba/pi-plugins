/** A watch as Desk shows it on a computer's page (host watches.ts): one this computer runs, or one its agents run elsewhere. */
export interface WatchSummary {
	/** Desk's id for it, the same on both computers when it runs on another. */
	id: string;
	/** Its name for the agent: w1, w2 and so on. */
	name: string;
	/** The agent it wakes, as this computer names it. */
	agent: string;
	/** The agent's computer, when it is another. */
	home?: string;
	/** The computer running it, when it is another: an agent here asked for it there. */
	runs?: string;
	/** Its label, or what it runs: a command, or a program's first line. */
	title: string;
	/** What the title leaves out: what a labelled watch runs, how often, and when it wakes the agent; may be empty. */
	detail: string;
	/** new: not started yet, or not yet confirmed by the computer running it. */
	state: "new" | "running" | "stopping";
	created: number;
	/** A time watch's time, which the app shows in its own time zone. */
	at?: number;
}

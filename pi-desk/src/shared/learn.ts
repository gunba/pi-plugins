export const LEARN_SETTINGS = "pi-desk/learn-settings-v1";
export const LEARN_NOTE = "pi-desk/learn-note-v1";

export interface LearnState { enabled: boolean; writing: boolean; error?: string }
export interface LearnNote {
	markdown: string;
	/** The last native activity covered, not the learning note's own entry. */
	source: string;
	model: string;
	cost: number;
}

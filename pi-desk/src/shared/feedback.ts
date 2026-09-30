export const FEEDBACK_ENTRY = "pi-desk/feedback/v1";
export interface Feedback {
	id: string;
	text: string;
	level: "warning" | "error";
	timestamp: number;
	generation: string;
}

export type Delivery = "steer" | "followUp" | "now";
export function composerKey(event: {
	key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean;
}, keyboard: boolean): Delivery | "newline" | undefined {
	if (event.isComposing || event.metaKey || event.shiftKey) return;
	if (event.ctrlKey && !event.altKey && event.key === "Enter") return "now";
	if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "j") return "newline";
	if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "q") return "followUp";
	if (event.key !== "Enter" || event.ctrlKey) return;
	if (event.altKey) return "followUp";
	return keyboard ? "steer" : undefined;
}

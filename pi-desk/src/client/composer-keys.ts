export type Delivery = "steer" | "followUp" | "now";
export const deliveryPreferenceKey = "pi-desk:send-mode";
/** Where a conversation's unsent message is kept in this browser. */
export const draftKey = (key: string) => `pi-desk:draft:${key}`;
/** Set while a conversation's draft holds dictated text, so the message tells the agent it was dictated. */
export const dictatedKey = (key: string) => `pi-desk:dictated:${key}`;
export function readDelivery(storage: Pick<Storage, "getItem">): Delivery {
	const value = storage.getItem(deliveryPreferenceKey);
	return value === "followUp" || value === "now" ? value : "steer";
}
export function composerKey(event: {
	key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean;
}, keyboard: boolean, preference: Delivery = "steer"): Delivery | "newline" | undefined {
	if (event.isComposing || event.metaKey || event.shiftKey) return;
	if (event.ctrlKey && !event.altKey && event.key === "Enter") return "now";
	if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "j") return "newline";
	if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "q") return "followUp";
	if (event.key !== "Enter" || event.ctrlKey) return;
	if (event.altKey) return "followUp";
	return keyboard ? preference : undefined;
}

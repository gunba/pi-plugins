export type Delivery = "steer" | "followUp" | "now";
export const deliveryPreferenceKey = "pi-desk:send-mode";
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

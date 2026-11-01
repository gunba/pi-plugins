import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	return {
		delivery: available ? "ready" : "paused",
		wakeable: available,
		deliveryReason: available ? undefined : "The agent is not running; messages wait until it is opened.",
	};
}

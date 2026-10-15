import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	return {
		delivery: peer.muted || !available ? "paused" : "ready",
		wakeable: !peer.muted && available,
		deliveryReason: peer.muted ? "Automatic delivery is paused. Resume it with agent_delivery or /inbox resume."
			: !available ? "The agent is not running; messages wait until it is opened."
			: undefined,
	};
}

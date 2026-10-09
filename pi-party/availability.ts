import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	const limited = peer.wakes >= 8;
	return {
		delivery: peer.muted ? "paused" : limited && state !== "working" ? "limited" : !available ? "paused" : "ready",
		wakeable: !peer.muted && available && !limited,
		deliveryReason: peer.muted ? "Automatic delivery is paused. Resume it with agent_delivery or /inbox resume."
			: limited && state !== "working" ? "Automatic wake limit reached. Resume delivery to reset it."
			: !available ? "The agent is not running; messages wait until it is opened."
			: undefined,
	};
}

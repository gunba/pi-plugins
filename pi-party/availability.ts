import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	const limited = peer.wakes >= 8;
	return {
		delivery: peer.muted ? "paused" : limited && state !== "working" ? "limited" : !available ? "paused" : "ready",
		wakeable: !peer.muted && available && !limited,
		deliveryReason: peer.muted ? "Automatic delivery is paused. Resume delivery in Party controls."
			: limited && state !== "working" ? "Automatic wake limit reached. Resume delivery in Party controls to reset it."
			: !available ? "Waiting for this agent or its owning driver to resume."
			: undefined,
	};
}

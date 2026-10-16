import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	// Jordan's Dot is a ChatGPT assistant reached through Desk's connector: messages wait for its next tool call.
	if (peer.cwd === "ChatGPT" && state !== "offline") return { delivery: "next check-in", wakeable: false,
		deliveryReason: `${peer.label} is ChatGPT's assistant: it receives agent messages with its next Pi tool call, when Jordan talks to it or on its scheduled checks. Agents cannot wake it.` };
	return {
		delivery: peer.muted || !available ? "paused" : "ready",
		wakeable: !peer.muted && available,
		deliveryReason: peer.muted ? "Automatic delivery is paused. Resume it with agent_delivery or /inbox resume."
			: !available ? "The agent is not running; messages wait until it is opened."
			: undefined,
	};
}

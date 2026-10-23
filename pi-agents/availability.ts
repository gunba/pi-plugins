import type { Member } from "./store.ts";

export function partyDelivery(peer: Member, available: boolean, state: string) {
	// Jordan's Dot is a ChatGPT assistant reached through Desk's connector. Desk marks it deliverable while it can post a
	// wake notice in the Dot's conversation; otherwise messages wait for the Dot's next tool call.
	if (peer.cwd === "ChatGPT" && state !== "offline") return available
		? { delivery: "ready", wakeable: true, deliveryReason: `${peer.label} is ChatGPT's assistant. Waking it posts a "Pi Desk:" notice in Jordan's chat with it, and it collects your message with its tools.` }
		: { delivery: "next check-in", wakeable: false, deliveryReason: `${peer.label} is ChatGPT's assistant: it receives agent messages with its next Pi tool call, when Jordan talks to it or on its scheduled checks. Desk's connection to its chat is down, so agents cannot wake it now.` };
	return {
		delivery: available ? "ready" : "paused",
		wakeable: available,
		deliveryReason: available ? undefined : "The agent is not running; messages wait until it is opened.",
	};
}

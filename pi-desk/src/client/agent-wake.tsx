import type { PartyAgent } from "../shared/parties.ts";
import { Icon } from "./icons.tsx";

/** Shown when an agent's automatic replies to other agents' messages are held by its wake limit. */
export function AgentWakeMarker({ agent }: { agent?: PartyAgent }) {
	return agent?.delivery === "limited" ? <span className="party-wake-held" role="img" aria-label="Automatic wake held"
		title={agent.deliveryReason}><Icon name="pause" /><span>Wake held</span></span> : null;
}

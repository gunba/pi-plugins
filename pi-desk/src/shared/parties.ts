/** A registered agent as shown by Desk; messaging itself happens through agent tools. */
export interface PartyAgent {
	id: string;
	label: string;
	cwd: string;
	description: string;
	kind: string;
	state: string;
	delivery: string;
	deliveryReason?: string;
}
export interface PartyDirectory {
	agents: PartyAgent[];
	/** Always empty; kept so website tabs from before party removal keep rendering. Remove with the next API bump. */
	groups: never[];
}

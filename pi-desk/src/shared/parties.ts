export interface PartyAgent {
	id: string;
	epoch: string;
	label: string;
	cwd: string;
	description: string;
	kind: string;
	party: string | null;
	state: string;
}
export interface PartyDirectory {
	agents: PartyAgent[];
	groups: { name: string; members: string[] }[];
}

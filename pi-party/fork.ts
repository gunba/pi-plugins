import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** The executing assistant turn is not complete until its fork tool returns. */
export function partyForkPoint(branch: readonly SessionEntry[], call: string): string {
	for (let index = branch.length - 1; index > 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.content.some(block => block.type === "toolCall" && block.name === "party_fork" && block.id === call)) return branch[index - 1].id;
	}
	throw Error("The executing fork call has no saved context checkpoint.");
}

export function createPartyFork(source: string, session: string, call: string): { cwd: string; file: string } {
	// A separate manager owns the new branch; the running parent's manager never switches files.
	const manager = SessionManager.open(source);
	if (manager.getSessionId() !== session) throw Error("The source agent's saved session changed.");
	const file = manager.createBranchedSession(partyForkPoint(manager.getBranch(), call));
	if (!file) throw Error("The fork requires a persistent native Pi session.");
	return { cwd: manager.getCwd(), file };
}

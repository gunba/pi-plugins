export type AgentRunState = {
	name: string;
	state: string;
};

const TERMINAL_AGENT_STATES = new Set(["done", "error", "stopped"]);

export function terminalRunCanHide(
	agents: AgentRunState[],
	isActive: (name: string) => boolean,
	hasPendingMessages: boolean,
): boolean {
	return (
		agents.length > 0 &&
		agents.every(
			(agent) => TERMINAL_AGENT_STATES.has(agent.state) && !isActive(agent.name),
		) &&
		!hasPendingMessages
	);
}

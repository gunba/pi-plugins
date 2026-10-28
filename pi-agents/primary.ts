import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Primary agents are conversations in Jordan's Desk, on any of his computers, that he can open and talk to; secondary
 * agents are helpers a conversation starts in the background (subagents/). The agent tools are defined with the
 * subagent runtime, which knows the caller in every session, and reach primary agents through the operations this
 * package provides for its conversation.
 */
export interface PrimaryAgents {
	/** Starts a conversation once Jordan approves it here; `copy` gives it this conversation so far. */
	start(request: PrimaryStart, toolCallId: string, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Record<string, unknown>>;
	send(request: { to: string; message: string; wake: boolean; files?: string[] }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Record<string, unknown>>;
	list(request: { query?: string; offline?: boolean; offset?: number }): Record<string, unknown>;
	/** Closes a conversation this one started. */
	close(request: { agent: string; note?: string }, signal: AbortSignal | undefined): Promise<Record<string, unknown>>;
}
export type PrimaryStart = { name: string; task: string; copy: boolean; computer?: string; cwd?: string; model?: string; reasoning?: string };

// Jiti and the SDK may load separate module instances in one process.
const key = Symbol.for("gunba.pi-agents.primary.v1");
const registry = ((globalThis as Record<symbol, unknown>)[key] ??= new Map<string, PrimaryAgents>()) as Map<string, PrimaryAgents>;
export const primaryAgents = (sessionId: string): PrimaryAgents | undefined => registry.get(sessionId);
export function providePrimaryAgents(sessionId: string, agents: PrimaryAgents | undefined): void {
	if (agents) registry.set(sessionId, agents); else registry.delete(sessionId);
}

const labelsKey = Symbol.for("gunba.pi-agents.labels.v1");
const labels = ((globalThis as Record<symbol, unknown>)[labelsKey] ??= new Map<string, string>()) as Map<string, string>;
/** Names of primary agents this process has listed, for showing messages to them. */
export function rememberAgentLabels(agents: readonly { session: string; label: string }[]): void {
	for (const agent of agents) labels.set(agent.session, agent.label);
}
/** An agent's name for display: a listed primary agent's label, matched by ID or unique prefix; otherwise the ID itself. */
export function agentLabel(id: string): string {
	const exact = labels.get(id);
	if (exact !== undefined) return exact;
	const matches = [...labels].filter(([session]) => session.startsWith(id));
	return matches.length === 1 ? matches[0]![1] : id;
}

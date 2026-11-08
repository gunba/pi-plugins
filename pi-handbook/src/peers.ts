/**
 * How the handbook tool reads another agent's handbook. pi-agents, which knows the agents and can ask other
 * computers, provides the reader in the process; Desk loads extensions as separate bundles, so it is kept on
 * globalThis rather than in a module.
 */
export type HandbookReader = (agent: string, signal?: AbortSignal) => Promise<string>;
const KEY = Symbol.for("pi-handbook/read-agent");

export function provideHandbookReader(reader: HandbookReader | undefined): void {
	(globalThis as Record<symbol, unknown>)[KEY] = reader;
}
export function handbookReader(): HandbookReader | undefined {
	return (globalThis as Record<symbol, unknown>)[KEY] as HandbookReader | undefined;
}

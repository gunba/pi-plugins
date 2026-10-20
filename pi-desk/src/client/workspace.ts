import type { HostEvent, HostState, SessionView } from "../shared/protocol.ts";
import type { ConnectionInterruption, ConnectionState, HostPresence } from "./connection-state.ts";

export interface Computer {
	/** loaded: its conversations have arrived at least once. */
	id: string; name: string; platform?: string; cwd: string; connected: boolean; connection: ConnectionState; epoch: number; error?: string; loaded?: boolean;
	/** Its conversation-copy switches and the copies it keeps (teleport). */
	teleport?: import("../shared/protocol.ts").HostState["teleport"];
	/** Round-trip milliseconds over the browser's connection, and whether it is direct rather than through the relay. */
	latency?: number; direct?: boolean;
	presence?: HostPresence;
	diagnostics?: { interruptions: number; last?: ConnectionInterruption };
	relay?: HostState["relay"];
	operatorAvailability?: HostState["operatorAvailability"];
	release?: HostState["release"];
	updates?: HostState["updates"];
	storageError?: string;
	parties?: HostState["parties"];
	quests?: HostState["quests"];
	dictation?: boolean;
	cacheCompaction?: number;
	settingsSync?: HostState["settingsSync"];
}
export interface WorkspaceSession extends SessionView { computer?: string }
export interface WorkspaceState extends HostState { sessions: WorkspaceSession[]; computers?: Computer[]; directoryError?: string }
export type WorkspaceEvent = Exclude<HostEvent, { type: "state" | "session" }>
	| { type: "state"; state: WorkspaceState } | { type: "session"; session: WorkspaceSession };
export const sessionKey = (computer: string, key: string) => `${computer}:${key}`;

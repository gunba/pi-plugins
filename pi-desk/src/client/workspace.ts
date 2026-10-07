import type { HostEvent, HostState, SessionView } from "../shared/protocol.ts";
import type { ConnectionInterruption, ConnectionState, HostPresence } from "./connection-state.ts";

export interface Computer {
	id: string; name: string; platform?: string; cwd: string; connected: boolean; connection: ConnectionState; epoch: number; error?: string;
	presence?: HostPresence;
	diagnostics?: { interruptions: number; last?: ConnectionInterruption };
	relay?: HostState["relay"];
	operatorAvailability?: HostState["operatorAvailability"];
	release?: HostState["release"];
	updates?: HostState["updates"];
	storageError?: string;
	parties?: HostState["parties"];
}
export interface WorkspaceSession extends SessionView { computer?: string }
export interface WorkspaceState extends HostState { sessions: WorkspaceSession[]; computers?: Computer[]; directoryError?: string }
export type WorkspaceEvent = Exclude<HostEvent, { type: "state" | "session" }>
	| { type: "state"; state: WorkspaceState } | { type: "session"; session: WorkspaceSession };
export const sessionKey = (computer: string, key: string) => `${computer}:${key}`;

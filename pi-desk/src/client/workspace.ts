import type { HostEvent, HostState, SessionView } from "../shared/protocol.ts";

export interface Computer {
	id: string; name: string; cwd: string; online: boolean; epoch: number; error?: string;
	relay?: HostState["relay"];
	release?: HostState["release"]; upgrade?: boolean;
}
export interface WorkspaceSession extends SessionView { computer?: string }
export interface WorkspaceState extends HostState { sessions: WorkspaceSession[]; computers?: Computer[]; directoryError?: string }
export type WorkspaceEvent = Exclude<HostEvent, { type: "state" | "session" }>
	| { type: "state"; state: WorkspaceState } | { type: "session"; session: WorkspaceSession };
export const sessionKey = (computer: string, key: string) => `${computer}:${key}`;

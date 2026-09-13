import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const WORKSPACE_DISCOVER = "pi-workspace/discover-v1";
export interface WorkspaceViewHandle {
	show(): void;
	refresh(): void;
	dispose(): void;
}
export interface WorkspaceApi {
	openFile(path: string, options?: { line?: number; diff?: boolean }): Promise<void>;
	registerView(
		id: string,
		title: string,
		factory: (tui: TUI, theme: Theme) => Component & { dispose?(): void },
	): WorkspaceViewHandle;
}

/** Acquire on session_start. The returned API and view handles expire with that session. */
export function getWorkspace(pi: ExtensionAPI): WorkspaceApi | undefined {
	const request: { workspace?: WorkspaceApi } = {};
	pi.events.emit(WORKSPACE_DISCOVER, request);
	return request.workspace;
}

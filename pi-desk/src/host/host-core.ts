import type { ApiResponse } from "../shared/relay-protocol.ts";
import type { HostEvent, HostState, SessionView } from "../shared/protocol.ts";
import type { Attachments } from "./attachments.ts";
import type { InputLedger } from "./inputs.ts";
import type { SessionWorker } from "./worker-client.ts";

export interface HostOptions { cwd: string; port?: number; dataDir?: string; agentDir?: string; sessionDir?: string; proxy?: string }
export interface ModelChoice { model?: string; reasoning?: string }
export interface ManagedSession { view: SessionView; worker?: SessionWorker; initialized?: boolean; initialGeneration?: string; draining?: Promise<void>; reconciling?: boolean; reconnectAt?: number;
	/** A new conversation's chosen model, applied once it is ready and before any message is delivered. */
	setup?: ModelChoice; settingUp?: Promise<void>;
	/** Keep it in the sidebar once its close completes. */
	keepOnClose?: boolean;
	/** Its process is being replaced: closing it is the first half of a restart, so it stays open and selected. */
	replacing?: boolean;
	/** Desk reopened it for a watch while it was closed; it closes again, kept, once it has been idle a while. */
	sleepWhenIdle?: boolean;
	/** When it was last seen idle while it may go back to sleep. */
	idleSince?: number }

/** The host's conversations and the operations on them that its other parts use; DeskHost (server.ts) provides it. */
export interface HostCore {
	readonly options: HostOptions & { agentDir: string };
	/** Desk's data folder on this computer. */
	readonly directory: string;
	readonly origin: string;
	readonly closing: boolean;
	/** Conversations that were running before a host update are still being reattached. */
	readonly restoringUpdate: boolean;
	/** An update holds new admissions while the host is handed over. */
	readonly held: boolean;
	readonly sessions: Map<string, ManagedSession>;
	readonly inputs: InputLedger;
	state(): HostState;
	emit(event: HostEvent): void;
	persist(immediate?: boolean): void;
	/** As persist, logging a failure instead of throwing it. */
	persistEvent(immediate?: boolean): void;
	createSession(cwd: string, sessionFile?: string, existing?: ManagedSession, takeover?: boolean, adopt?: string): string;
	waitForSession(key: string, timeoutMs?: number): Promise<ManagedSession>;
	/** Close an idle conversation's worker and reopen it on this host's current runtime. */
	replaceWorker(managed: ManagedSession): Promise<string>;
	/** Publish a conversation's pending inputs after they changed. */
	inputEvent(managed: ManagedSession): void;
	drainInputs(managed: ManagedSession): void;
	attachments(key: string): Attachments;
	/** Re-read the agent directory the app shows, and tell browsers and the other computers when it changed. */
	refreshParties(): void;
}

export const reply = (body: unknown, status = 200): ApiResponse => ({ body, status });

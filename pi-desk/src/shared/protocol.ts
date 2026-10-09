import type { UiInteraction, UiValue, UiView } from "../../../pi-ui/index.ts";
import type { Ledger } from "../../../pi-context-ledger/model.ts";
import type { FileCommand, FileReference } from "./files.ts";
import type { HistoryPosition } from "./history.ts";
import type { ReferenceOrigin } from "./references.ts";
import type { ControlStatus } from "./controls.ts";
import type { ReleaseInfo } from "./release.ts";
import type { InputStatus } from "./inputs.ts";

export interface ViewSnapshot extends UiView {
	id: string; revision: number; scope?: { id: string; label: string };
	working?: string; actionError?: string;
}
export interface InteractionSnapshot {
	id: string;
	form: UiInteraction;
	settings?: { id: string; title: string };
	deadline?: number;
	scope?: { id: string; label: string };
}
export interface PresentationSnapshot {
	generation: string;
	views: ViewSnapshot[];
	interactions: InteractionSnapshot[];
	statuses: Record<string, string>;
	notifications: { id: string; text: string; level: "info" | "warning" | "error"; timestamp?: number; generation?: string }[];
	editorText: string;
	editorId: string;
	title: string;
}
export interface SessionSnapshot {
	id: string;
	file?: string;
	cwd: string;
	name?: string;
	title?: string;
	leaf?: string | null;
	model?: { id: string; provider: string; name: string; images: boolean; accountName?: string };
	defaultModel?: { id: string; provider: string };
	/** Null means context-aware switching is supported without a current constraint. */
	modelSwitchConstraint?: { provider: string; reason: string; portable?: boolean } | null;
	accounts?: Record<string, string>;
	thinking: string;
	thinkingLevels: string[];
	activity: "idle" | "running" | "waiting" | "error";
	tools: { name: string; description: string; active: boolean;
		exposure?: string; callable?: boolean; declared?: boolean; defaultActive?: boolean;
		source?: string; conversationChoice?: boolean }[];
	/** Omitted by workers that do not publish native tool-selection provenance. */
	toolDefaults?: { computer?: string[]; project?: string[]; resolved?: string[] };
	extensions: { path: string; error?: string }[];
	commands: import("./prompt-commands.ts").PromptCommandInfo[];
	models: { id: string; provider: string; name: string; accountName?: string }[];
	queue: { steering: { count: number; previews: string[] }; followUp: { count: number; previews: string[] } };
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	ui: PresentationSnapshot;
}
export type ChatBlock =
	| { type: "file"; file: FileReference }
	| { type: "artifact"; id: string; label: string }
	| { type: "diff"; path: string; action: string; movePath?: string; text: string; full?: string; truncated: boolean; file?: FileReference }
	| { type: "ledger"; ledger: Ledger }
	| { type: "text" | "thinking"; text: string; full?: string; truncated?: boolean }
	| { type: "image"; asset: string; mimeType: string }
	| { type: "toolCall"; id: string; name: string; arguments: string; full?: string; truncated?: boolean; file?: FileReference };
export interface ChatMessage {
	id: string;
	order: number;
	revision: number;
	entryId?: string;
	role: "user" | "assistant" | "tool" | "note";
	blocks: ChatBlock[];
	timestamp: number;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	complete?: boolean;
	tool?: { state: "running" | "done" | "error" | "interrupted"; seconds?: number; exitCode?: number; processId?: number; processRunning?: boolean };
	nested?: { complete: boolean; calls: { name: string; status: "ok" | "error" | "unfinished"; seconds?: number; skills?: string[] }[] };
	feedback?: import("./feedback.ts").Feedback;
	links?: { target: string; file: FileReference }[];
	notice?: { kind: "party" | "process" | "work" | "agent" | "schedule"; title: string; queuedAt?: number; dueAt?: number };
}
export interface ArtifactPage { generation: string; text: string; offset: number; next: number | null; total: number }
export interface HistoryPage { messages: ChatMessage[]; before?: string; after?: string; revision: number; generation: string }
export interface TreePage {
	generation: string;
	leaf: string | null;
	entries: { id: string; parentId: string | null; type: string; label: string; timestamp: string }[];
	next?: string;
}
export interface SavedSession {
	id: string; file: string; cwd: string; name?: string; firstMessage: string; messageCount: number; modified: string;
}
export interface WorkerRuntimeInfo { version: string; plugins: string; engine: string; runtime?: string; unattended?: boolean; sendNow?: boolean; queueNow?: boolean }
export interface SessionView {
	key: string;
	/** Native Pi identity, distinct from the Desk workspace key. */
	agentId?: string;
	cwd: string;
	created: number;
	state: "starting" | "ready" | "failed" | "closed";
	/** The host is reconnecting to the same actor, not starting a native session. */
	reconnecting?: boolean;
	/** Native state; presentation data is carried once in ui below. */
	snapshot?: Omit<SessionSnapshot, "ui">;
	/** Native history can be browsed before extensions finish starting. */
	historyReady?: boolean;
	ui?: PresentationSnapshot;
	error?: string;
	file?: string;
	name?: string;
	title?: string;
	pinned?: boolean;
	interrupted?: boolean;
	leaf?: string | null;
	controls?: ControlStatus[];
	activation?: string;
	workerRuntime?: WorkerRuntimeInfo;
	inputs?: InputStatus[];
}
export interface HostState { release: ReleaseInfo; operatorAvailability?: import("./operator.ts").OperatorAvailability; storageError?: string; name: string; platform?: string; cwd: string; sessions: SessionView[];
	parties?: import("./parties.ts").PartyDirectory;
	updates?: import("./updates.ts").RuntimeUpdateState;
	relay?: { origin: string; appOrigin: string; state: "connecting" | "online" | "offline"; error?: string } }
export type HostEvent =
	| { type: "state"; state: HostState }
	| { type: "session"; session: SessionView }
	| { type: "worker"; key: string; message: WorkerMessage };
export interface WorkerInit {
	cwd: string; agentDir?: string; sessionFile?: string; sessionDir?: string; ephemeral?: boolean;
	leaf?: string | null; attachmentScope?: string;
	/** Code location pinned in the private worker bootstrap, not its environment. */
	runtimeDirectory?: string;
	providerAccountsDirectory?: string;
	/** Explicit user resume may ask a participating terminal owner to shut down. */
	takeover?: boolean;
	/** Reopen saved native state without autonomous work until restoration finishes. */
	checkpoint?: string;
}
export type WorkerCommand =
	| (FileCommand & { origin: ReferenceOrigin })
	| { kind: "snapshot" }
	| { kind: "context_inspect" }
	| { kind: "context_read"; path: string }
	| ({ kind: "context_update" } & import("./context.ts").ContextChange)
	| { kind: "context_save"; path: string; version: string; text: string }
	| ({ kind: "history"; source?: string } & HistoryPosition)
	| { kind: "tree"; after?: string }
	| { kind: "navigate"; entry: string; summarize?: boolean }
	| { kind: "fork"; entry: string; position: "before" | "at" }
	| { kind: "compact"; instructions?: string }
	| { kind: "asset"; id: string; origin: ReferenceOrigin }
	| { kind: "artifact"; id: string; offset: number; query?: string; origin: ReferenceOrigin }
	| { kind: "prompt"; text: string; attachments?: string[]; behavior?: "steer" | "followUp" | "now" }
	| { kind: "native_read"; name: string; args: string }
	| { kind: "native"; name: string; args: string }
	| { kind: "abort" }
	| { kind: "queue_now"; queue: "steering" | "followUp"; index: number; text: string }
	| { kind: "answer"; id: string; answer: unknown }
	| { kind: "action"; view: string; revision: number; action: string; value?: UiValue }
	| { kind: "name"; name: string }
	| { kind: "model"; provider: string; id: string; makeDefault?: boolean; context?: { mode: "portable"; leaf: string } }
	| { kind: "account"; provider: string; id: string }
	| { kind: "thinking"; level: string }
	| { kind: "reload" };
export interface WorkerState {
	runtime?: WorkerRuntimeInfo;
	snapshot?: SessionSnapshot;
	controls: ControlStatus[];
	historyReady?: string;
	initialGeneration?: string;
}
export type WorkerReceipt = { state: "missing" | "running" | "retired" } | { state: "finished"; result: Extract<WorkerMessage, { type: "result" }> };
export type WorkerRequest =
	| { type: "init"; id: string; options: WorkerInit }
	| { type: "shutdown"; id: string; force?: boolean }
	| { type: "describe"; id: string }
	| { type: "receipt"; id: string; target: string; wait?: boolean }
	| { type: "control"; id: string; generation: string; command: import("./controls.ts").ControlCommand | { kind: "close" } }
	| { type: "checkpoint"; id: string; action: import("./checkpoint.ts").CheckpointAction; checkpoint: string }
	| { type: "command"; id: string; generation: string; command: WorkerCommand };
export type TranscriptEvent =
	| { type: "chat"; generation: string; message: ChatMessage; replaces?: string }
	| { type: "block"; generation: string; id: string; revision: number; index: number; block: ChatBlock }
	| { type: "delta"; generation: string; id: string; revision: number; index: number; kind: "text" | "thinking"; text: string; truncated?: boolean };
export type WorkerMessage =
	| { type: "result"; id: string; value?: unknown; error?: string; code?: "stale_generation" | "receipt_conflict" }
	| { type: "control"; control: ControlStatus }
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "history_ready"; generation: string }
	| { type: "event"; event: unknown }
	| TranscriptEvent
	| { type: "transcript"; source: string; event: TranscriptEvent }
	| { type: "open_view"; view: string; section?: string }
	| { type: "ui"; snapshot: PresentationSnapshot }
	| { type: "detached"; error: string }
	| { type: "fatal"; error: string };

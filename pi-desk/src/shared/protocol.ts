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
	/** No messages yet, so a provider switch carries nothing over. Omitted by older workers. */
	empty?: boolean;
	model?: { id: string; provider: string; name: string; images: boolean };
	defaultModel?: { id: string; provider: string };
	/** Null means context-aware switching is supported without a current constraint. */
	modelSwitchConstraint?: { provider: string; reason: string; portable?: boolean } | null;
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
	models: { id: string; provider: string; name: string }[];
	queue: { steering: { count: number; previews: string[] }; followUp: { count: number; previews: string[] } };
	/** `estimated` when no provider-reported usage applies and the tokens are counted from characters. */
	context?: { tokens: number | null; contextWindow: number; percent: number | null; estimated?: boolean };
	/** Branch order of the first message the model still sees verbatim; earlier messages survive only in a summary. */
	contextFrom?: number;
	compacting?: { reason: "manual" | "threshold" | "overflow" | "cache"; started: number };
	/** When the conversation's prompt cache was last used, and how long the provider keeps it after a use. */
	cache?: { usedAt: number; ttlMs: number };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
		/** Spend by kind at API prices, including compaction, cache warming and child agents. */
		costs?: { input: number; output: number; cacheRead: number; cacheWrite: number };
		/** Prompt tokens billed again because the cache missed, and what that cost over cache reads. */
		missed?: { tokens: number; cost: number; count: number } };
	ui: PresentationSnapshot;
}
export type ChatBlock =
	| { type: "file"; file: FileReference }
	| { type: "artifact"; id: string; label: string }
	/** meanwhile: changed while no tool call was running (a background process, another program). */
	/** note: why there is no diff (a binary or large file); text is then empty. */
	| { type: "diff"; path: string; action: string; movePath?: string; text: string; full?: string; truncated: boolean; file?: FileReference; added?: number; removed?: number; meanwhile?: boolean; note?: string }
	/** Computed changes to a spreadsheet, document or deck, or a summary of a new one. */
	| { type: "document"; change: import("../../../pi-show/extensions/types.ts").DocumentChange; file?: FileReference }
	/** Work an agent showed with the show tool; `files` lines up with `shown.items`. */
	| { type: "shown"; shown: import("../../../pi-show/extensions/types.ts").Shown; files: (FileReference | null)[] }
	| { type: "ledger"; ledger: Ledger }
	| { type: "text" | "thinking"; text: string; full?: string; truncated?: boolean }
	| { type: "image"; asset: string; mimeType: string }
	/** description: the one line the model wrote for the user about this call (pi-ui tool-descriptions.ts). */
	| { type: "toolCall"; id: string; name: string; arguments: string; full?: string; truncated?: boolean; file?: FileReference; description?: string };
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
	notice?: { kind: "party" | "process" | "work" | "agent" | "schedule" | "compaction"; title: string; queuedAt?: number; dueAt?: number };
	/** A saved summary that replaced earlier context: compaction, an encrypted Codex checkpoint, a model handoff or an abandoned branch. */
	summary?: { kind: "compaction" | "checkpoint" | "handoff" | "branch"; tokensBefore?: number; cost?: number; model?: string };
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
/** brief: the worker writes "What do I need to know?" briefs (Desk 0.5.141 and later). */
export interface WorkerRuntimeInfo { version: string; plugins: string; engine: string; runtime?: string; unattended?: boolean; sendNow?: boolean; queueNow?: boolean; brief?: boolean }
export interface SessionView {
	key: string;
	/** Native Pi identity, distinct from the Desk workspace key. */
	agentId?: string;
	cwd: string;
	created: number;
	state: "starting" | "ready" | "failed" | "closed";
	/** The host is reconnecting to the same actor, not starting a native session. */
	reconnecting?: boolean;
	/** Desk is restarting this idle conversation onto its current version. */
	updating?: boolean;
	/** Closed to free resources but kept in the sidebar to resume later. */
	kept?: boolean;
	/** It moved to another computer (teleport); it does not run here again. */
	moved?: { to: string; at: number };
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
/** A conversation's copy kept on another computer (host copies.ts): whose it is, where it ran, how much there is. */
export type ConversationCopy = { session: string; computer: string; cwd: string; title?: string; size: number; head: string; updated: number; moved?: { to: string; at: number };
	/** Open on its computer when that was last seen, as its agent directory said. */
	open?: boolean };
export interface HostState { release: ReleaseInfo; operatorAvailability?: import("./operator.ts").OperatorAvailability; storageError?: string; name: string; platform?: string; cwd: string; sessions: SessionView[];
	parties?: import("./parties.ts").PartyDirectory;
	updates?: import("./updates.ts").RuntimeUpdateState;
	/** This computer's quest log. Omitted by hosts before 0.5.62. */
	quests?: import("./quests.ts").QuestView;
	/** Compact idle conversations before their prompt cache expires, above this percent of the context budget. */
	cacheCompaction?: number;
	/** The last Pi setting or file that arrived from another computer (settings sync). */
	settingsSync?: { key: string; from: string; at: number };
	/** Conversation copies and moves (host teleport.ts): this computer's switches, and the copies it keeps of other computers' conversations. */
	teleport?: { hold: boolean; send: boolean; copies: ConversationCopy[] };
	/** This computer has an ElevenLabs key for dictation; browsers send recordings to a computer that does. */
	dictation?: boolean;
	relay?: { origin: string; appOrigin: string; state: "connecting" | "online" | "offline"; error?: string } }
/** A computer's dictation settings as the settings page sees them; the ElevenLabs key never leaves the computer. */
export interface DictationSettings { configured: boolean; keyterms: string[] }
export type HostEvent =
	| { type: "state"; state: HostState }
	| { type: "session"; session: SessionView }
	| { type: "worker"; key: string; message: WorkerMessage };
export interface WorkerInit {
	cwd: string; agentDir?: string; sessionFile?: string; sessionDir?: string; ephemeral?: boolean;
	leaf?: string | null; attachmentScope?: string;
	/** Code location pinned in the private worker bootstrap, not its environment. */
	runtimeDirectory?: string;
	/** Desk's data folder on this computer (operator availability). */
	deskDirectory?: string;
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
	/** Switch this conversation's Pi process to another saved session, as Pi's /resume does. */
	| { kind: "switch"; file: string }
	| { kind: "compact"; instructions?: string; reason?: "cache" }
	| { kind: "asset"; id: string; origin: ReferenceOrigin }
	| { kind: "artifact"; id: string; offset: number; query?: string; origin: ReferenceOrigin }
	| { kind: "prompt"; text: string; attachments?: string[]; behavior?: "steer" | "followUp" | "now" }
	/** Start a turn with a Desk message (shown, not the user's): an agent that moved itself here continues from its note. */
	| { kind: "continue"; text: string }
	| { kind: "native_read"; name: string; args: string }
	/** "What do I need to know?": a brief on the latest turn, written outside the conversation; refresh writes it again. */
	| { kind: "brief"; refresh?: boolean }
	| { kind: "native"; name: string; args: string }
	| { kind: "abort" }
	| { kind: "queue_now"; queue: "steering" | "followUp"; index: number; text: string }
	| { kind: "answer"; id: string; answer: unknown }
	| { kind: "action"; view: string; revision: number; action: string; value?: UiValue }
	| { kind: "name"; name: string }
	| { kind: "model"; provider: string; id: string; makeDefault?: boolean; context?: { mode: "portable"; leaf: string } }
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

import type { AgentSessionEvent, ExtensionAPI, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Host-neutral presentations. Domain state and action implementations stay in extensions. */
export type UiValue = null | boolean | number | string | UiValue[] | { [key: string]: UiValue | undefined };
export type UiAction = {
	id: string; label: string; destructive?: boolean;
	/** A session host may stop active work, apply this setting and continue that turn. */
	interrupt?: "resume";
	/** Inline message admission: resolve only after the controller has accepted the text. */
	input?: "message";
	delivery?: "steer" | "followUp";
};
export type UiConversation = {
	transcript?: string;
	scope?: string;
	status: string;
	active: boolean;
	subtitle?: string;
	activity?: string;
	error?: string;
	fields?: { label: string; value: string }[];
};
export type UiDetails = {
	summary?: string;
	links?: { label: string; url: string }[];
	transcript?: string;
	fields?: { label: string; value: string }[];
	controls?: UiControl[];
	items?: { id: string; title: string; subtitle?: string; body?: string; status?: string;
		meter?: { value: number; max: number; label: string };
		actions?: UiAction[] }[];
};
export type UiControl = {
	label: string; action: UiAction; help?: string; disabled?: boolean;
} & (
	| { kind: "toggle"; value: boolean }
	| { kind: "select"; value: string; options: { value: string; label: string }[] }
	/** secret: a password-style field, for keys; the value shown is never the saved secret. */
	| { kind: "text"; value: string; placeholder?: string; secret?: boolean }
	| { kind: "range"; value: number; min: number; max: number; step?: number; used?: number | null; unit?: string }
);
export interface UiView {
	/** Compact always-visible summary; opening it shows this view's normal details. */
	preview?: { label: string; primary: string; secondary?: string };
	kind: string;
	title: string;
	surface?: "work" | "settings";
	data: UiValue;
	/** Compact, factual values owned by this view. Hosts may show them beside the conversation. */
	badges?: { label: string; value: string; description?: string; compact?: boolean;
		/** An icon hosts may draw in place of the label, which stays its accessible name: "eye" or "clock". Opening the badge opens this view. */
		icon?: "eye" | "clock";
		/** Action ID of a published toggle control for direct interaction. */
		control?: string;
		/** A remaining amount hosts may draw as a gauge, with value as its text alternative. */
		meter?: { value: number; max: number; resetsAt?: number } }[];
	/** Model capacity and the selected working window, in tokens. */
	context?: { capacity: number; limit: number };
	/** When, in ms since the epoch, this view's owner next needs the conversation running. A host that closes or loses
	 * the conversation's process shows this time and reopens the conversation then. This is a process-lifecycle hint;
	 * the owner restores its subscription and delivers any event, not the host. */
	wakes?: number;
	/** The view's owner needs the conversation running to watch for something. A host that lost the conversation's
	 * process without being asked to close it (the computer restarted, say) starts it again. */
	watching?: boolean;
	/** How often, in seconds, the owner checks for something while watching, when it checks on a schedule (its shortest
	 * interval). Hosts may show it beside watching. */
	watchEvery?: number;
	/** Files that change when this view's owner has news, such as a watched command's log and exit status. A host that
	 * closed the conversation, keeping it listed, reopens it when one of them changes; removing it, the host deletes them,
	 * and whatever writes them stops. */
	wakeFiles?: string[];
	/** The view's owner asks the host to close the conversation, keeping it listed, once it is idle. */
	close?: boolean;
	actions?: UiAction[];
}
export interface UiQuestion {
	kind: "question";
	title: string;
	context?: string;
	options: { title: string; description?: string }[];
	allowMultiple: boolean;
	allowFreeform: boolean;
	allowComment: boolean;
}
export interface UiTextInput {
	kind: "input" | "editor";
	title: string;
	context?: string;
	links?: { label: string; url: string }[];
	placeholder?: string;
	value?: string;
	submitLabel?: string;
}
export interface UiConfirmation { kind: "confirm"; title: string; message: string }
export type UiInteraction = UiQuestion | UiTextInput | UiConfirmation;
export type UiAnswer =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string }
	| { kind: "confirm"; confirmed: boolean };
export type UiResource = {
	path: string; title: string; kind: "context" | "skill" | "prompt" | "extension";
	loaded: boolean; readonly?: boolean; description?: string;
};
export interface Presentation {
	version: 2;
	/** The host is holding this session for maintenance. Autonomous producers keep their pending work. */
	readonly suspended?: boolean;
	/** False while the user is away: no window of Desk has been used for a while. Questions still wait for an answer. */
	readonly operatorAvailable?: boolean;
	/** Set as the conversation closes, before its extensions shut down: "sleep" when the host keeps it listed and reopens it
	 * when its views' wakeFiles change, so work that writes them goes on; "end" otherwise. */
	readonly closing?: "sleep" | "end";
	capabilities: readonly ("questions" | "details" | "work" | "scopes" | "transcripts" | "commands" | "conversations")[];
	batch(update: () => void): void;
	publish(id: string, view: UiView | undefined, actions?: Record<string, (value: UiValue) => unknown | Promise<unknown>>): void;
	open(id: string, section?: string): void;
	request(interaction: UiInteraction, options?: { signal?: AbortSignal; timeout?: number }): Promise<UiAnswer | null>;
	createScope?(id: string, label: string): PresentationScope;
	registerTranscript?(source: UiTranscriptSource): UiTranscriptHandle;
	/** Session-local owners save and restore their scopes; no queued payloads leave the owner. */
	registerMaintenance?(owner: UiMaintenance): UiTranscriptHandle;
	/** Execute a registered extension command through its normal interactive SDK path. */
	runCommand?(name: string, args?: string): Promise<void>;
	/** Loaded resource metadata from this session, when its owner exposes a native loader. */
	resources?(): UiResource[];
}
export interface UiMaintenance {
	scopes(): readonly string[];
	inspect(): void;
	hold(id: string): Promise<void>;
	restore(id: string): Promise<void>;
	release(id: string): Promise<void>;
}
/** Read-only native history and events; these callbacks never leave the host. */
export interface UiTranscriptSource {
	cwd(): string;
	branch(): readonly SessionEntry[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}
export interface UiTranscriptHandle { id: string; close(): void }
export interface PresentationScope extends Presentation {
	readonly ui: ExtensionUIContext;
	install(pi: ExtensionAPI): void;
	cancelInteractions(): void;
	close(): void;
}

export const PRESENTATION_DISCOVER = "pi-ui/discover-v2";

export function getPresentation(pi: ExtensionAPI): Presentation | undefined {
	const probe: { presentation?: Presentation } = {};
	pi.events.emit(PRESENTATION_DISCOVER, probe);
	return probe.presentation;
}

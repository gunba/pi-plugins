import type { AgentSessionEvent, ExtensionAPI, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Host-neutral presentations. Domain state and action implementations stay in extensions. */
export type UiValue = null | boolean | number | string | UiValue[] | { [key: string]: UiValue | undefined };
export interface UiAction { id: string; label: string; destructive?: boolean }
export type UiDetails = {
	summary?: string;
	links?: { label: string; url: string }[];
	transcript?: string;
	fields?: { label: string; value: string }[];
	items?: { id: string; title: string; subtitle?: string; body?: string; status?: string;
		meter?: { value: number; max: number; label: string };
		actions?: { id: string; label: string; destructive?: boolean }[] }[];
};
export interface UiView {
	kind: string;
	title: string;
	surface?: "work" | "settings";
	data: UiValue;
	/** Compact, factual values owned by this view. Hosts may show them beside the conversation. */
	badges?: { label: string; value: string; description?: string; compact?: boolean }[];
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
export interface Presentation {
	version: 1;
	capabilities: readonly ("questions" | "details" | "work" | "scopes" | "transcripts" | "commands")[];
	publish(id: string, view: UiView | undefined, actions?: Record<string, (value: UiValue) => unknown | Promise<unknown>>): void;
	open(id: string, section?: string): void;
	request(interaction: UiInteraction, options?: { signal?: AbortSignal; timeout?: number }): Promise<UiAnswer | null>;
	createScope?(id: string, label: string): PresentationScope;
	registerTranscript?(source: UiTranscriptSource): UiTranscriptHandle;
	/** Execute a registered extension command through its normal interactive SDK path. */
	runCommand?(name: string, args?: string): Promise<void>;
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

export const PRESENTATION_DISCOVER = "pi-ui/discover-v1";

export function getPresentation(pi: ExtensionAPI): Presentation | undefined {
	const probe: { presentation?: Presentation } = {};
	pi.events.emit(PRESENTATION_DISCOVER, probe);
	return probe.presentation;
}

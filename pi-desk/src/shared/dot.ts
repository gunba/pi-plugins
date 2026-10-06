export const DOT_FILE_BYTES = 20 * 1024 * 1024;
export const DOT_FILE_COUNT = 8;

export interface DotAttachment {
	id: string; name: string; kind: string; mime?: string; size?: number; downloadable: boolean;
}
export interface DotMessage {
	id: string; author: "dot" | "owner" | "other"; name?: string; text: string; created: string;
	attachments: DotAttachment[];
}
export interface DotInput {
	id: string; dot: string; connection?: string; text: string; files?: string[]; remoteFiles?: string[]; created: string;
	state: "sending" | "accepted" | "not-sent" | "unknown";
	requestId?: string; messageId?: string; error?: string;
}
export interface DotUpload {
	id: string; dot: string; connection?: string; name: string; mime: string; size: number; received: number;
	state: "staging" | "ready" | "uploading" | "uploaded" | "unknown" | "failed" | "handed-off";
	remoteId?: string; error?: string;
}
export type DotSurfaceMode = "conversation" | "activity" | "settings" | "computer";
export interface DotDownload { id: string; name: string; mime: string; size: number }
export interface DotSurfaceFrame {
	id: string; dot: string; mode: DotSurfaceMode; sequence: number; width: number; height: number;
	image?: string; error?: string; downloads?: DotDownload[]; fileChooser?: { multiple: boolean; accept: string };
}
export type DotSurfaceInput =
	| { kind: "pointer"; phase: "down" | "move" | "up"; x: number; y: number; button: "left" | "right"; count: 1 | 2; modifiers: number }
	| { kind: "click"; x: number; y: number; button: "left" | "right"; count: number }
	| { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: "key"; key: string; code: string; modifiers: number }
	| { kind: "text"; text: string };
export interface DotSnapshot {
	transport?: "direct"; account?: string; accountName?: string; identity?: string; connection?: string; live?: boolean; avatarError?: string;
	state: "disconnected" | "connecting" | "ready" | "unavailable";
	busy?: boolean;
	id?: string; name?: string; avatar?: string; writing?: boolean; paused?: boolean; error?: string;
	messages: DotMessage[]; before?: string; inputs: DotInput[]; uploads?: DotUpload[];
}

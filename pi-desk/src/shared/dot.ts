export interface DotMessage {
	id: string; author: "dot" | "owner" | "other"; name?: string; text: string; created: string;
	attachments: string[];
}
export interface DotInput {
	id: string; dot: string; text: string; created: string;
	state: "sending" | "accepted" | "not-sent" | "unknown";
	requestId?: string; messageId?: string; error?: string;
}
export interface DotSnapshot {
	state: "disconnected" | "connecting" | "ready" | "unavailable";
	id?: string; name?: string; paused?: boolean; error?: string;
	messages: DotMessage[]; before?: string; inputs: DotInput[];
}

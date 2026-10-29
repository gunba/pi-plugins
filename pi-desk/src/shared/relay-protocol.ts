import type { HostEvent } from "./protocol.ts";
import type { SessionChange, StateChanges } from "./session-patch.ts";
import type { ReleaseInfo } from "./release.ts";
export interface ApiRequest { method: "GET" | "POST"; path: string; body?: Record<string, unknown> }
export interface ApiResponse { status: number; body: unknown; asset?: { mimeType: string; base64: string } }
export type RemotePayload =
	/**
	 * features: "session-patch", the browser applies a conversation's changes alone (session-patch.ts);
	 * "session-patch-2", it also takes compact changes and the workspace state as changes.
	 */
	| { type: "hello"; api: number; features?: string[] }
	/**
	 * `direct`: the host's loopback port, which a browser on the same computer can use instead of the relay.
	 * `ping`: the host answers pings, which browsers use to show the connection's round-trip time.
	 */
	| { type: "ready"; release: ReleaseInfo; direct?: { port: number; platform: string }; ping?: true }
	| { type: "ping"; id: number }
	| { type: "pong"; id: number }
	| { type: "authorize"; credential: string }
	| { type: "upgrade-required"; api: number }
	| { type: "request"; id: string; request: ApiRequest }
	| { type: "response"; id: string; response: ApiResponse }
	| { type: "event"; sequence: number; event: HostEvent | SessionPatchEvent | StatePatchEvent }
	| { type: "events_ack"; sequence: number };

export function relayOrigin(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an origin without credentials or a path.");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
		throw new Error("Remote app and relay origins require HTTPS.");
	}
	return url.origin;
}
export function remoteOrigins(origin: string, appOrigin: string): { origin: string; appOrigin: string } {
	const result = { origin: relayOrigin(origin), appOrigin: relayOrigin(appOrigin) };
	if (result.origin === result.appOrigin) throw new Error("The browser app and relay must have separate origins.");
	return result;
}
export function socketUrl(origin: string, path: string, host: string): string {
	const url = new URL(path, relayOrigin(origin));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("host", host);
	return url.href;
}

/** A conversation's changes since the last time this browser was sent it, in place of its whole entry. */
export type SessionPatchEvent = { type: "session_patch"; key: string; changes: SessionChange[] };
/** The workspace state's changes since this browser was last sent it (session-patch.ts stateChanges). */
export type StatePatchEvent = { type: "state_patch"; changes: StateChanges };

import type { HostEvent } from "./protocol.ts";
import type { ReleaseInfo } from "./release.ts";
export interface ApiRequest { method: "GET" | "POST"; path: string; body?: Record<string, unknown> }
export interface ApiResponse { status: number; body: unknown; asset?: { mimeType: string; base64: string } }
export type RemotePayload =
	| { type: "hello"; api: number }
	| { type: "ready"; release: ReleaseInfo }
	| { type: "authorize"; credential: string }
	| { type: "upgrade-required"; api: number }
	| { type: "request"; id: string; request: ApiRequest }
	| { type: "response"; id: string; response: ApiResponse }
	| { type: "event"; sequence: number; event: HostEvent }
	| { type: "events_ack"; sequence: number };
export interface RemoteInvitation { host: string; device: string; key: string }

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

import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readState } from "../../manage/store.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import { API_HEADER, RELEASE, apiMatches, upgradeMessage } from "../shared/release.ts";
import type { AccessStore } from "./access.ts";
import type { UpdateCheckpoints } from "./checkpoints.ts";
import { object, string } from "./commands.ts";
import type { HostControl, HostStatus } from "./host-control.ts";
import type { HostCore } from "./host-core.ts";
import type { HostEvents } from "./host-events.ts";
import { SANDBOX_PAGE, securityHeaders, serveClient } from "./static.ts";

const json = (response: ServerResponse, code: number, value: unknown) => {
	response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
};
const cookie = (request: IncomingMessage) => /(?:^|;\s*)pi_desk=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "";

interface HttpHost {
	access(): AccessStore;
	control(): HostControl | undefined;
	status(): HostStatus;
	checkpoints(): UpdateCheckpoints | undefined;
	runtime(): string | undefined;
	runtimeHome(): string | undefined;
	/** Host-owned work an update must not cut off. */
	dotBusy(): boolean;
	signingIn(): boolean;
	/** Stop admitting work, then close the host; `preserveWorkers` leaves the conversations running for its replacement. */
	stop(preserveWorkers: boolean): void;
	reconnectAccount(): void;
	events: HostEvents;
	api(device: string, request: ApiRequest): Promise<ApiResponse>;
	/** A conversation's file or shell call for another computer, from its worker: operator only, streamed. */
	hands(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/**
 * The host's local HTTP server: the authenticated process controls the CLI and updater use (/api/host/…), and
 * browsers on this computer: pairing, the event stream, the API and the app's files.
 */
export class HostHttp {
	private readonly core: HostCore;
	private readonly host: HttpHost;
	private attemptWindow = new Map<string, { count: number; until: number }>();
	private clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
	constructor(core: HostCore, host: HttpHost) { this.core = core; this.host = host; }

	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		securityHeaders(response);
		try {
			const allowedHosts = [new URL(this.core.origin).host];
			if (!request.headers.host || !allowedHosts.includes(request.headers.host)) { json(response, 403, { error: "Unrecognized host." }); return; }
			const url = new URL(request.url ?? "/", this.core.origin), access = this.host.access();
			const operator = access.isOperator((request.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (request.headers.origin && !this.allowedOrigin(request.headers.origin)) {
				json(response, 403, { error: "Unrecognized request origin." }); return;
			}
			// Process controls are local-only and use a per-incarnation credential,
			// never the persistent operator/device credentials or relay routing.
			if (url.pathname.startsWith("/api/host/")) { await this.control(url, request, response); return; }
			if (this.core.closing) {
				response.setHeader("Connection", "close");
				json(response, 503, { error: "Pi Desk is shutting down. Reconnect after it restarts." }); return;
			}
			if (request.method !== "GET" && !operator && !this.allowedOrigin(request.headers.origin)) {
				json(response, 403, { error: "Unrecognized request origin." }); return;
			}
			if (url.pathname === "/desk-account.json" && request.method === "GET") { json(response, 200, { kind: "local", ...RELEASE }); return; }
			const clientApi = request.headers[API_HEADER.toLowerCase()] ?? (url.pathname === "/api/events" ? url.searchParams.get("api") : undefined);
			if (url.pathname.startsWith("/api/") && !apiMatches(clientApi)) {
				json(response, 426, { error: upgradeMessage("This browser/client", clientApi), release: RELEASE });
				return;
			}
			if (url.pathname === "/api/pair" && request.method === "POST") {
				const ip = request.socket.remoteAddress ?? "unknown";
				const attempts = this.attemptWindow.get(ip);
				const next = !attempts || attempts.until < Date.now() ? { count: 1, until: Date.now() + 60_000 }
					: { ...attempts, count: attempts.count + 1 };
				this.attemptWindow.set(ip, next);
				if (next.count > 12) { json(response, 429, { error: "Too many pairing attempts. Try again in a minute." }); return; }
				const data = await this.body(request);
				const paired = access.pair(string(data.token, 200), string(data.label, 100));
				const secure = request.headers.origin?.startsWith("https:") ? "; Secure" : "";
				response.setHeader("Set-Cookie", `pi_desk=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
				json(response, 200, paired.device);
				return;
			}
			const device = operator ? "operator" : access.authenticate(cookie(request));
			if (url.pathname.startsWith("/api/") && !device) { json(response, 401, { error: "Pair this browser to continue." }); return; }
			if (url.pathname === "/api/hands" && request.method === "POST" && device === "operator") { await this.host.hands(request, response); return; }
			if (url.pathname === "/api/events" && request.method === "GET") {
				this.host.events.stream(request, response, device!, () => this.core.state());
				return;
			}
			if (url.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "POST")) {
				const result = await this.host.api(device!, { method: request.method, path: `${url.pathname}${url.search}`,
					...(request.method === "POST" ? { body: await this.body(request) } : {}) });
				if (result.asset) {
					response.writeHead(result.status, { "Content-Type": result.asset.mimeType, "Cache-Control": "no-store", "Content-Disposition": "inline" });
					response.end(Buffer.from(result.asset.base64, "base64"));
				} else json(response, result.status, result.body);
				return;
			}
			if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
				if (url.pathname === SANDBOX_PAGE) securityHeaders(response, url.pathname);
				await serveClient(this.clientDir, url.pathname, response);
				return;
			}
			json(response, 404, { error: "Not found." });
		} catch (error) {
			if (response.headersSent) { response.destroy(); return; }
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Status, update handoff, stop, a local recovery invitation and account reconnection, for the CLI and updater on this computer. */
	private async control(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const control = this.host.control(), checkpoints = this.host.checkpoints();
		if (!control?.authenticate((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
			json(response, 401, { error: "Local host control authentication required." }); return;
		}
		if (url.pathname === "/api/host/status" && request.method === "GET") {
			json(response, 200, this.host.status()); return;
		}
		if (url.pathname === "/api/host/update-checkpoint" && request.method === "GET" && checkpoints) {
			const checkpoint = await checkpoints.wait(string(url.searchParams.get("id"), 128));
			json(response, 200, { instance: control.record.instance, checkpoint }); return;
		}
		if (request.method === "POST") {
			const data = await this.body(request);
			if (data.instance !== control.record.instance) { json(response, 409, { error: "The host changed." }); return; }
			if (url.pathname === "/api/host/cancel-update" && checkpoints) {
				checkpoints.cancel(string(data.checkpoint, 128));
				json(response, 202, { instance: control.record.instance }); return;
			}
			if (["/api/host/prepare-update", "/api/host/stop-for-update"].includes(url.pathname)) {
				if (this.host.dotBusy()) throw Error("Finish the current Dot operation before updating.");
				if (this.host.signingIn()) throw Error("Finish or cancel the sign-in before updating.");
				const target = string(data.target, 64), id = string(data.checkpoint, 128);
				const runtime = this.host.runtime(), home = this.host.runtimeHome();
				const state = home ? readState(home) : undefined;
				if (this.core.closing || this.core.restoringUpdate || !runtime || data.runtime !== runtime || state?.active !== runtime
					|| state.pending !== target || state.autoApply !== target || !checkpoints) {
					json(response, 409, { error: "The host or prepared update changed." }); return;
				}
				if (url.pathname.endsWith("prepare-update")) {
					const checkpoint = checkpoints.prepare(id, runtime, target);
					json(response, 202, { instance: control.record.instance, checkpoint }); return;
				}
				await checkpoints.commit(id, target);
				this.host.stop(true);
				json(response, 202, { instance: control.record.instance }); return;
			}
			if (url.pathname === "/api/host/stop") {
				if (data.runtime !== undefined && data.runtime !== this.host.runtime()) {
					json(response, 409, { error: "The running runtime changed." }); return;
				}
				this.host.stop(false);
				json(response, 202, { instance: control.record.instance });
				return;
			}
			if (url.pathname === "/api/host/invite" && !this.core.closing) {
				if (data.local !== true) { json(response, 400, { error: "Use account sign-in for remote access." }); return; }
				const destination = `${this.core.origin}/#pair=${this.host.access().invite()}`;
				json(response, 200, { instance: control.record.instance, url: destination });
				return;
			}
			if (url.pathname === "/api/host/account" && !this.core.closing) {
				this.host.reconnectAccount();
				json(response, 202, { instance: control.record.instance }); return;
			}
		}
		json(response, 404, { error: "Unknown host control." });
	}

	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Use application/json.");
		const buffers: Buffer[] = [];
		let length = 0;
		for await (const chunk of request) {
			length += Buffer.byteLength(chunk);
			if (length > 1_100_000) throw new Error("Request is too large.");
			buffers.push(Buffer.from(chunk));
		}
		return object(JSON.parse(Buffer.concat(buffers).toString("utf8")));
	}

	private allowedOrigin(origin: string | undefined): boolean {
		return origin === this.core.origin;
	}
}

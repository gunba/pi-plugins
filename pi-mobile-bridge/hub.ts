import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { callSession, json, readBody, secureHeaders } from "./http.ts";
import { APP_JS, PAGE, STYLE } from "./page.ts";
import { listSessions } from "./registry.ts";
import { matchesPhoneToken, phoneToken } from "./token.ts";

export const PHONE_PORT = 8911;

export class PhoneHub {
	private server?: Server;
	private timer?: ReturnType<typeof setInterval>;
	private paired = false;
	private lastPulse = 0;

	get running(): boolean { return !!this.server; }

	private async pulse(): Promise<void> {
		if (!this.paired || !this.server) return;
		this.lastPulse = Date.now();
		await Promise.all(listSessions().map(session =>
			callSession(session.id, "/api/pair", "POST").catch(() => undefined)));
	}

	private async unpair(): Promise<void> {
		this.paired = false;
		await Promise.all(listSessions().map(session =>
			callSession(session.id, "/api/unpair", "POST").catch(() => undefined)));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		secureHeaders(response);
		const url = new URL(request.url || "/", "http://localhost");
		const path = url.pathname;
		if (request.method === "GET" && (path === "/" || path === "/app.js" || path === "/style.css")) {
			const [type, data] = path === "/" ? ["text/html", PAGE] :
				path === "/app.js" ? ["text/javascript", APP_JS] : ["text/css", STYLE];
			response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
			response.end(data); return;
		}
		if (!matchesPhoneToken(request.headers.authorization)) {
			json(response, 401, { error: "Pairing token required" }); return;
		}
		if (request.method === "GET" && path === "/api/sessions") {
			this.paired = true;
			if (Date.now() - this.lastPulse > 4000) await this.pulse();
			json(response, 200, { sessions: listSessions() }); return;
		}
		if ((request.method === "GET" && path === "/api/state") ||
			(request.method === "POST" && (path === "/api/message" || path === "/api/answer"))) {
			const id = url.searchParams.get("session");
			if (!id || !listSessions().some(session => session.id === id)) {
				json(response, 404, { error: "That Pi terminal is no longer running" }); return;
			}
			this.paired = true;
			if (Date.now() - this.lastPulse > 4000) await this.pulse();
			try {
				const body = request.method === "POST" ? await readBody(request) : undefined;
				const result = await callSession(id, path, request.method, body);
				response.writeHead(result.code, { "Content-Type": "application/json; charset=utf-8" });
				response.end(result.body);
			} catch (error) {
				json(response, error instanceof Error && error.message === "Request too large" ? 413 : 503,
					{ error: "Pi terminal did not respond" });
			}
			return;
		}
		json(response, 404, { error: "Not found" });
	}

	async start(): Promise<boolean> {
		if (this.server) return true;
		phoneToken();
		const next = createServer((request, response) => {
			void this.handle(request, response).catch(error => {
				if (!response.headersSent) json(response, 500, { error: "Phone bridge request failed" });
				else response.end();
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				next.once("error", reject);
				next.listen(PHONE_PORT, "127.0.0.1", resolve);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
			throw error;
		}
		this.server = next;
		this.timer = setInterval(() => { void this.pulse(); }, 5000);
		this.timer.unref();
		return true;
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (!this.server) return;
		await this.unpair();
		const active = this.server;
		this.server = undefined;
		active.closeAllConnections();
		if (active.listening) await new Promise<void>(resolve => active.close(() => resolve()));
	}
}

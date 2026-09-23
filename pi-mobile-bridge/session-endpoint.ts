import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkUi } from "../pi-work-ui/index.ts";
import { type MobileAnswer, type MobileAskRequest } from "./bridge-events.ts";
import { isRecord, json, readBody, secureHeaders } from "./http.ts";
import { endpointPath, ensureRegistryDirectory, newInstanceId, removeSession, saveSession } from "./registry.ts";

type MessageEntry = Extract<ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number], { type: "message" }>;
type AgentMessage = MessageEntry["message"];

function text(message: AgentMessage): string {
	if (message.role === "custom" && !message.display) return "";
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => block.type === "text" ? block.text : block.type === "image" ? "[image]" : "").join("\n");
}

function recentMessages(ctx: ExtensionContext): Array<{ kind: string; label: string; text: string }> {
	const entries = ctx.sessionManager.getBranch().filter((entry): entry is MessageEntry => entry.type === "message");
	return entries.slice(-45).flatMap(entry => {
		const message = entry.message;
		const kind = message.role === "user" ? "user" : message.role === "toolResult" ? "tool" : "assistant";
		const body = text(message);
		if (!body) return [];
		return [{ kind, label: message.role === "toolResult" ? `Tool · ${message.toolName}` :
			message.role === "custom" ? "Notice" : message.role === "user" ? "You" : "Assistant",
		text: body.length > 6000 ? `${body.slice(0, 6000)}\n… [more in the desktop session]` : body }];
	});
}

function validAnswer(value: unknown, ask: MobileAskRequest): value is MobileAnswer {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	if (value.kind === "freeform") return ask.allowFreeform && typeof value.text === "string" &&
		value.text.trim().length > 0 && value.text.length <= 16_000;
	if (value.kind !== "selection" || !Array.isArray(value.selections) ||
		value.selections.length < 1 || (!ask.allowMultiple && value.selections.length !== 1)) return false;
	if (value.comment !== undefined && (!ask.allowComment || typeof value.comment !== "string" || value.comment.length > 4000)) return false;
	const titles = new Set(ask.options.map(option => option.title));
	return value.selections.every(selection => typeof selection === "string" && titles.has(selection)) &&
		new Set(value.selections).size === value.selections.length;
}

export class SessionEndpoint {
	readonly id = newInstanceId();
	private pi: ExtensionAPI;
	private workUi: WorkUi;
	private ctx?: ExtensionContext;
	private server?: Server;
	private heartbeat?: ReturnType<typeof setInterval>;
	private lastPulse = 0;
	private pendingAsk?: MobileAskRequest;
	private live = "";
	private tools = new Map<string, string>();

	constructor(pi: ExtensionAPI, workUi: WorkUi) {
		this.pi = pi;
		this.workUi = workUi;
	}
	get running(): boolean { return !!this.server; }
	setContext(ctx: ExtensionContext): void { this.ctx = ctx; this.publish(); }
	releasePhone(): void { this.unpair(); }

	private publish(): void {
		const ctx = this.ctx;
		if (!ctx || !this.server) return;
		const subagents = this.workUi.snapshot().find(([id]) => id === "subagents")?.[1];
		saveSession({
			id: this.id, sessionId: ctx.sessionManager.getSessionId(),
			name: this.pi.getSessionName() || "Untitled conversation", cwd: ctx.cwd,
			state: this.pendingAsk ? "needs-answer" : ctx.isIdle() ? "idle" : "working",
			...(subagents ? { summary: subagents.status } : {}),
			updatedAt: Date.now(),
		});
	}

	private unpair(fallback = true): void {
		this.lastPulse = 0;
		if (this.pendingAsk) {
			const ask = this.pendingAsk;
			this.pendingAsk = undefined;
			ask.answer(fallback ? undefined : null);
		}
		this.publish();
	}

	acceptAsk(ask: MobileAskRequest): void {
		if (!this.server || !this.ctx || !this.lastPulse ||
			Date.now() - this.lastPulse > 20_000 || this.pendingAsk) return;
		ask.accepted = true;
		this.pendingAsk = ask;
		this.publish();
		try { this.ctx.ui.notify("Question waiting on the phone. /phone-unpair returns it to this terminal.", "info"); }
		catch { /* A stale notification must not fail the pending question. */ }
	}

	closeAsk(id: unknown): void {
		if (this.pendingAsk?.id !== id) return;
		this.pendingAsk = undefined;
		this.publish();
	}

	updateLive(value: string): void { this.live = value.slice(-12_000); }
	clearLive(): void { this.live = ""; }
	startTool(id: string, name: string): void { this.tools.set(id, name); this.publish(); }
	endTool(id: string): void { this.tools.delete(id); this.publish(); }
	settled(): void { this.tools.clear(); this.live = ""; this.publish(); }
	refresh(): void { this.publish(); }

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		secureHeaders(response);
		const path = new URL(request.url || "/", "http://localhost").pathname;
		if (request.method === "POST" && path === "/api/pair") {
			this.lastPulse = Date.now();
			json(response, 200, { paired: true }); return;
		}
		if (request.method === "POST" && path === "/api/unpair") {
			this.unpair(); json(response, 200, { paired: false }); return;
		}
		const ctx = this.ctx;
		if (!ctx) { json(response, 503, { error: "Pi session unavailable" }); return; }
		if (request.method === "GET" && path === "/api/state") {
			const ask = this.pendingAsk;
			json(response, 200, {
				name: this.pi.getSessionName() || "Untitled conversation", cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(), busy: !ctx.isIdle(),
				tools: [...this.tools.values()], work: this.workUi.snapshot().map(([id, section]) => ({
					id, label: section.label, status: section.status, summary: section.summary ?? "",
				})), messages: recentMessages(ctx), live: this.live,
				ask: ask ? { id: ask.id, question: ask.question, context: ask.context,
					options: ask.options, allowMultiple: ask.allowMultiple, allowFreeform: ask.allowFreeform,
					allowComment: ask.allowComment } : null,
			}); return;
		}
		if (request.method === "POST" && path === "/api/message") {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
			if (!isRecord(body) || typeof body.text !== "string" ||
				!body.text.trim() || body.text.length > 16_000) {
				json(response, 400, { error: "Enter a message of at most 16,000 characters" }); return;
			}
			if (ctx.hasPendingMessages()) { json(response, 409, { error: "A message is already queued" }); return; }
			const queued = !ctx.isIdle();
			this.pi.sendUserMessage(body.text, queued ? { deliverAs: "followUp" } : undefined);
			json(response, 200, { queued }); return;
		}
		if (request.method === "POST" && path === "/api/answer") {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
			const ask = this.pendingAsk;
			if (!isRecord(body) || !ask || body.id !== ask.id) {
				json(response, 409, { error: "That question is no longer pending" }); return;
			}
			if (!validAnswer(body.answer, ask)) { json(response, 400, { error: "Invalid answer" }); return; }
			this.pendingAsk = undefined;
			ask.answer(body.answer);
			this.publish();
			json(response, 200, { delivered: true }); return;
		}
		json(response, 404, { error: "Not found" });
	}

	async start(ctx: ExtensionContext): Promise<void> {
		await this.stop();
		this.ctx = ctx;
		ensureRegistryDirectory();
		const server = createServer((request, response) => {
			void this.handle(request, response).catch(error => {
				if (!response.headersSent) json(response,
					error instanceof SyntaxError ? 400 : error instanceof Error && error.message === "Request too large" ? 413 : 500,
					{ error: error instanceof SyntaxError ? "Invalid JSON" :
						error instanceof Error && error.message === "Request too large" ? error.message : "Request failed" });
				else response.end();
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpointPath(this.id), resolve);
			});
			if (process.platform !== "win32") chmodSync(endpointPath(this.id), 0o600);
		} catch (error) {
			server.close();
			this.ctx = undefined;
			throw error;
		}
		this.server = server;
		this.publish();
		this.heartbeat = setInterval(() => {
			if (this.lastPulse && Date.now() - this.lastPulse > 20_000) this.unpair();
			this.publish();
		}, 5000);
		this.heartbeat.unref();
	}

	async stop(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.unpair(false);
		const server = this.server;
		this.server = undefined;
		this.ctx = undefined;
		server?.closeAllConnections();
		if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		removeSession(this.id);
		this.live = "";
		this.tools.clear();
	}
}

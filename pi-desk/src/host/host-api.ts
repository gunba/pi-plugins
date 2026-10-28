import { launchOperation } from "../../manage/operations.ts";
import type { ProviderAuthType } from "../shared/logins.ts";
import type { QuestActor, QuestCommand } from "../shared/quests.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import type { AccessStore } from "./access.ts";
import type { AccountConnection } from "./account-connection.ts";
import type { AgentOperations } from "./agent-operations.ts";
import { mcpServerCommands, workerHasRunningCommands } from "./automatic-updates.ts";
import { object, string } from "./commands.ts";
import type { ConversationSearch } from "./conversation-search.ts";
import type { ConversationMoves } from "./conversation-moves.ts";
import { MAX_DICTATION_BYTES, type Dictation } from "./dictation.ts";
import { ServiceUsage } from "../../../pi-service-usage/index.ts";
import { exaSettings, saveExaKey } from "../../../pi-web-search/extensions/settings.ts";
import type { DotConnector } from "./dot-connector.ts";
import type { DotConnection } from "./dot.ts";
import type { EfficiencyReports } from "./efficiency.ts";
import type { Folders } from "./folders.ts";
import { reply, type HostCore } from "./host-core.ts";
import type { HostEvents } from "./host-events.ts";
import type { HostQuests } from "./host-quests.ts";
import type { HostUpdates } from "./host-updates.ts";
import type { Logins } from "./logins.ts";
import type { Presence } from "./presence.ts";
import type { RemoteAccess } from "./relay-connector.ts";
import { CatalogChanged, type SavedSessionIndex } from "./saved-sessions.ts";
import { sessionRoute } from "./session-routes.ts";
import type { Teleport } from "./teleport.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "./worker-errors.ts";

interface ApiHost {
	access(): AccessStore;
	runtimeHome(): string | undefined;
	logins(): Logins | undefined;
	dot(): DotConnection | undefined;
	connector(): DotConnector;
	dictation(): Dictation | undefined;
	folders(): Folders;
	saved(): SavedSessionIndex;
	teleport(): Teleport | undefined;
	search?(): ConversationSearch | undefined;
	account: AccountConnection;
	agents: AgentOperations;
	moves: ConversationMoves;
	updates: HostUpdates;
	quests: HostQuests;
	efficiency: EfficiencyReports;
	events: HostEvents;
	presence(): Presence | undefined;
}

/**
 * The app's API, for browsers on this computer and through the relay: who may call it while an update holds or
 * restores conversations, and every route apart from the conversations' own (session-routes.ts).
 */
export class HostApi {
	private readonly core: HostCore;
	private readonly host: ApiHost;
	constructor(core: HostCore, host: ApiHost) { this.core = core; this.host = host; }

	async handle(device: string | RemoteAccess, request: ApiRequest): Promise<ApiResponse> {
		try {
			if (typeof device === "string" ? device !== "operator" && !this.host.access().hasDevice(device) : !device.authorized()) {
				return reply({ error: "Device access is no longer authorized." }, 401);
			}
			if (this.core.closing) return reply({ error: "Desk is applying an update or shutting down. Reconnect shortly." }, 503);
			const url = new URL(request.path, this.core.origin);
			const data = request.body ?? {};
			const restorationControl = this.core.restoringUpdate && (/^\/api\/sessions\/[a-f0-9-]+\/close$/.test(url.pathname)
				|| /^\/api\/sessions\/[a-f0-9-]+\/command$/.test(url.pathname) && (data.command as { kind?: string } | undefined)?.kind === "answer");
			if (request.method !== "GET" && (this.core.held || this.core.restoringUpdate && !restorationControl))
				return reply({ error: "Desk is checkpointing or restoring conversations. Wait for the update to finish." }, 503);
			if (url.pathname === "/api/state" && request.method === "GET") return reply(this.core.state());
			if (url.pathname === "/api/conversations/search" && request.method === "POST") {
				const search = this.host.search?.();
				if (!search) return reply({ error: "Conversation search is unavailable on this host." }, 503);
				if (JSON.stringify(data).length > 16_000) throw Error("Conversation search request is too large.");
				const result = await search.request(data, data.server === undefined ? undefined : string(data.server, 200));
				if (typeof device === "string" ? device !== "operator" && !this.host.access().hasDevice(device) : !device.authorized())
					return reply({ error: "Device access is no longer authorized." }, 401);
				return reply(result);
			}
			const response = await this.workspace(url, request, data) ?? await this.dot(url, request, data) ?? await this.computer(url, request, data)
				?? await sessionRoute(this.core, this.host.saved, url, request, data);
			if (response) return response;
			if (typeof device !== "string") return reply({ error: "Not found." }, 404);
			if (url.pathname === "/api/devices" && request.method === "GET") return reply(this.host.access().devices());
			if (url.pathname === "/api/revoke" && request.method === "POST") {
				const id = string(data.id, 100);
				this.host.access().revoke(id);
				this.host.events.end(id);
				return reply({});
			}
			return reply({ error: "Not found." }, 404);
		} catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) },
			error instanceof WorkerConnectionError ? 503 : error instanceof CatalogChanged || error instanceof StaleGeneration || error instanceof ReceiptConflict ? 409 : 400); }
	}

	/** Pi's logins and the workspace's other computers: moving conversations and keeping copies. */
	private async workspace(url: URL, request: ApiRequest, data: Record<string, unknown>): Promise<ApiResponse | undefined> {
		if (url.pathname === "/api/logins" && request.method === "GET") return reply(await this.host.logins()!.snapshot());
		if (url.pathname === "/api/logins/sign-out" && request.method === "POST") return reply(await this.host.logins()!.signOut(string(data.provider, 200)));
		if (url.pathname === "/api/teleport/move" && request.method === "POST")
			return reply({ key: (await this.host.moves.move(string(data.computer, 36), string(data.session, 100), string(data.cwd, 4096))).key });
		if (url.pathname === "/api/teleport/settings" && request.method === "POST") {
			const teleport = this.host.teleport();
			if (!teleport) throw new Error("Conversation copies need your workspace.");
			teleport.configure({ ...(typeof data.hold === "boolean" ? { hold: data.hold } : {}), ...(typeof data.send === "boolean" ? { send: data.send } : {}) });
			this.host.account.network?.reannounce(this.host.agents.computer());
			this.core.refreshParties(); return reply({ ...teleport.settings });
		}
		if (url.pathname === "/api/logins/sign-ins" && request.method === "POST") return reply(this.host.logins()!.start(
			string(data.id, 36), string(data.provider, 200), string(data.type, 10) as ProviderAuthType), 202);
		const signIn = /^\/api\/logins\/sign-ins\/([a-f0-9-]{36})\/(answer|cancel)$/.exec(url.pathname);
		if (signIn && request.method === "POST") {
			if (signIn[2] === "cancel") await this.host.logins()!.cancel(signIn[1]!);
			else this.host.logins()!.answer(signIn[1]!, string(data.prompt, 36), string(data.value, 32_000));
			return reply({});
		}
		return undefined;
	}

	/** The Dot conversation, its files, and the connector that lets the Dot reach agents. */
	private async dot(url: URL, request: ApiRequest, data: Record<string, unknown>): Promise<ApiResponse | undefined> {
		if (url.pathname === "/api/dot/connector") {
			const connector = this.host.connector();
			const view = () => ({ enabled: connector.enabled, url: connector.enabled ? this.host.account.connectorUrl() : undefined, relay: this.host.account.status?.state ?? "offline",
				approvals: connector.enabled ? connector.approvals() : [], connections: connector.connections() });
			if (request.method === "GET") return reply(view());
			if (request.method === "POST") {
				if (typeof data.approve === "string" || typeof data.deny === "string") connector.decide(string(data.approve ?? data.deny, 36), typeof data.approve === "string");
				else {
					if (data.enabled === true) connector.enable(); else if (data.enabled === false) connector.disable();
					else throw new Error("Choose enabled true or false.");
					this.host.account.relay?.connectorChanged(); this.core.refreshParties(); this.host.account.network?.flush();
				}
				return reply(view());
			}
		}
		const dot = this.host.dot()!;
		if (url.pathname === "/api/dot" && request.method === "GET") return reply(await dot.view());
		if (url.pathname === "/api/dot/connect" && request.method === "POST") {
			void dot.connect().catch(() => {}); return reply({ accepted: true }, 202);
		}
		if (url.pathname === "/api/dot/disconnect" && request.method === "POST") { await dot.disconnect(); return reply({}); }
		if (url.pathname === "/api/dot/history" && request.method === "GET") return reply(await dot.history(string(url.searchParams.get("before"), 1000)));
		if (url.pathname === "/api/dot/inputs" && request.method === "POST") return reply({ input: dot.send(
			string(data.id, 36), string(data.dot, 200), string(data.text, 32_000),
			Array.isArray(data.files) ? data.files.map(file => string(file, 36)) : [], string(data.connection, 64)) }, 202);
		if (url.pathname === "/api/dot/uploads" && request.method === "POST") return reply(dot.stageFile(
			string(data.id, 36), string(data.dot, 200), string(data.name, 200), string(data.mime, 100), Number(data.size), string(data.connection, 64)));
		const dotFile = /^\/api\/dot\/uploads\/([a-f0-9-]{36})(?:\/(discard))?$/.exec(url.pathname);
		if (dotFile && !dotFile[2] && request.method === "POST") return reply(dot.appendFile(dotFile[1]!, Number(data.offset), string(data.data, 400_000)));
		if (dotFile?.[2] && request.method === "POST") { dot.removeFile(dotFile[1]!); return reply({}); }
		if (url.pathname === "/api/dot/downloads" && request.method === "POST") return reply(await dot.download(string(data.message, 500), string(data.attachment, 500)));
		const dotDownload = /^\/api\/dot\/downloads\/([a-f0-9-]{36})(?:\/(release))?$/.exec(url.pathname);
		if (dotDownload) {
			if (!dotDownload[2] && request.method === "GET") return reply(await dot.downloadChunk(dotDownload[1]!, Number(url.searchParams.get("offset"))));
			if (dotDownload[2] === "release" && request.method === "POST") { await dot.releaseDownload(dotDownload[1]!); return reply({}); }
		}
		const dotInput = /^\/api\/dot\/inputs\/([a-f0-9-]{36})(?:\/(cancel))?$/.exec(url.pathname);
		if (dotInput && !dotInput[2] && request.method === "GET") return reply({ input: await dot.input(dotInput[1]!) ?? null });
		if (dotInput?.[2] && request.method === "POST") return reply({ input: dot.cancelInput(
			dotInput[1]!, string(data.dot, 200), string(data.text, 32_000), Array.isArray(data.files) ? data.files.map(file => string(file, 36)) : [], data.connection === undefined ? undefined : string(data.connection, 64)) });
		return undefined;
	}

	/** This computer: storage, updates, dictation, the efficiency report, the quest log, settings and its folders. */
	private async computer(url: URL, request: ApiRequest, data: Record<string, unknown>): Promise<ApiResponse | undefined> {
		const updates = this.host.updates, home = this.host.runtimeHome();
		if (url.pathname === "/api/storage/retry" && request.method === "POST") { this.core.persist(true); return reply({ saved: true }); }
		if (url.pathname === "/api/runtime/update-now" && request.method === "POST") {
			if (this.host.dot()?.busy) throw Error("Finish the current Dot operation before updating.");
			if (this.host.logins()?.signingIn) throw Error("Finish or cancel the sign-in before updating.");
			const version = string(data.version, 40);
			if (!home || !/^\d+\.\d+\.\d+$/.test(version)) return reply({ error: "Select the published update." }, 409);
			await launchOperation(home, "update-now", version);
			updates.refresh();
			return reply({ accepted: true }, 202);
		}
		if (url.pathname === "/api/services" && request.method === "GET") {
			const usage = new ServiceUsage(this.core.options.agentDir);
			try { return reply({ exa: exaSettings(this.core.options.agentDir), usage: usage.snapshot() }); }
			finally { usage.close(); }
		}
		if (url.pathname === "/api/services/exa" && request.method === "POST") {
			if (exaSettings(this.core.options.agentDir).environment) throw new Error("EXA_API_KEY is set in this computer’s environment. Change it there instead.");
			const key = data.key === null ? undefined : string(data.key, 2000).trim();
			if (data.key !== null && !key) throw new Error("Enter an Exa API key.");
			saveExaKey(key, this.core.options.agentDir); return reply(exaSettings(this.core.options.agentDir));
		}
		if (url.pathname === "/api/dictation" && request.method === "POST") {
			const dictation = this.host.dictation();
			if (!dictation?.available) return reply({ error: "Dictation is not set up on this computer." }, 409);
			const audio = Buffer.from(string(data.audio, Math.ceil(MAX_DICTATION_BYTES * 4 / 3) + 4), "base64");
			const language = typeof data.language === "string" && /^[a-z]{2}$/.test(data.language) ? data.language : undefined;
			const seconds = typeof data.seconds === "number" && Number.isFinite(data.seconds) && data.seconds >= 0 && data.seconds <= 600 ? data.seconds : undefined;
			const mime = typeof data.mime === "string" ? data.mime.slice(0, 100) : "audio/webm", result = await dictation.transcribe(audio, mime, language, seconds);
			// Sizes only, never the words: enough to tell a silent or truncated clip from a transcription problem.
			console.error(`Dictation: ${audio.length} bytes of ${mime}${typeof data.peak === "number" ? `, peak level ${data.peak.toFixed(3)}` : ""} → ${result.text.length} characters.`);
			return reply(result);
		}
		if (url.pathname === "/api/efficiency" && request.method === "GET") return reply(this.host.efficiency.read());
		if (url.pathname === "/api/dictation/settings") {
			if (request.method === "GET") return reply(this.host.dictation()!.settings());
			if (request.method === "POST") {
				const value = this.host.dictation()!.configure(data);
				this.core.emit({ type: "state", state: this.core.state() });
				return reply(value);
			}
		}
		const quests = this.host.quests;
		if (url.pathname === "/api/quests" && quests.store) {
			if (request.method === "POST") {
				const command = object(data.command) as unknown as QuestCommand, by: QuestActor = { kind: "you" };
				const quest = quests.store.apply(by, command);
				if (quest) quests.finished(quest, by);
				quests.refresh();
				return reply({ quest: quest ?? null, quests: quests.view });
			}
			return reply(quests.store.view());
		}
		if (url.pathname === "/api/cache-compaction" && request.method === "POST") {
			const threshold = data.threshold === null || data.threshold === undefined ? undefined : Number(data.threshold);
			updates.setCacheCompaction(threshold);
			return reply({ threshold: threshold ?? null });
		}
		if (url.pathname === "/api/runtime/automatic" && request.method === "POST") {
			const next = { host: typeof data.host === "boolean" ? data.host : updates.automatic.host,
				conversations: typeof data.conversations === "boolean" ? data.conversations : updates.automatic.conversations };
			updates.setAutomatic(next);
			return reply({ automatic: next });
		}
		if (url.pathname === "/api/runtime/restart-idle" && request.method === "POST") {
			const only = data.key === undefined ? undefined : string(data.key, 100);
			const outdated = updates.outdated().filter(item => !only || item.managed.view.key === only);
			const title = (item: typeof outdated[number]) => item.managed.view.title ?? item.managed.view.name ?? "";
			const skipped = outdated.filter(item => item.blockers.length).map(item => ({ title: title(item), reason: item.blockers.join(", ") }));
			let restarting = 0;
			// The same check the restart makes, so the reply says what will actually happen.
			for (const item of outdated.filter(item => !item.blockers.length)) {
				if (item.managed.worker?.pid && !await workerHasRunningCommands(item.managed.worker.pid, mcpServerCommands(this.core.options.agentDir, item.managed.view.cwd))) restarting++;
				else skipped.push({ title: title(item), reason: "a command it started is still running" });
			}
			void updates.maintain(true, only);
			return reply({ restarting, skipped }, 202);
		}
		if (url.pathname === "/api/runtime/check" && request.method === "POST") {
			if (!home) return reply({ error: "This host is not a managed installation." }, 409);
			updates.check();
			return reply({ accepted: true }, 202);
		}
		if (url.pathname === "/api/runtime/apply" && request.method === "POST") {
			if (this.host.dot()?.busy) throw Error("Finish the current Dot operation before updating.");
			if (this.host.logins()?.signingIn) throw Error("Finish or cancel the sign-in before updating.");
			const prepared = string(data.prepared, 64);
			if (!home || !/^[a-f0-9]{64}$/.test(prepared)) return reply({ error: "Select a prepared update." }, 409);
			await launchOperation(home, "apply-now", prepared);
			updates.refresh();
			return reply({ accepted: true }, 202);
		}
		if (url.pathname === "/api/folders/places" && request.method === "GET") return reply(await this.host.folders().places());
		if (url.pathname === "/api/folders/drives" && request.method === "GET") return reply(await this.host.folders().volumes());
		if (url.pathname === "/api/folders" && request.method === "GET") return reply(await this.host.folders().page({
			path: url.searchParams.get("path") ?? undefined, query: url.searchParams.get("query") ?? undefined,
			hidden: url.searchParams.get("hidden") === "1", offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
		}));
		if (url.pathname === "/api/presence" && request.method === "POST") {
			const ago = Number(data.ago);
			if (!Number.isFinite(ago)) throw Error("Invalid presence report.");
			const presence = this.host.presence()!;
			presence.report(string(data.window, 100), ago, string(data.device, 60));
			return reply({ present: presence.present });
		}
		return undefined;
	}
}

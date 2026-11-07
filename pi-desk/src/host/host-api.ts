import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchOperation } from "../../manage/operations.ts";
import type { ProviderAuthType } from "../shared/logins.ts";
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
import { modelCallsView, saveModelCalls } from "../../../pi-model-calls/settings.ts";
import type { Home } from "./home.ts";
import { OpenHere, type OpenHereCommand } from "./open-here.ts";
import type { EfficiencyReports } from "./efficiency.ts";
import type { Folders } from "./folders.ts";
import { reply, type HostCore } from "./host-core.ts";
import type { HostEvents } from "./host-events.ts";
import type { HostUpdates } from "./host-updates.ts";
import type { Logins } from "./logins.ts";
import type { Presence } from "./presence.ts";
import type { RemoteAccess } from "./relay-connector.ts";
import { CatalogChanged, type SavedSessionIndex } from "./saved-sessions.ts";
import { sessionRoute } from "./session-routes.ts";
import type { Teleport } from "./teleport.ts";
import type { WatchService } from "./watches.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "./worker-errors.ts";

interface ApiHost {
	access(): AccessStore;
	runtimeHome(): string | undefined;
	logins(): Logins | undefined;
	home(): Home | undefined;
	dictation(): Dictation | undefined;
	folders(): Folders;
	saved(): SavedSessionIndex;
	teleport(): Teleport | undefined;
	search?(): ConversationSearch | undefined;
	watches?(): WatchService | undefined;
	account: AccountConnection;
	agents: AgentOperations;
	moves: ConversationMoves;
	updates: HostUpdates;
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
	private readonly openHere = new OpenHere();
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
			if (url.pathname === "/api/open-here" && request.method === "POST") {
				// It writes to Downloads and opens apps here, so only a window on this computer may ask: one served by
				// this host, which listens on loopback only, or the account app connected over the loopback port.
				if (typeof device !== "string" && !device.local) return reply({ error: "Only a window on this computer can open files on it." }, 403);
				return reply(await this.openHere.command(object(data.command) as OpenHereCommand));
			}
			if (url.pathname === "/api/conversations/search" && request.method === "POST") {
				const search = this.host.search?.();
				if (!search) return reply({ error: "Conversation search is unavailable on this host." }, 503);
				if (JSON.stringify(data).length > 16_000) throw Error("Conversation search request is too large.");
				const result = await search.request(data, data.server === undefined ? undefined : string(data.server, 200));
				if (typeof device === "string" ? device !== "operator" && !this.host.access().hasDevice(device) : !device.authorized())
					return reply({ error: "Device access is no longer authorized." }, 401);
				return reply(result);
			}
			const response = await this.workspace(url, request, data) ?? await this.home(url, request, data) ?? await this.computer(url, request, data)
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

	private async home(url: URL, request: ApiRequest, data: Record<string, unknown>): Promise<ApiResponse | undefined> {
		if (!url.pathname.startsWith("/api/home")) return undefined;
		if (!!this.host.account.identity && !this.host.teleport()?.settings.hold)
			return reply({ error: "Home runs on the workspace server, the computer that keeps conversation copies." }, 409);
		const home = this.host.home();
		if (!home) return reply({ error: "Home is starting." }, 503);
		if (url.pathname === "/api/home" && request.method === "GET") return reply(home.snapshot(url.searchParams.get("known") ?? undefined));
		if (url.pathname === "/api/home/open" && request.method === "POST") return reply(await home.open());
		if (url.pathname === "/api/home/messages" && request.method === "POST") return reply(await home.message(
			string(data.id, 36), string(data.text, 32_000), Array.isArray(data.attachments) ? data.attachments.map(file => string(file, 36)) : undefined));
		if (url.pathname === "/api/home/page" && request.method === "POST") {
			const saved = home.savePage(string(data.version, 64), string(data.text, 200_000));
			return saved ? reply(saved) : reply({ error: "Home's page changed before your change was saved, so it wasn't. Make it again on the page as it is now." }, 409);
		}
		return undefined;
	}

	/** This computer: storage, updates, dictation, the efficiency report, settings and its folders. */
	private async computer(url: URL, request: ApiRequest, data: Record<string, unknown>): Promise<ApiResponse | undefined> {
		const updates = this.host.updates, home = this.host.runtimeHome();
		if (url.pathname === "/api/storage/retry" && request.method === "POST") { this.core.persist(true); return reply({ saved: true }); }
		if (url.pathname === "/api/watches" && request.method === "GET") return reply(this.host.watches?.()?.list() ?? []);
		const watch = /^\/api\/watches\/([a-f0-9-]{36})\/stop$/.exec(url.pathname);
		if (watch && request.method === "POST") {
			const watches = this.host.watches?.();
			if (!watches) return reply({ error: "Desk isn't running watches on this computer." }, 503);
			watches.stop(watch[1]!);
			return reply({ stopping: true });
		}
		if (url.pathname === "/api/runtime/update-now" && request.method === "POST") {
			if (this.host.logins()?.signingIn) throw Error("Finish or cancel the sign-in before updating.");
			const version = string(data.version, 40);
			if (!home || !/^\d+\.\d+\.\d+$/.test(version)) return reply({ error: "Select the published update." }, 409);
			await launchOperation(home, "update-now", version);
			updates.refresh();
			return reply({ accepted: true }, 202);
		}
		if (url.pathname === "/api/services" && request.method === "GET") {
			const usage = new ServiceUsage(this.core.options.agentDir);
			try { return reply({ exa: exaSettings(this.core.options.agentDir), models: modelCallsView(this.core.options.agentDir), usage: usage.snapshot() }); }
			finally { usage.close(); }
		}
		if (url.pathname === "/api/services/models" && request.method === "GET") {
			const provider = url.searchParams.get("provider");
			return reply(provider ? await this.host.logins()!.providerModels(provider) : await this.host.logins()!.modelProviders());
		}
		if (url.pathname === "/api/services/models" && request.method === "POST") {
			const agentDir = this.core.options.agentDir;
			if (data.remove === true) { saveModelCalls(undefined, agentDir); return reply(modelCallsView(agentDir)); }
			const provider = string(data.provider, 200), model = string(data.model, 300), effort = string(data.effort, 20);
			const choice = (await this.host.logins()!.providerModels(provider)).find(item => item.id === model);
			if (!choice) throw new Error("Choose a model.");
			if (!choice.efforts.includes(effort)) throw new Error("Choose an effort this model supports.");
			const key = data.key === undefined || data.key === "" ? undefined : string(data.key, 2000).trim();
			saveModelCalls({ provider, model, effort, dailyLimit: Number(data.dailyLimit), ...key ? { apiKey: key } : {} }, agentDir);
			return reply(modelCallsView(agentDir));
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
		if (url.pathname === "/api/client-error" && request.method === "POST") {
			recordClientError(join(this.core.options.dataDir ?? join(this.core.options.agentDir, "desk"), "client-errors.log"), data);
			return reply({ recorded: true });
		}
		return undefined;
	}
}

/** Errors that stopped a Desk window, one JSON line each, so a crash on a phone can be read on the computer. */
function recordClientError(path: string, data: Record<string, unknown>): void {
	const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;
	const line = JSON.stringify({ at: new Date().toISOString(), release: text(data.release, 40), device: text(data.device, 300),
		message: text(data.message, 2_000), stack: text(data.stack, 8_000), component: text(data.component, 8_000) });
	try { if (statSync(path).size > 1_000_000) renameSync(path, `${path}.1`); } catch { /* No log yet. */ }
	appendFileSync(path, `${line}\n`);
}


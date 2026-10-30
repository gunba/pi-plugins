import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PartyOperations } from "../../../pi-agents/operations.ts";
import { AccessStore } from "./access.ts";
import { SessionWorker } from "./worker-client.ts";
import { readWorkerRecord, workerDirectory, workerOccupied } from "./worker-registry.ts";
import { sessionDisplay } from "./session-display.ts";
import type { HostState, WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import { PackageUpdates } from "./package-updates.ts";
import { homeFolder } from "./local-path.ts";
import { readSessionHeader, SessionCatalog } from "./session-files.ts";
import { SavedSessionIndex } from "./saved-sessions.ts";
import { WorkerConnectionError } from "./worker-errors.ts";
import { HostControl, removeHostRecord, type HostStatus } from "./host-control.ts";
import { RELEASE } from "../shared/release.ts";
import { InputLedger } from "./inputs.ts";
import { Logins, adoptSavedLogins, retireSavedLogins } from "./logins.ts";
import { SettingsSync } from "./settings-sync.ts";
import { UpdateCheckpoints } from "./checkpoints.ts";
import { liveSupervisor } from "./login-supervisor.ts";
import { Presence } from "./presence.ts";
import { AwayNotices } from "./away-notices.ts";
import type { UpdateCheckpoint } from "../shared/checkpoint.ts";
import { Attachments } from "./attachments.ts";
import { assertRuntimeHost, selectedRuntime } from "../../manage/installation.ts";
import { isOpenSession } from "../shared/workspace.ts";
import { SLEEP_AFTER_MS, asleep, atRest, hasNews, waiting } from "./sleep.ts";
import { Folders } from "./folders.ts";
import { Parties } from "./parties.ts";
import { DotConnector } from "./dot-connector.ts";
import { Dictation } from "./dictation.ts";
import { Hands } from "./hands.ts";
import { ConversationSearch } from "./conversation-search.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { Teleport } from "./teleport.ts";
import { DotConnection } from "./dot.ts";
import { AccountConnection } from "./account-connection.ts";
import { AgentOperations, applyModelChoice } from "./agent-operations.ts";
import { ConversationMoves } from "./conversation-moves.ts";
import { EfficiencyReports } from "./efficiency.ts";
import { HostApi } from "./host-api.ts";
import type { HostCore, HostOptions, ManagedSession } from "./host-core.ts";
import { HostEvents } from "./host-events.ts";
import { HostHttp } from "./host-http.ts";
import { HostQuests } from "./host-quests.ts";
import { HostUpdates } from "./host-updates.ts";
import { settle } from "../shared/attention.ts";

/**
 * Desk's host on this computer: its conversations, each run by an independent worker process, their inputs and saved
 * references, and its lifecycle, from startup and reattaching workers after an update to shutdown. Its other parts
 * share these through `core` (host-core.ts).
 */
export class DeskHost {
	private options: HostOptions & { agentDir: string };
	private access: AccessStore;
	private catalog?: SessionCatalog;
	private storageError?: string;
	private saved?: SavedSessionIndex;
	private folders?: Folders;
	private inputs?: InputLedger;
	private dot?: DotConnection;
	private logins?: Logins;
	/** Pi's general setup, mirrored with the workspace's other computers. */
	private settingsSync?: SettingsSync;
	private packageUpdates?: PackageUpdates;
	/** Conversation copies kept away from their computer, and moving conversations between computers (teleport.ts). */
	private teleport?: Teleport;
	private search?: ConversationSearch;
	private readonly hands: Hands;
	/** Settles once earlier Desk logins have moved into Pi's (logins.ts). */
	private adoption?: Promise<unknown>;
	private checkpoints?: UpdateCheckpoints;
	private restoringUpdate = false;
	private restoreUpdateJob?: Promise<void>;
	/** When wakeDue last tried to reopen each conversation, and for which wake. */
	private readonly wakeTried = new Map<string, { wakes: number; at: number }>();
	private parties?: Parties;
	private partyOperations?: PartyOperations;
	private dotConnector?: DotConnector;
	private dictation?: Dictation;
	private catalogTimer?: ReturnType<typeof setTimeout>;
	private sessions = new Map<string, ManagedSession>();
	private startupWaits = new Set<() => void>();
	private hostLease?: SessionLease;
	private heartbeat?: ReturnType<typeof setInterval>;
	private closing = false;
	private closeJob?: Promise<void>;
	private preserveWorkers = false;
	private control?: HostControl;
	private directory = "";
	private runtime?: string;
	private runtimeHome?: string;
	private resolveClosed!: () => void;
	private rejectClosed!: (error: unknown) => void;
	readonly closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
	origin = "";
	private readonly core: HostCore;
	private readonly events = new HostEvents();
	private readonly updates: HostUpdates;
	private readonly account: AccountConnection;
	private readonly moves: ConversationMoves;
	private readonly agents: AgentOperations;
	private readonly quests: HostQuests;
	private readonly efficiency: EfficiencyReports;
	private readonly api: HostApi;
	private presence?: Presence;
	private readonly notices: AwayNotices;
	private readonly http: HostHttp;
	private server = createServer((request, response) => { void this.http.handle(request, response); });

	constructor(options: HostOptions) {
		this.options = { ...options, cwd: realpathSync(options.cwd), agentDir: options.agentDir ?? getAgentDir() };
		// Access data is opened only after acquiring the host lease in start().
		this.access = undefined!;
		void this.closed.catch(() => {});
		const host = this;
		this.core = {
			get options() { return host.options; },
			get directory() { return host.directory; },
			get origin() { return host.origin; },
			get closing() { return host.closing; },
			get restoringUpdate() { return host.restoringUpdate; },
			get held() { return !!host.checkpoints?.held; },
			sessions: this.sessions,
			get inputs() { return host.inputs!; },
			state: () => this.state(),
			emit: event => this.events.emit(event),
			persist: immediate => this.persist(immediate),
			persistEvent: immediate => this.persistEvent(immediate),
			createSession: (cwd, sessionFile, existing, takeover, adopt) => this.createSession(cwd, sessionFile, existing, takeover, adopt),
			waitForSession: (key, timeoutMs) => this.waitForSession(key, timeoutMs),
			replaceWorker: managed => this.replaceWorker(managed),
			inputEvent: managed => this.inputEvent(managed),
			drainInputs: managed => this.drainInputs(managed),
			attachments: key => this.attachments(key),
			refreshParties: () => this.refreshParties(),
		};
		const dotBusy = () => !!this.dot?.busy, signingIn = () => !!this.logins?.signingIn;
		this.updates = new HostUpdates(this.core, { runtime: () => this.runtime, runtimeHome: () => this.runtimeHome, dotBusy, signingIn });
		this.hands = new Hands(this.options.agentDir);
		this.moves = new ConversationMoves(this.core, { teleport: () => this.teleport, parties: () => this.parties, network: () => this.account.network,
			self: () => this.account.identity?.device.id, moving: session => this.partyOperations?.moving(session) });
		this.agents = new AgentOperations(this.core, { parties: () => this.parties!, operations: () => this.partyOperations, network: () => this.account.network,
			teleport: () => this.teleport, search: () => this.search, moves: this.moves });
		this.account = new AccountConnection(this.core, { parties: () => this.parties!, operations: () => this.partyOperations!,
			settingsSync: () => this.settingsSync, teleport: () => this.teleport, search: () => this.search, quests: () => this.quests, hands: () => this.hands, connector: () => this.dotConnector,
			computer: () => this.agents.computer(), execute: (computer, request) => this.agents.execute(computer, request),
			request: (access, request) => this.api.handle(access, request),
			watch: handler => {
				const remove = this.events.addBrowser(handler); handler({ type: "state", state: this.state() });
				return remove;
			} });
		this.quests = new HostQuests({ closing: () => this.closing, changed: () => this.events.emit({ type: "state", state: this.state() }), parties: () => this.parties,
			computer: () => this.account.identity?.device.id });
		this.notices = new AwayNotices({ present: () => !!this.presence?.present, quests: () => this.quests.view, computer: () => this.account.identity?.device.id,
			send: async notice => { await this.account.identity?.notify(notice); } });
		this.events.watch(event => this.notices.observe(event));
		this.efficiency = new EfficiencyReports({ agentDir: this.options.agentDir, sessionDir: this.options.sessionDir, directory: () => this.directory, closing: () => this.closing });
		this.api = new HostApi(this.core, { access: () => this.access, runtimeHome: () => this.runtimeHome, logins: () => this.logins, dot: () => this.dot,
			connector: () => this.dotConnector!, dictation: () => this.dictation, folders: () => this.folders!, saved: () => this.saved!, teleport: () => this.teleport, search: () => this.search,
			account: this.account, agents: this.agents, moves: this.moves, updates: this.updates, quests: this.quests, efficiency: this.efficiency, events: this.events,
			presence: () => this.presence });
		this.http = new HostHttp(this.core, { access: () => this.access, control: () => this.control, status: () => this.hostStatus(), checkpoints: () => this.checkpoints,
			runtime: () => this.runtime, runtimeHome: () => this.runtimeHome, dotBusy, signingIn,
			stop: preserveWorkers => {
				this.closing = true;
				if (preserveWorkers) this.preserveWorkers = true;
				setImmediate(() => { void this.close().catch(() => {}); });
			},
			reconnectAccount: () => { void this.account.connect().catch(() => {}); },
			events: this.events, api: (device, request) => this.api.handle(device, request), hands: (request, response) => this.hands.serve(request, response) });
	}

	async start(): Promise<{ origin: string; pairingUrl: string }> {
		const directory = this.options.dataDir ?? join(this.options.agentDir, "desk");
		this.directory = directory;
		this.dictation = new Dictation(directory, this.options.agentDir);
		this.updates.load();
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.presence = new Presence(directory, () => this.events.emit({ type: "state", state: this.state() }));
		this.hostLease = new SessionLease(join(directory, "host"));
		try {
			this.runtime = assertRuntimeHost(directory);
			this.runtimeHome = this.runtime ? selectedRuntime()!.home : undefined;
			this.access = new AccessStore(directory);
			this.catalog = new SessionCatalog(directory);
			this.inputs = new InputLedger(directory);
			this.logins = new Logins(this.options.agentDir);
			this.settingsSync = new SettingsSync(this.options.agentDir, homedir(), directory, hostname());
			// Pi's packages kept current here, a version per folder, only for an installed Desk (not tests or development).
			if (process.env.PI_DESK_RUNTIME) { this.packageUpdates = new PackageUpdates({ cwd: this.options.cwd, agentDir: this.options.agentDir, root: join(directory, "packages") }); this.packageUpdates.start(); }
			this.teleport = new Teleport(join(directory, "teleport"), {
				self: () => this.account.identity?.device.id ?? "",
				conversations: () => this.moves.copyable(),
				movedAway: (session, move) => { void this.moves.retire(session, move); },
				release: session => this.moves.release(session),
			});
			this.search = new ConversationSearch({ directory: join(directory, "search"), proxy: this.options.proxy,
				settings: () => this.teleport!.settings, self: () => this.account.identity?.device.id ?? "",
				scanner: () => {
					const secondaryRoot = join(this.options.agentDir, "subagents", "sessions");
					const configured = configuredSessionDirectory(this.options.cwd, this.options.agentDir, this.options.sessionDir);
					// Recovery copies cannot authorize retaining an original after its source deletes it.
					return { roots: [join(this.options.agentDir, "sessions"), secondaryRoot, ...configured ? [configured] : []], secondaryRoot,
						ignoreRoots: [join(directory, "teleport", "copies")], files: [...this.sessions.values()].flatMap(({ view }) => view.snapshot?.file ?? view.file ?? []).sort(), exclude: [] };
				} });
			this.adoption = adoptSavedLogins(directory, this.options.agentDir)
				.then(adopted => { if (adopted.length) console.error(`Moved Desk's ${adopted.join(", ")} login into Pi's logins.`); })
				.catch(error => console.error("Desk's earlier logins could not be moved into Pi's:", error));
			// Dot signs into ChatGPT with Pi's own Codex login.
			this.dot = new DotConnection(directory, { proxy: this.options.proxy, authPath: join(this.options.agentDir, "auth.json") });
			this.dot.start();
			this.saved = new SavedSessionIndex(directory, this.options.cwd, this.options.agentDir, this.options.sessionDir,
				() => [...this.sessions.values()].flatMap(({ view }) => {
					const file = view.snapshot?.file ?? view.file;
					return file ? [dirname(file)] : [];
				}));
			const adoption = new Map<string, string>();
			for (const view of this.catalog.read()) {
				const location = workerDirectory(directory, view.key);
				const record = view.interrupted ? readWorkerRecord(location) : undefined;
				const live = !!record && workerOccupied(location);
				if (live) adoption.set(view.key, record.instance);
				else this.inputs.interrupt(view.key, "No live worker was attached");
				this.sessions.set(view.key, { view: { ...view, activation: live ? view.activation ?? randomUUID() : randomUUID(),
					inputs: this.inputs.pending(view.key) } });
			}
			const restoreTicket = this.recoverUpdateReferences();
			this.restoringUpdate = !!restoreTicket || adoption.size > 0;
			this.checkpoints = new UpdateCheckpoints(this.inputs, () => [...this.sessions.values()].flatMap(managed => managed.worker ? [{
				key: managed.view.key, worker: managed.worker,
			}] : []), () => {
				this.updates.refresh();
				for (const managed of this.sessions.values()) this.drainInputs(managed);
				this.agents.flushLocal();
			});
			this.parties = new Parties(this.options.agentDir, () => { this.refreshParties(); this.quests.refresh(); this.account.network?.flush(); this.agents.flushLocal(); });
			this.partyOperations = new PartyOperations(join(this.options.agentDir, "party"));
			this.partyOperations.startHost(); this.agents.flushLocal();
			this.partyOperations.settled = (request, computer, response) => { if (request.kind === "move" && response.error) void this.moves.failed(request, computer, response.error); };
			this.quests.open(this.options.agentDir);
			this.quests.refresh();
			this.dotConnector = new DotConnector(directory, this.parties.store, hostname());
			this.dotConnector.quests = () => this.quests.log();
			this.dotConnector.notices = { ready: () => !!this.dot?.canNotify, post: text => !!this.dot?.notify(text) };
			this.dotConnector.conversations = { operations: () => this.partyOperations, here: () => this.agents.computer(),
				computers: () => this.account.network?.computers() ?? [], folders: () => [...this.sessions.values()].map(item => item.view.cwd) };
			this.refreshParties();
			this.folders = new Folders({ cwd: this.options.cwd, agentDir: this.options.agentDir, sessionDir: this.options.sessionDir,
				recent: () => [...this.saved!.recentProjects(), ...[...this.sessions.values()].map(({ view }) => ({
					path: view.snapshot?.cwd ?? view.cwd, modified: view.created,
				}))],
				directories: () => [...new Set([...this.sessions.values()].flatMap(({ view }) =>
					view.file ? [dirname(view.file)] : []))],
			});
			this.server.on("upgrade", (request, socket, head) => this.account.upgrade(request, socket as Socket, head));
			await new Promise<void>((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(this.options.port ?? 8910, "127.0.0.1", () => {
					this.server.off("error", reject);
					resolve();
				});
			});
			const address = this.server.address();
			if (!address || typeof address === "string") throw new Error("Cannot determine server address.");
			this.origin = `http://127.0.0.1:${address.port}`;
			this.control = new HostControl(this.origin);
			this.heartbeat = setInterval(() => {
				this.events.heartbeat();
				this.updates.refresh(); this.refreshParties(); this.quests.refresh(); void this.updates.maintain(); void this.retireLogins(); this.wakeDue(); this.sleepIdle();
				try { this.partyOperations?.touchHost(); this.agents.flushLocal(); }
				catch { console.error("Party service presence could not be saved."); }
			}, 20_000);
			this.heartbeat.unref();
			await this.account.start();
			this.control.publish(directory);
			this.updates.start();
			if (!restoreTicket) {
				for (const [key, instance] of adoption) {
					const managed = this.sessions.get(key)!;
					this.createSession(managed.view.cwd, managed.view.file, managed, false, instance);
				}
				this.restoringUpdate = false;
				this.updates.refresh();
			}
			if (restoreTicket) this.restoreUpdateJob = this.restoreUpdatedConversations(restoreTicket).catch(error => {
				console.error("Conversation restoration failed:", error instanceof Error ? error.message : String(error));
			}).finally(() => {
				if (!this.closing && this.inputs?.checkpoint()?.state !== "complete")
					this.inputs?.interrupt(undefined, "Conversation restoration could not complete");
				this.restoringUpdate = false;
				if (!this.closing) {
					this.updates.refresh();
					for (const managed of this.sessions.values()) this.drainInputs(managed);
					this.agents.flushLocal();
				}
			});
			return { origin: this.origin, pairingUrl: `${this.origin}/#pair=${this.access.invite()}` };
		} catch (error) {
			clearInterval(this.heartbeat); this.presence?.close(); this.notices.close();
			this.updates.close();
			await this.saved?.close();
			this.checkpoints?.dispose(); await this.checkpoints?.settled();
			this.inputs?.close();
			this.inputs = undefined;
			this.account.close(); await this.search?.close();
			this.dotConnector?.close(); this.quests.close(); this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close();
			await new Promise<void>(resolve => this.server.close(() => resolve()));
			try { if (this.control) removeHostRecord(directory, this.control.record.instance); }
			finally { this.hostLease.close(); }
			throw error;
		}
	}

	private recoverUpdateReferences(): UpdateCheckpoint | undefined {
		const ticket = this.inputs!.checkpoint();
		if (!ticket || !this.runtime || ![ticket.source, ticket.target].includes(this.runtime)
			|| !["held", "committed"].includes(ticket.state)) return;
		if (ticket.state === "held") { ticket.state = "cancelled"; this.inputs!.writeCheckpoint(ticket); return; }
		return ticket;
	}

	private async restoreUpdatedConversations(ticket: UpdateCheckpoint): Promise<void> {
		await Promise.all(ticket.workers.map(async actor => {
			try {
				const existing = this.sessions.get(actor.key);
				if (!existing || !isOpenSession(existing.view) || existing.worker)
					throw new Error("The saved actor reference was closed or changed; no replacement was started.");
				this.createSession(existing.view.cwd, existing.view.file, existing, false, actor.instance);
				await this.waitForSession(actor.key);
				if (!this.closing) this.inputs!.finishCheckpointActor(ticket.id, actor.key);
			} catch (error) {
				if (!this.closing) this.inputs!.finishCheckpointActor(ticket.id, actor.key, error instanceof Error ? error.message : String(error));
			}
		}));
		if (!this.closing) this.inputs!.completeCheckpoint(ticket.id);
	}

	state(): HostState {
		return { release: RELEASE, operator: this.presence?.view, name: hostname(), platform: process.platform, cwd: this.options.cwd,
			sessions: [...this.sessions.values()].map(item => item.view).filter(isOpenSession),
			parties: this.parties?.snapshot, relay: this.account.status, updates: this.updates.state, storageError: this.storageError, quests: this.quests.view,
			...(this.dictation?.available ? { dictation: true } : {}),
			...(this.updates.cacheCompaction ? { cacheCompaction: this.updates.cacheCompaction } : {}),
			...(this.settingsSync?.last ? { settingsSync: this.settingsSync.last } : {}),
			...(this.teleport ? { teleport: { ...this.teleport.settings, copies: this.moves.keptCopies() } } : {}) };
	}

	private refreshParties(): void {
		if (this.closing || !this.parties) return;
		const ids = [...this.sessions.values()].filter(item => isOpenSession(item.view))
			.flatMap(({ view }) => view.snapshot?.id ?? view.agentId ?? []);
		if (this.parties.refresh(ids)) { this.events.emit({ type: "state", state: this.state() }); this.account.network?.flush(); }
	}

	private hostStatus(): HostStatus {
		const active = [...this.sessions.values()].filter(item => item.worker);
		const ticket = this.inputs?.checkpoint();
		return {
			release: RELEASE, instance: this.control!.record.instance, pid: process.pid, started: this.control!.record.started,
			origin: this.origin, stopping: this.closing, cwd: this.options.cwd, agentDir: this.options.agentDir,
			sessionDir: this.options.sessionDir, relay: this.account.status, runtime: this.runtime,
			supervisor: liveSupervisor(this.directory)?.instance === process.env.PI_DESK_SUPERVISOR ? process.env.PI_DESK_SUPERVISOR : undefined,
			checkpoint: this.checkpoints?.status(),
			restore: ticket && this.runtime && [ticket.source, ticket.target].includes(this.runtime)
				&& ["committed", "complete"].includes(ticket.state)
				? { id: ticket.id, pending: this.restoringUpdate, failures: ticket.workers.filter(actor => actor.error).length } : undefined,
			sessions: { active: active.length,
				working: active.filter(({ view }) => view.state === "starting" || view.snapshot?.activity !== "idle"
					|| view.controls?.some(control => control.state === "running")).length,
				questions: active.reduce((sum, { view }) => sum + (view.ui?.interactions.length ?? 0), 0) },
		};
	}

	private workerEvent(key: string, message: WorkerMessage): void {
		const managed = this.sessions.get(key);
		if (!managed || this.closing) return;
		if (message.type === "control") {
			const controls = [...managed.view.controls ?? []].filter(control => control.id !== message.control.id);
			controls.push(message.control);
			managed.view = { ...managed.view, controls: controls.slice(-16) };
			if (message.control.kind === "close" && message.control.state === "completed") {
				this.inputs?.interrupt(key, "The conversation closed");
				managed.worker = undefined;
				// Kept, it sleeps: Desk reopens it when a file its watches write changes.
				const kept = managed.keepOnClose && !managed.replacing, sleeping = kept ? asleep(managed.view.ui) : undefined;
				managed.view = { ...managed.view, state: managed.replacing ? "starting" : "closed", interrupted: false, snapshot: undefined, ui: undefined, historyReady: false, error: undefined,
					kept: managed.keepOnClose || undefined, inputs: this.inputs?.pending(key), asleep: sleeping, waiting: kept ? waiting(managed.view.ui) : undefined,
					...(managed.keepOnClose || managed.replacing ? {} : { wakes: undefined, watching: undefined, watchEvery: undefined }) };
				managed.keepOnClose = undefined;
			}
			this.events.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			if (message.control.kind === "close" && message.control.state === "completed") this.updates.refresh();
			if (message.control.state !== "running") this.drainInputs(managed);
			return;
		}
		if (message.type === "snapshot") {
			if (managed.view.leaf !== message.snapshot.leaf || managed.view.name !== message.snapshot.name
				|| managed.view.file !== message.snapshot.file) this.saved?.invalidate();
			const model = message.snapshot.model;
			managed.view = { ...managed.view, cwd: message.snapshot.cwd, file: message.snapshot.file,
				agentId: message.snapshot.id, name: message.snapshot.name, title: message.snapshot.title, leaf: message.snapshot.leaf, state: "ready", ...sessionDisplay(message.snapshot),
				...(model ? { lastModel: { provider: model.provider, id: model.id, name: model.name, ...(message.snapshot.thinking ? { thinking: message.snapshot.thinking } : {}) } } : {}),
				// The replacement process is up, so a restart onto a new version is over.
				...(managed.view.updating && !managed.replacing ? { updating: undefined } : {}) };
		} else if (message.type === "history_ready") {
			if (managed.view.ui?.generation !== message.generation) return;
			managed.view = { ...managed.view, historyReady: true };
		} else if (message.type === "ui") {
			// Closing tears the presentation down, which announces new generations; that is not a restart.
			if (managed.view.controls?.some(control => control.kind === "close" && control.state === "running")) return;
			const wakes = Math.min(...message.snapshot.views.flatMap(view => view.wakes ? [view.wakes] : []));
			managed.view = { ...managed.view, ui: message.snapshot, wakes: Number.isFinite(wakes) ? wakes : undefined,
				watching: message.snapshot.views.some(view => view.watching) || undefined,
				watchEvery: Math.min(...message.snapshot.views.flatMap(view => view.watching && view.watchEvery ? [view.watchEvery] : [])) || undefined,
			...(managed.view.ui && managed.view.ui.generation !== message.snapshot.generation
				? { state: "starting" as const, snapshot: undefined, historyReady: false } : {}) };
		} else if (message.type === "detached") {
			const instance = managed.worker?.instance;
			const reconnect = instance && managed.initialized && !this.checkpoints?.held && !this.restoringUpdate
				&& !managed.view.controls?.some(control => control.kind === "close" && control.state === "running")
				&& (!managed.reconnectAt || Date.now() - managed.reconnectAt >= 60_000);
			managed.view = { ...managed.view, state: reconnect ? "starting" : "failed", error: reconnect ? undefined : message.error,
				reconnecting: reconnect ? true : undefined, interrupted: !reconnect, snapshot: undefined, ui: undefined, historyReady: false };
			managed.worker = undefined;
			if (reconnect) {
				managed.reconnectAt = Date.now();
				queueMicrotask(() => this.reconnectWorker(managed, instance));
			}
		} else if (message.type === "fatal") {
			this.inputs?.interrupt(key, "The session worker stopped");
			managed.view = { ...managed.view, state: "failed", error: message.error, interrupted: true, snapshot: undefined, ui: undefined, historyReady: false,
				inputs: this.inputs?.pending(key) };
			const worker = managed.worker;
			void worker?.close().catch(() => {}).finally(() => {
				if (managed.worker === worker) managed.worker = undefined;
				this.updates.refresh();
			});
		}
		else {
			// A turn ended, perhaps faster than snapshots are sent; the next snapshot says whether it finished (shared/attention.ts).
			if (message.type === "event" && (message.event as { type?: string }).type === "agent_end") managed.settling = true;
			this.events.emit({ type: "worker", key, message }); return;
		}
		settle(managed);
		this.events.emit({ type: "session", session: managed.view });
		this.persist();
		if (message.type === "snapshot") {
			if (message.snapshot.activity !== "idle") this.updates.active(key);
			this.refreshParties(); this.drainInputs(managed);
		}
	}

	/**
	 * Reopens listed conversations that aren't running when one of their watches is due, such as after the computer
	 * restarted or the user closed one keeping it in the sidebar; the watch then wakes the agent. A conversation that
	 * was watching for something is reopened too when its process was lost rather than closed, so its watches go on,
	 * and a sleeping one when a file its watches write changed (sleep.ts). One that fails to start is tried again every
	 * 15 minutes while it stays listed, and a sleeping one is reopened for its files at most that often.
	 */
	private wakeDue(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) return;
		const now = Date.now();
		for (const managed of this.sessions.values()) {
			const { view } = managed;
			if (managed.worker || !view.file || view.moved || !isOpenSession(view)) continue;
			const sleeping = view.state === "closed" && view.kept === true && !view.interrupted;
			const due = view.wakes && view.wakes <= now ? view.wakes : view.watching && view.interrupted ? 0
				: sleeping && view.asleep && hasNews(view.asleep) ? -1 : undefined;
			const tried = this.wakeTried.get(view.key);
			if (due === undefined || (tried?.wakes === due && tried.at > now - 15 * 60_000)) continue;
			this.wakeTried.set(view.key, { wakes: due, at: now });
			try {
				const key = this.createSession(view.cwd, view.file, managed);
				// Asleep by choice, it goes back to sleep when done; one that stopped unasked stays open as it was.
				const reopened = this.sessions.get(key);
				if (reopened && sleeping) reopened.sleepWhenIdle = true;
			} catch (error) { console.error(`Could not reopen ${view.title ?? view.key} for its watch:`, error instanceof Error ? error.message : String(error)); }
		}
	}

	/**
	 * Closes, kept, a conversation that may sleep once it has been at rest for SLEEP_AFTER_MS: one Desk reopened for a
	 * watch while it slept, or one whose agent asked to close (UiView.close).
	 */
	private sleepIdle(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) return;
		const now = Date.now();
		for (const managed of this.sessions.values()) {
			const { view, worker } = managed;
			const asked = managed.sleepWhenIdle || view.ui?.views.some(item => item.close);
			if (!worker || !asked || !atRest(view, this.inputs?.pending(view.key).length ?? 0)) { managed.idleSince = undefined; continue; }
			managed.idleSince ??= now;
			if (now - managed.idleSince < SLEEP_AFTER_MS) continue;
			managed.idleSince = undefined; managed.sleepWhenIdle = undefined; managed.keepOnClose = true;
			void worker.submitControl({ kind: "close", keep: true }, worker.generation, randomUUID()).catch(error => {
				managed.keepOnClose = undefined;
				console.error(`Could not close ${view.title ?? view.key} to sleep:`, error instanceof Error ? error.message : String(error));
			});
		}
	}

	private reconnectWorker(managed: ManagedSession, instance: string): void {
		const key = managed.view.key;
		if (this.closing || this.sessions.get(key) !== managed || managed.worker || !managed.view.reconnecting) return;
		try {
			// Adoption is bound to this actor. A missing or changed actor must never cold-start here.
			this.createSession(managed.view.cwd, managed.view.file, managed, false, instance);
		} catch (error) {
			managed.view = { ...managed.view, state: "failed", reconnecting: undefined, interrupted: true,
				error: error instanceof Error ? error.message : String(error) };
			this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
		}
	}

	private inputEvent(managed: ManagedSession): void {
		managed.view = { ...managed.view, inputs: this.inputs!.pending(managed.view.key) };
		if (!this.closing) this.events.emit({ type: "session", session: managed.view });
	}

	private attachments(key: string): Attachments {
		let referenced: Set<string> | undefined;
		return new Attachments(this.options.agentDir, key, id => (referenced ??= this.inputs!.files(key)).has(id));
	}

	private async reconcileInputs(managed: ManagedSession): Promise<void> {
		const worker = managed.worker!, key = managed.view.key;
		try {
			for (const input of this.inputs!.pending(key).filter(input => input.state === "sending")) {
				const receipt = await worker.receipt(input.id, true);
				if (this.closing || managed.worker !== worker) return;
				if (receipt.state === "finished") this.inputs!.settle(key, input.id, receipt.result.error ? "failed" : "accepted", receipt.result.error);
				else this.inputs!.settle(key, input.id, "interrupted", "The worker could not confirm this message receipt. It was not resent.");
				this.inputEvent(managed);
			}
		} catch (error) {
			if (!this.closing && managed.worker === worker) console.error("Worker input receipts could not be reconciled:", error instanceof Error ? error.message : String(error));
		} finally {
			managed.reconciling = false;
			if (!this.closing) this.drainInputs(managed);
		}
	}

	private drainInputs(managed: ManagedSession): void {
		if (managed.draining || managed.reconciling || !managed.initialized || this.closing || this.checkpoints?.held || this.restoringUpdate || managed.view.state !== "ready"
			|| !managed.worker || managed.view.controls?.some(control => control.state === "running")) return;
		if (managed.setup) {
			if (!managed.settingUp) managed.settingUp = applyModelChoice(managed, managed.setup)
				.catch(error => console.error(`The chosen model was not applied: ${error instanceof Error ? error.message : String(error)}`))
				.then(() => { managed.setup = undefined; managed.settingUp = undefined; this.drainInputs(managed); });
			return;
		}
		const worker = managed.worker, key = managed.view.key;
		// Admission returns before worker dispatch, leaving queued input cancellable.
		managed.draining = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
			while (!this.closing && !this.checkpoints?.held && !this.restoringUpdate && managed.worker === worker && managed.view.state === "ready"
				&& !managed.view.controls?.some(control => control.state === "running")) {
				const next = this.inputs!.next(key);
				if (!next) break;
				const { input } = next;
				const generation = input.generation ?? managed.initialGeneration;
				if (input.activation !== managed.view.activation || generation !== worker.generation) {
					this.inputs!.settle(key, input.id, "failed", "The session changed before dispatch. This message was not sent.");
					this.inputEvent(managed);
					continue;
				}
				try {
					// Pin files before dispatch: an input handler can observe them before native admission.
					this.attachments(key).retain(input.command.attachments ?? []);
					this.inputs!.settle(key, input.id, "sending");
					this.inputEvent(managed);
					await worker.command({ ...input.command,
						behavior: input.command.behavior ?? (input.generation === undefined ? "steer" : undefined) }, generation, input.id);
					this.inputs!.settle(key, input.id, "accepted");
				} catch (error) {
					if (this.closing && this.preserveWorkers || error instanceof WorkerConnectionError) return;
					this.inputs!.settle(key, input.id, "failed", error instanceof Error ? error.message : String(error));
					this.inputs!.interrupt(key, "An earlier message failed");
				}
				this.inputEvent(managed);
			}
		}).catch(error => {
			// A storage failure must stop delivery, not turn into an unhandled rejection or a retry.
			console.error("Input admission failed:", error instanceof Error ? error.message : String(error));
		}).finally(() => { managed.draining = undefined; });
	}

	private persist(immediate = false): void {
		if (immediate) {
			clearTimeout(this.catalogTimer); this.catalogTimer = undefined;
			try { this.catalog?.write([...this.sessions.values()].map(item => item.view)); }
			catch (error) {
				const message = "Conversation references were not saved. Native histories remain intact; leave Desk running and check storage before restarting. " + (error instanceof Error ? error.message : String(error));
				if (this.storageError !== message) { this.storageError = message; this.events.emit({ type: "state", state: this.state() }); }
				throw error;
			}
			if (this.storageError) { this.storageError = undefined; this.events.emit({ type: "state", state: this.state() }); }
		} else if (!this.catalogTimer) this.catalogTimer = setTimeout(() => {
			try { this.persist(true); }
			catch (error) { console.error("Background catalog publication failed:", error); }
		}, 500);
	}

	private persistEvent(immediate = false): void {
		try { this.persist(immediate); }
		catch (error) { console.error("Catalog publication failed:", error); }
	}

	/**
	 * Wait for a conversation's worker to start. The first start after an update compiles every extension again,
	 * and on Windows Defender scans each new file: the Work PC took over two minutes where it usually takes 20 s.
	 * Desk used to give up at 120 s and close the half-started worker, so those requests always failed.
	 */
	private waitForSession(key: string, timeoutMs = 10 * 60_000): Promise<ManagedSession> {
		return new Promise((resolve, reject) => {
			let finished = false;
			const cancel = () => finish(Error("Desk stopped during agent startup."));
			const finish = (error?: Error, managed?: ManagedSession) => {
				if (finished) return; finished = true;
				clearTimeout(timer); unwatch(); this.startupWaits.delete(cancel);
				error ? reject(error) : resolve(managed!);
			};
			const check = () => {
				const managed = this.sessions.get(key);
				if (!managed || ["closed", "failed"].includes(managed.view.state)) finish(Error(managed?.view.error ?? "The agent stopped during startup."));
				else if (managed.initialized && managed.worker && managed.view.state === "ready") finish(undefined, managed);
			};
			const timer = setTimeout(() => finish(Error("Agent startup timed out. Check its conversation before retrying.")), timeoutMs);
			this.startupWaits.add(cancel); const unwatch = this.events.watch(check);
			if (this.closing) cancel(); else check();
		});
	}

	private waitForControl(key: string, id: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let finished = false;
			const cancel = () => finish(Error("Desk stopped before closure was confirmed."));
			const finish = (error?: Error) => {
				if (finished) return; finished = true;
				clearTimeout(timer); unwatch(); this.startupWaits.delete(cancel);
				error ? reject(error) : resolve();
			};
			const check = () => {
				const status = this.sessions.get(key)?.view.controls?.find(control => control.id === id);
				if (status?.state === "completed") finish();
				else if (status && status.state !== "running") finish(Error(status.error ?? "Closure was not confirmed."));
			};
			const timer = setTimeout(() => finish(Error("Closure timed out. Check the agent before trying again.")), 120_000);
			this.startupWaits.add(cancel); const unwatch = this.events.watch(check);
			if (this.closing) cancel(); else check();
		});
	}

	/** Close an idle conversation's worker and reopen the saved session on this host's current runtime. */
	private async replaceWorker(managed: ManagedSession): Promise<string> {
		const view = managed.view, worker = managed.worker!, snapshot = view.snapshot;
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) throw new Error("Desk is updating or shutting down.");
		if (view.state !== "ready" || !view.file || !snapshot) throw new Error("Only a started, saved conversation can be restarted.");
		if (snapshot.activity === "running" || view.ui?.interactions.length || snapshot.queue.steering.count || snapshot.queue.followUp.count
			|| view.controls?.some(control => control.state === "running")
			|| this.inputs!.pending(view.key).some(input => input.state === "queued" || input.state === "sending"))
			throw new Error("Restart when the conversation is idle, with no questions or waiting messages.");
		const id = randomUUID(), agent = view.agentId ?? snapshot.id;
		// Whether peers can wake it now; releasing the old process clears that.
		const armed = agent ? !!this.parties?.store.member(agent)?.delivery : undefined;
		// One continuous restart: the conversation stays listed and selected, shown as updating, until the new process is up.
		managed.replacing = true;
		managed.view = { ...managed.view, updating: true }; this.events.emit({ type: "session", session: managed.view });
		try {
			await worker.submitControl({ kind: "close" }, worker.generation, id);
			await this.waitForControl(view.key, id);
			await worker.close(true);
		} catch (error) {
			managed.replacing = undefined;
			const message = error instanceof Error ? error.message : String(error);
			managed.view = { ...managed.view, updating: undefined, ...(managed.worker ? {} : { state: "failed" as const, error: message, interrupted: true }) };
			this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
			throw error;
		}
		// The old process has released its registration. Peers see "restarting" rather than offline, and
		// messages wait in its inbox. Refreshes stop once the new process registers under its own owner.
		const owner = agent ? this.parties?.store.restarting(agent, undefined, armed) : undefined;
		if (agent && owner) {
			const until = Date.now() + 120_000;
			const keepAlive = setInterval(() => {
				try { if (Date.now() > until || !this.parties?.store.restarting(agent, owner)) clearInterval(keepAlive); }
				catch { clearInterval(keepAlive); }
			}, 15_000);
			keepAlive.unref();
		}
		try { return this.createSession(view.cwd, view.file, this.sessions.get(view.key)); }
		catch (error) {
			// The old process is gone; show the conversation as failed (Resume restarts it) rather than starting forever.
			const current = this.sessions.get(view.key) ?? managed;
			current.replacing = undefined;
			current.view = { ...current.view, updating: undefined, state: "failed", error: error instanceof Error ? error.message : String(error), interrupted: true };
			this.events.emit({ type: "session", session: current.view }); this.persistEvent(true);
			throw error;
		}
	}

	/** The earlier login store goes once no running conversation still uses the code that read it. */
	private async retireLogins(): Promise<void> {
		const folder = join(this.directory, "provider-accounts");
		if (!this.adoption || !existsSync(folder)) return;
		await this.adoption;
		const older = [...this.sessions.values()].some(({ view }) => view.state !== "closed" && !!view.snapshot && "accounts" in view.snapshot);
		if (!older) retireSavedLogins(this.directory);
	}

	private createSession(cwd: string, sessionFile?: string, existing?: ManagedSession, takeover = false, adopt?: string): string {
		if (this.closing || this.checkpoints?.held) throw new WorkerConnectionError("Desk is applying an update or shutting down. Reconnect before starting Pi.");
		if (sessionFile) {
			sessionFile = realpathSync(sessionFile);
			// A conversation that moved to another computer runs there, never again here.
			const header = readSessionHeader(sessionFile), headerId = header.id ?? "", moved = this.teleport?.movedAway(headerId);
			if (moved) throw new Error(`This conversation moved to ${this.account.network?.computers().find(computer => computer.id === moved.to)?.name ?? "another computer"} on ${new Date(moved.at).toLocaleString()}.`);
			if (this.teleport?.superseded(headerId, sessionFile)) throw new Error("This conversation went to another computer and came back; it continues in the copy that came back.");
			const active = [...this.sessions.values()].find(item => item.worker && item.view.state !== "failed"
				&& (item.view.snapshot?.file ?? item.view.file) === sessionFile);
			if (active) {
				if (adopt && active !== existing) throw new WorkerConnectionError("This native conversation is already attached elsewhere.");
				return active.view.key;
			}
			cwd = header.cwd;
		}
		const key = existing?.view.key ?? randomUUID();
		const options: WorkerInit = { cwd: realpathSync(homeFolder(cwd)), agentDir: this.options.agentDir, sessionFile, sessionDir: this.options.sessionDir, attachmentScope: key, takeover,
			deskDirectory: this.options.dataDir ?? join(this.options.agentDir, "desk"),
			...(existing?.view.leaf !== undefined ? { leaf: existing.view.leaf } : {}) };
		const managed: ManagedSession = { reconnectAt: adopt ? existing?.reconnectAt : undefined, view: { ...existing?.view, key, cwd: options.cwd, file: sessionFile,
			created: existing?.view.created ?? Date.now(), state: "starting", error: undefined, interrupted: false, kept: undefined, asleep: undefined, waiting: undefined,
			reconnecting: adopt ? existing?.view.reconnecting : undefined,
			snapshot: undefined, ui: undefined, historyReady: false, activation: adopt ? existing?.view.activation : randomUUID(), inputs: this.inputs!.pending(key) } };
		this.sessions.set(key, managed);
		this.events.emit({ type: "session", session: managed.view });
		try { this.persist(true); }
		catch (error) {
			if (existing) this.sessions.set(key, existing); else this.sessions.delete(key);
			this.events.emit({ type: "state", state: this.state() });
			throw error;
		}
		let worker: SessionWorker;
		try {
			worker = new SessionWorker(options, message => {
				if (this.sessions.get(key)?.worker === worker) this.workerEvent(key, message);
			}, { directory: this.directory, key, adopt });
		} catch (error) {
			if (existing) this.sessions.set(key, existing); else this.sessions.delete(key);
			this.persistEvent(true); this.events.emit({ type: "state", state: this.state() });
			throw error;
		}
		managed.worker = worker;
		this.updates.refresh();
		void worker.start().then(snapshot => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed"
				|| managed.view.controls?.some(control => control.kind === "close" && control.state === "running")) return;
			managed.view = { ...managed.view, agentId: snapshot.id, ...sessionDisplay(snapshot), state: "ready",
				cwd: snapshot.cwd, file: snapshot.file, name: snapshot.name, title: snapshot.title, leaf: snapshot.leaf,
				workerRuntime: worker.runtime, reconnecting: undefined };
			managed.initialized = true; managed.initialGeneration = worker.initialGeneration ?? snapshot.ui.generation;
			this.saved?.invalidate();
			this.events.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			this.refreshParties();
			managed.reconciling = true;
			void this.reconcileInputs(managed);
		}).catch(error => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed"
				|| managed.view.controls?.some(control => control.kind === "close" && control.state === "running")) return;
			if (!adopt) this.inputs!.interrupt(key, "Session startup failed");
			managed.view = { ...managed.view, state: "failed", reconnecting: undefined, historyReady: false, error: error instanceof Error ? error.message : String(error),
				inputs: this.inputs!.pending(key) };
			this.events.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			void (adopt ? worker.detach() : worker.close()).catch(() => {}).finally(() => { if (managed.worker === worker) managed.worker = undefined; this.updates.refresh(); });
		});
		return key;
	}

	close(): Promise<void> {
		return this.closeJob ??= this.stop().then(this.resolveClosed, error => { this.rejectClosed(error); throw error; });
	}

	private async stop(): Promise<void> {
		this.closing = true;
		this.checkpoints?.dispose();
		for (const cancel of this.startupWaits) cancel();
		const errors: unknown[] = [];
		try { await this.logins?.close(); } catch (error) { errors.push(error); }
		try { await this.dot?.close(); } catch (error) { errors.push(error); }
		try { this.persist(true); } catch (error) { errors.push(error); }
		clearInterval(this.heartbeat); this.packageUpdates?.close(); this.presence?.close(); this.notices.close();
		this.updates.close();
		this.account.close();
		try { await this.search?.close(); } catch (error) { errors.push(error); }
		try { this.dotConnector?.close(); this.quests.close(); this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close(); } catch (error) { errors.push(error); }
		try { await this.saved?.close(); } catch (error) { errors.push(error); }
		this.events.end();
		const workers = await Promise.allSettled([...this.sessions.values()].map(item => this.preserveWorkers ? item.worker?.detach() : item.worker?.close()));
		for (const result of workers) if (result.status === "rejected") errors.push(result.reason);
		await Promise.all([...this.sessions.values()].map(item => item.draining));
		await this.checkpoints?.settled(); await this.restoreUpdateJob;
		try {
			if (!this.preserveWorkers) this.inputs?.interrupt(undefined, "The host stopped");
			this.inputs?.close();
		} catch (error) { errors.push(error); }
		const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
		this.server.closeAllConnections();
		await closed;
		try { if (this.control) removeHostRecord(this.directory, this.control.record.instance); }
		catch (error) { errors.push(error); }
		finally { this.hostLease?.close(); }
		if (errors.length) throw new AggregateError(errors, "Host shutdown encountered errors; check the log.");
	}
}

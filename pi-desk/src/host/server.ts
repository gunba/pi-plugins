import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PartyOperations } from "../../../pi-agents/operations.ts";
import { agentId } from "../../../pi-agents/network.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AccessStore } from "./access.ts";
import { SessionWorker } from "./worker-client.ts";
import { readWorkerRecord, workerDirectory, workerOccupied } from "./worker-registry.ts";
import { sessionDisplay } from "./session-display.ts";
import type { HostState, SessionView, WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import { PackageUpdates } from "./package-updates.ts";
import { homeFolder } from "./local-path.ts";
import { readSessionHeader, SessionCatalog } from "./session-files.ts";
import { SavedSessionIndex } from "./saved-sessions.ts";
import { WorkerConnectionError, WorkerUnresponsiveError } from "./worker-errors.ts";
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
import { SLEEP_AFTER_MS, WAITING_SLEEP_AFTER_MS, asleep, atRest, hasNews, keptQuestions, waiting } from "./sleep.ts";
import { validateAnswer } from "./presentation.ts";
import { Folders } from "./folders.ts";
import { Parties } from "./parties.ts";
import { Dictation } from "./dictation.ts";
import { ConversationSearch } from "./conversation-search.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { Teleport } from "./teleport.ts";
import { Home, homeWork } from "./home.ts";
import { AccountConnection } from "./account-connection.ts";
import { AgentOperations, applyModelChoice } from "./agent-operations.ts";
import { ConversationMoves } from "./conversation-moves.ts";
import { EfficiencyReports } from "./efficiency.ts";
import { HostApi } from "./host-api.ts";
import { chooseConversation, sameFile, type HostCore, type HostOptions, type ManagedSession } from "./host-core.ts";
import { HostEvents } from "./host-events.ts";
import { HostHttp } from "./host-http.ts";
import { HostUpdates } from "./host-updates.ts";
import { asksInBackground, settle } from "../shared/attention.ts";
import { WATCHES, WatchService } from "./watches.ts";
import { Pictures } from "./pictures.ts";

/** wakeDue's mark for reopening a conversation to give its agent an answer the user gave while it was closed. */
const ANSWERED = -2;
/** What an agent is told when Desk continues its work after the computer stopped mid-turn. */
const RESUME_NOTE = "Desk restarted after this computer stopped while you were working. Commands, tools and helpers that were running then were stopped and are not run again. Check where your work stands (files, processes, partial results) before carrying on.";

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
	private home?: Home;
	private logins?: Logins;
	/** Pi's general setup, mirrored with the workspace's other computers. */
	private settingsSync?: SettingsSync;
	private packageUpdates?: PackageUpdates;
	/** Conversation copies kept away from their computer, and moving conversations between computers (teleport.ts). */
	private teleport?: Teleport;
	private search?: ConversationSearch;
	/** Settles once earlier Desk logins have moved into Pi's (logins.ts). */
	private adoption?: Promise<unknown>;
	private checkpoints?: UpdateCheckpoints;
	private restoringUpdate = false;
	private restoreUpdateJob?: Promise<void>;
	/** When wakeDue last tried to reopen each conversation, and for which wake. */
	private readonly wakeTried = new Map<string, { wakes: number; at: number }>();
	private parties?: Parties;
	private partyOperations?: PartyOperations;
	/** The computer's watches, which Desk runs for the agents they wake (watches.ts). */
	private watches?: WatchService;
	private pictures?: Pictures;
	private dictation?: Dictation;
	private catalogTimer?: ReturnType<typeof setTimeout>;
	private sessions = new Map<string, ManagedSession>();
	private startupWaits = new Set<() => void>();
	private hostLease?: SessionLease;
	private heartbeat?: ReturnType<typeof setInterval>;
	/** Checks every second that the event loop ran on time. */
	private stalls?: ReturnType<typeof setInterval>;
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
			// Its helper agents run only in its process, so their watches go with it.
			endWatches: (agent, reason) => { for (const id of agent ? [agent, ...this.parties?.store.helpers(agent) ?? []] : []) this.watches?.endAgent(id, reason); },
			answerKept: (managed, id, answer) => this.answerKept(managed, id, answer),
		};
		const signingIn = () => !!this.logins?.signingIn;
		this.updates = new HostUpdates(this.core, { runtime: () => this.runtime, runtimeHome: () => this.runtimeHome, signingIn });
		this.moves = new ConversationMoves(this.core, { teleport: () => this.teleport, parties: () => this.parties, network: () => this.account.network,
			self: () => this.account.identity?.device.id, moving: session => this.partyOperations?.moving(session) });
		this.agents = new AgentOperations(this.core, { parties: () => this.parties!, operations: () => this.partyOperations, network: () => this.account.network,
			teleport: () => this.teleport, search: () => this.search, watches: () => this.watches, moves: this.moves });
		this.account = new AccountConnection(this.core, { parties: () => this.parties!, operations: () => this.partyOperations!,
			settingsSync: () => this.settingsSync, teleport: () => this.teleport, search: () => this.search, watches: () => this.watches,
			computer: () => this.agents.computer(), execute: (computer, request) => this.agents.execute(computer, request),
			request: (access, request) => this.api.handle(access, request),
			watch: handler => {
				const remove = this.events.addBrowser(handler); handler({ type: "state", state: this.state() });
				return remove;
			} });
		this.notices = new AwayNotices({ present: () => !!this.presence?.present, computer: () => this.account.identity?.device.id,
			send: async notice => { await this.account.identity?.notify(notice); } });
		this.events.watch(event => this.notices.observe(event));
		let workSignature = "";
		this.events.watch(event => {
			if (event.type !== "session") return;
			const signature = JSON.stringify(homeWork([...this.sessions.values()].map(item => item.view)));
			if (signature !== workSignature) { workSignature = signature; this.account.network?.flush(); }
		});
		this.efficiency = new EfficiencyReports({ agentDir: this.options.agentDir, sessionDir: this.options.sessionDir, directory: () => this.directory, closing: () => this.closing });
		this.api = new HostApi(this.core, { access: () => this.access, runtimeHome: () => this.runtimeHome, logins: () => this.logins, home: () => this.home,
			dictation: () => this.dictation, folders: () => this.folders!, saved: () => this.saved!, teleport: () => this.teleport, search: () => this.search,
			account: this.account, agents: this.agents, moves: this.moves, updates: this.updates, efficiency: this.efficiency, events: this.events,
			presence: () => this.presence, watches: () => this.watches, pictures: () => this.pictures });
		this.http = new HostHttp(this.core, { access: () => this.access, control: () => this.control, status: () => this.hostStatus(), checkpoints: () => this.checkpoints,
			runtime: () => this.runtime, runtimeHome: () => this.runtimeHome, signingIn,
			stop: preserveWorkers => {
				this.closing = true;
				if (preserveWorkers) this.preserveWorkers = true;
				setImmediate(() => { void this.close().catch(() => {}); });
			},
			reconnectAccount: () => { void this.account.connect().catch(() => {}); },
			events: this.events, api: (device, request) => this.api.handle(device, request) });
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
					inputs: this.inputs.pending(view.key) },
					// Its agent was working when the computer stopped; a turn Desk already continued once is left stopped.
					...(!live && view.working && !view.resumedAt ? { resume: true } : {}) });
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
			this.parties = new Parties(this.options.agentDir, () => { this.refreshParties(); this.account.network?.flush(); this.agents.flushLocal(); });
			this.partyOperations = new PartyOperations(join(this.options.agentDir, "party"));
			this.partyOperations.startHost(); this.agents.flushLocal();
			this.partyOperations.settled = (request, computer, response) => { if (request.kind === "move" && response.error) void this.moves.failed(request, computer, response.error); };
			// Without its watch service, Desk still runs; conversations then run their watches themselves (pi-watch/index.ts).
			try { this.watches = new WatchService(this.watchHost(directory)); this.watches.start(); }
			catch (error) {
				console.error("Desk can't run watches:", error instanceof Error ? error.message : String(error));
				const failed = this.watches; this.watches = undefined; await failed?.close().catch(() => {});
			}
			try { this.pictures = new Pictures(this.core); this.pictures.start(); }
			catch (error) { console.error("Desk can't draw banners:", error instanceof Error ? error.message : String(error)); }
			this.home = new Home(this.core,
				() => this.account.localOnly || !!this.teleport?.settings.hold,
				() => this.account.network?.homeWork() ?? [], async notice => {
					if (!this.account.identity) throw Error("Phone delivery needs the workspace account connection.");
					const result = await this.account.identity.notify(notice) as { sent?: number };
					if (!result.sent) throw Error("The update is saved in Home, but no phone accepted the notification. Enable phone notifications before marking this job verified.");
					return result;
				});
			this.home.startsAlone = () => !!this.teleport?.settings.hold;
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
			// A stall long enough to miss the relay's keep-alive drops every browser's connection; the log says when.
			let ticked = performance.now();
			this.stalls = setInterval(() => {
				const now = performance.now(), late = now - ticked - 1000; ticked = now;
				if (late >= 5000) console.error(`Desk did not respond for ${Math.round(late / 1000)} s: the computer was busy or asleep.`);
			}, 1000);
			this.stalls.unref();
			this.heartbeat = setInterval(() => {
				this.events.heartbeat();
				this.updates.refresh(); this.refreshParties(); void this.updates.maintain(); void this.retireLogins(); this.wakeDue(); this.sleepIdle(); this.watches?.heartbeat();
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
			clearInterval(this.heartbeat); clearInterval(this.stalls); this.presence?.close(); this.notices.close();
			this.updates.close();
			await this.saved?.close();
			this.checkpoints?.dispose(); await this.checkpoints?.settled();
			this.inputs?.close();
			this.inputs = undefined;
			this.account.close(); await this.search?.close();
			this.home?.close(); this.pictures?.close(); await this.watches?.close(); this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close();
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
			parties: this.parties?.snapshot, relay: this.account.status, updates: this.updates.state, storageError: this.storageError,
			...(this.dictation?.available ? { dictation: true } : {}),
			...(this.updates.cacheCompaction ? { cacheCompaction: this.updates.cacheCompaction } : {}),
			...(this.settingsSync?.last ? { settingsSync: this.settingsSync.last } : {}),
			...(this.teleport ? { teleport: { ...this.teleport.settings, copies: this.moves.keptCopies() } } : {}),
			...(this.watches ? { watches: this.watches.list() } : {}) };
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
			const late = managed.replaceAfter?.control === message.control.id && message.control.state !== "running" ? managed.replaceAfter : undefined;
			if (late) {
				managed.replaceAfter = undefined;
				// The close failed, so the conversation goes on in its old process and the restart is over.
				if (message.control.state !== "completed") managed.replacing = undefined;
			}
			const closed = managed.worker;
			if (message.control.kind === "close" && message.control.state === "completed") {
				this.inputs?.interrupt(key, "The conversation closed");
				managed.worker = undefined;
				// Kept, it sleeps: Desk reopens it when a file its watches write changes.
				const kept = managed.keepOnClose && !managed.replacing, sleeping = kept ? asleep(managed.view.ui) : undefined;
				managed.view = { ...managed.view, state: managed.replacing ? "starting" : "closed", interrupted: false, snapshot: undefined, ui: undefined, historyReady: false, error: undefined,
					kept: managed.keepOnClose || undefined, inputs: this.inputs?.pending(key), asleep: sleeping, waiting: kept ? waiting(managed.view.ui) : undefined,
					// Kept or restarting, its questions stay on screen; removed, they end with it.
					questions: kept || managed.replacing ? keptQuestions(managed.view.questions, managed.view.ui, !!managed.initialized) : undefined,
					...(managed.keepOnClose || managed.replacing ? {} : { wakes: undefined, watching: undefined, watchEvery: undefined }) };
				managed.keepOnClose = undefined;
			}
			this.events.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			if (message.control.kind === "close" && message.control.state === "completed") this.updates.refresh();
			if (late && message.control.state === "completed") void this.finishReplacement(managed, late, closed);
			if (message.control.state !== "running") this.drainInputs(managed);
			return;
		}
		if (message.type === "snapshot") {
			if (managed.view.leaf !== message.snapshot.leaf || managed.view.name !== message.snapshot.name
				|| managed.view.file !== message.snapshot.file) this.saved?.invalidate();
			if (managed.view.name !== message.snapshot.name) this.pictures?.changed();
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
			if (!reconnect) console.error(`Could not keep ${managed.view.title ?? key} open: ${message.error}`);
			managed.view = { ...managed.view, state: reconnect ? "starting" : "failed", error: reconnect ? undefined : message.error,
				unresponsive: !reconnect && managed.worker?.failure instanceof WorkerUnresponsiveError || undefined,
				reconnecting: reconnect ? true : undefined, interrupted: !reconnect, snapshot: undefined, ui: undefined, historyReady: false,
				questions: keptQuestions(managed.view.questions, managed.view.ui, !!managed.initialized) };
			managed.worker = undefined;
			if (reconnect) {
				managed.reconnectAt = Date.now();
				queueMicrotask(() => this.reconnectWorker(managed, instance));
			}
		} else if (message.type === "fatal") {
			this.inputs?.interrupt(key, "The session worker stopped");
			console.error(`Could not keep ${managed.view.title ?? key} open: ${message.error}`);
			managed.view = { ...managed.view, state: "failed", error: message.error, interrupted: true, snapshot: undefined, ui: undefined, historyReady: false,
				unresponsive: managed.worker?.failure instanceof WorkerUnresponsiveError || undefined,
				inputs: this.inputs?.pending(key), questions: keptQuestions(managed.view.questions, managed.view.ui, !!managed.initialized) };
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
		if (message.type === "snapshot" && managed.view.resumedAt) {
			if (message.snapshot.activity === "running") managed.resumeRunning = true;
			else if (message.snapshot.activity === "idle" && managed.resumeRunning) { managed.resumeRunning = undefined; managed.view = { ...managed.view, resumedAt: undefined }; }
		}
		this.deliverAnswers(managed);
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
	 * a sleeping one when a file its watches write changed (sleep.ts), and one whose kept question the user answered
	 * (answerKept). One that fails to start is tried again every 15 minutes while it stays listed, and a sleeping one is
	 * reopened for its files at most that often.
	 */
	private wakeDue(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) return;
		const now = Date.now();
		for (const managed of this.sessions.values()) {
			const { view } = managed;
			if (managed.worker || !view.file || view.moved || !isOpenSession(view)) continue;
			const sleeping = view.state === "closed" && view.kept === true && !view.interrupted;
			if (managed.resume) { this.resumeStopped(managed); continue; }
			// Desk runs the watches of conversations whose agents gave them to it, and reopens those itself (watches.ts).
			const desk = this.watches?.has(view.agentId);
			const due = !desk && view.wakes && view.wakes <= now ? view.wakes : !desk && view.watching && view.interrupted ? 0
				: sleeping && view.asleep && hasNews(view.asleep) ? -1 : view.questions?.some(item => item.answer !== undefined) ? ANSWERED : undefined;
			const tried = this.wakeTried.get(view.key);
			if (due === undefined || (tried?.wakes === due && tried.at > now - 15 * 60_000)) continue;
			this.wakeTried.set(view.key, { wakes: due, at: now });
			try {
				const key = this.createSession(view.cwd, view.file, managed);
				// Asleep by choice, it goes back to sleep when done; one that stopped unasked stays open as it was, and so
				// does one the user answered, as for a message from them.
				const reopened = this.sessions.get(key);
				if (reopened && sleeping && due !== ANSWERED) reopened.sleepWhenIdle = true;
			} catch (error) { console.error(`Could not reopen ${view.title ?? view.key} for its watch:`, error instanceof Error ? error.message : String(error)); }
		}
	}

	/**
	 * Reopens a conversation whose agent was working when the computer stopped, and tells the agent to check where its
	 * work stands and carry on. It happens once for a turn: resumedAt stays set until that turn has run to its end.
	 */
	private resumeStopped(managed: ManagedSession): void {
		const { view } = managed;
		managed.resume = undefined;
		managed.view = { ...view, resumedAt: Date.now() };
		this.persistEvent(true);
		try {
			const key = this.createSession(view.cwd, view.file, managed);
			void this.waitForSession(key).then(opened => opened.worker!.command({ kind: "continue", text: RESUME_NOTE }))
				.catch(error => console.error(`Could not continue ${view.title ?? view.key} after the computer stopped:`, error instanceof Error ? error.message : String(error)));
		} catch (error) { console.error(`Could not reopen ${view.title ?? view.key} after the computer stopped:`, error instanceof Error ? error.message : String(error)); }
	}

	/**
	 * Closes, kept, a conversation that may sleep once it has been at rest a while. After SLEEP_AFTER_MS: one Desk reopened
	 * for a watch while it slept, or one whose agent asked to close (UiView.close). After WAITING_SLEEP_AFTER_MS: one
	 * waiting on watches or times Desk runs for it, which reopen it with their news, so it holds no process meanwhile.
	 */
	private sleepIdle(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) return;
		const now = Date.now();
		for (const managed of this.sessions.values()) {
			const { view, worker } = managed;
			const asked = managed.sleepWhenIdle || view.ui?.views.some(item => item.close);
			// Home stays open for the conversation on its page.
			const waits = !view.home && !!(view.watching || view.wakes) && !!this.watches?.has(view.agentId);
			if (!worker || !(asked || waits) || !atRest(view, this.inputs?.pending(view.key).length ?? 0)) { managed.idleSince = undefined; continue; }
			managed.idleSince ??= now;
			if (now - managed.idleSince < (asked ? SLEEP_AFTER_MS : WAITING_SLEEP_AFTER_MS)) continue;
			managed.idleSince = undefined; managed.sleepWhenIdle = undefined; managed.keepOnClose = true;
			void worker.submitControl({ kind: "close", keep: true }, worker.generation, randomUUID()).catch(error => {
				managed.keepOnClose = undefined;
				console.error(`Could not close ${view.title ?? view.key} to sleep:`, error instanceof Error ? error.message : String(error));
			});
		}
	}

	/** What the watch service needs of the host: who is running, reopening conversations, and the other computers. */
	private watchHost(directory: string): ConstructorParameters<typeof WatchService>[0] {
		const conversation = (agent: string) => chooseConversation([...this.sessions.values()].filter(item => item.view.agentId === agent));
		let changed: ReturnType<typeof setTimeout> | undefined;
		return {
			agentDir: this.options.agentDir, sessionDir: this.options.sessionDir, deskDirectory: directory,
			closing: () => this.closing,
			live: agent => { const managed = conversation(agent); return !!managed?.worker && managed.view.state !== "failed"; },
			wake: agent => this.wakeForWatch(conversation(agent), agent),
			hints: agents => {
				for (const agent of agents) {
					const managed = conversation(agent);
					// A running conversation's own view shows its watches.
					if (!managed || managed.worker || !isOpenSession(managed.view)) continue;
					const hints = this.watches?.hints(agent) ?? {};
					const view = { ...managed.view, wakes: hints.wakes, watching: hints.watching, watchEvery: hints.watchEvery,
						waiting: managed.view.kept ? hints.waiting : managed.view.waiting };
					if (JSON.stringify([view.wakes, view.watching, view.watchEvery, view.waiting]) === JSON.stringify([managed.view.wakes, managed.view.watching, managed.view.watchEvery, managed.view.waiting])) continue;
					managed.view = view;
					this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
				}
			},
			member: (computer, agent) => !!this.parties?.store.member(agentId(computer, agent)),
			computers: () => (this.account.network?.computers() ?? []).map(computer => ({ id: computer.id, name: computer.name ?? computer.id, online: computer.online,
				watches: computer.operations.includes(WATCHES), ...(computer.platform ? { platform: computer.platform } : {}) })),
			self: () => this.account.identity?.device.id,
			label: (agent, computer) => {
				if (computer) return this.parties?.store.member(agentId(computer, agent))?.label ?? agent.slice(0, 8);
				const view = conversation(agent)?.view;
				return view?.snapshot?.name ?? view?.name ?? view?.snapshot?.title ?? view?.title ?? this.parties?.store.member(agent)?.label ?? agent.slice(0, 8);
			},
			flush: () => this.account.network?.flush(),
			changed: () => {
				if (changed || this.closing) return;
				changed = setTimeout(() => { changed = undefined; if (!this.closing) this.events.emit({ type: "state", state: this.state() }); }, 250);
				changed.unref?.();
			},
		};
	}

	/**
	 * Reopens a conversation for its watch's news, as wakeDue does for a time: one asleep by choice goes back to sleep
	 * when done. One Desk doesn't list, from Pi in a terminal, opens here. Removed, moved or missing, it is gone.
	 * A helper agent's news waits for the next turn its conversation gives it: only that conversation's process runs it,
	 * and holds its history open, so opening it here would fail.
	 */
	private wakeForWatch(managed: ManagedSession | undefined, agent: string): "waking" | "later" | "gone" {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) return "later";
		const member = this.parties?.store.member(agent);
		if (member?.kind === "child") return "later";
		if (managed) {
			const { view } = managed;
			if (managed.worker) return "waking";
			if (!view.file || view.moved || !isOpenSession(view)) return "gone";
			const sleeping = view.state === "closed" && view.kept === true && !view.interrupted;
			try {
				const key = this.createSession(view.cwd, view.file, managed);
				const reopened = this.sessions.get(key);
				if (reopened && sleeping) reopened.sleepWhenIdle = true;
			} catch (error) { console.error(`Could not reopen ${view.title ?? view.key} for its watch:`, error instanceof Error ? error.message : String(error)); }
			return "waking";
		}
		const file = this.parties?.store.sessionFile(agent)
			?? (member ? SessionManager.findById(member.cwd, agent, configuredSessionDirectory(member.cwd, this.options.agentDir, this.options.sessionDir)) : undefined);
		if (!file) return "gone";
		try {
			const key = this.createSession(member?.cwd ?? this.options.cwd, file);
			const opened = this.sessions.get(key);
			if (opened) opened.sleepWhenIdle = true;
		} catch (error) { console.error("Could not open a conversation for its watch:", error instanceof Error ? error.message : String(error)); }
		return "waking";
	}

	/**
	 * Takes the user's answer to a question Desk keeps for a conversation without a process (SessionView.questions), and
	 * opens the conversation for it; its agent gets the answer once the process asks the question again (deliverAnswers).
	 * False when `id` names no question Desk keeps. Throws when it is answered already, or the answer doesn't fit it.
	 */
	private answerKept(managed: ManagedSession, id: string, answer: unknown): boolean {
		const question = managed.view.questions?.find(item => item.id === id);
		if (!question || managed.view.moved) return false;
		if (question.answer !== undefined) throw new Error("This question has already been answered.");
		const value = validateAnswer(question.form, answer);
		managed.view = { ...managed.view, questions: managed.view.questions!.map(item => item === question ? { ...item, answer: value } : item) };
		this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
		const { view } = managed;
		if (managed.worker) this.deliverAnswers(managed);
		// Otherwise wakeDue tries again.
		else if (!this.closing && !this.checkpoints?.held && !this.restoringUpdate && view.file && isOpenSession(view)) {
			try { this.createSession(view.cwd, view.file, managed); }
			catch (error) { console.error(`Could not reopen ${view.title ?? view.key} for an answer:`, error instanceof Error ? error.message : String(error)); }
		}
		return true;
	}

	/**
	 * Gives the agent the answers the user gave to questions Desk kept for its conversation (SessionView.questions), each
	 * once its process asks the question again under the same key. Kept questions no one answered give way to the
	 * process's own.
	 */
	private deliverAnswers(managed: ManagedSession): void {
		const { worker, view } = managed, ui = view.ui;
		if (!view.questions || !worker || !managed.initialized || view.state !== "ready" || !ui) return;
		const answered = view.questions.filter(item => item.answer !== undefined);
		if (answered.length !== view.questions.length) managed.view = { ...view, questions: answered.length ? answered : undefined };
		for (const item of answered) {
			const key = item.form.key!, asked = ui.interactions?.find(other => other.form.kind === "question" && other.form.key === key);
			if (!asked || managed.answering?.has(key)) continue;
			(managed.answering ??= new Set()).add(key);
			void worker.command({ kind: "answer", id: asked.id, answer: item.answer ?? null }, ui.generation).then(() => {
				const left = managed.view.questions?.filter(other => other.form.key !== key);
				managed.view = { ...managed.view, questions: left?.length ? left : undefined };
				this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
			}, error => console.error(`An answer given while ${view.title ?? view.key} was closed did not reach its agent:`, error instanceof Error ? error.message : String(error)))
				.finally(() => managed.answering?.delete(key));
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

	/** Sends queued messages to Pi in order. They wait while Pi compacts, which refuses messages; the snapshot that ends it drains them. */
	private drainInputs(managed: ManagedSession): void {
		if (managed.draining || managed.reconciling || !managed.initialized || this.closing || this.checkpoints?.held || this.restoringUpdate || managed.view.state !== "ready"
			|| !managed.worker || managed.view.controls?.some(control => control.state === "running") || managed.view.snapshot?.compacting) return;
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
				&& !managed.view.controls?.some(control => control.state === "running") && !managed.view.snapshot?.compacting) {
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
		if (snapshot.activity === "running" || view.ui?.interactions.some(item => !asksInBackground(item.form)) || snapshot.queue.steering.count || snapshot.queue.followUp.count
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
			// Still closing, as when its extensions are slow to stop: the restart finishes when the close does (workerEvent).
			// Without that, the late close would end the conversation as though it had been closed from the sidebar.
			const closing = managed.worker === worker && managed.view.controls?.some(control => control.id === id && control.state === "running");
			if (closing) managed.replaceAfter = { control: id, agent, armed };
			else managed.replacing = undefined;
			const message = error instanceof Error ? error.message : String(error);
			managed.view = { ...managed.view, updating: undefined, ...(managed.worker ? {} : { state: "failed" as const, error: message, interrupted: true }) };
			this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
			if (closing) throw new Error("The conversation is still closing. It restarts once it has closed.");
			throw error;
		}
		return this.reopenReplaced(managed, view, agent, armed);
	}

	/** The second half of a restart, once the old process has stopped: the saved session starts again on this host's runtime. */
	private reopenReplaced(managed: ManagedSession, view: SessionView, agent: string | undefined, armed: boolean | undefined): string {
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

	/** Finishes a restart whose close completed after replaceWorker stopped waiting for it. */
	private async finishReplacement(managed: ManagedSession, late: NonNullable<ManagedSession["replaceAfter"]>, worker?: SessionWorker): Promise<void> {
		const key = managed.view.key;
		const current = () => !this.closing && this.sessions.get(key) === managed && !managed.worker;
		try { await worker?.close(true); }
		catch (error) {
			if (!current()) return;
			managed.replacing = undefined;
			managed.view = { ...managed.view, state: "failed", error: error instanceof Error ? error.message : String(error), interrupted: true };
			this.events.emit({ type: "session", session: managed.view }); this.persistEvent(true);
			return;
		}
		if (!current()) return;
		try { this.reopenReplaced(managed, managed.view, late.agent, late.armed); }
		catch (error) { console.error(`Could not restart ${managed.view.title ?? key} after it closed:`, error instanceof Error ? error.message : String(error)); }
		this.updates.refresh();
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
				&& sameFile(item.view.snapshot?.file ?? item.view.file, sessionFile!));
			if (active) {
				if (adopt && active !== existing) throw new WorkerConnectionError("This native conversation is already attached elsewhere.");
				return active.view.key;
			}
			cwd = header.cwd;
		}
		const key = existing?.view.key ?? randomUUID();
		const options: WorkerInit = { cwd: realpathSync(homeFolder(cwd)), agentDir: this.options.agentDir, sessionFile, sessionDir: this.options.sessionDir, attachmentScope: key, takeover,
			deskDirectory: this.options.dataDir ?? join(this.options.agentDir, "desk"),
			...(existing?.view.home ? { homeDirectory: join(this.directory, "home") } : {}),
			...(existing?.view.leaf !== undefined ? { leaf: existing.view.leaf } : {}) };
		// Adopting the same process carries over a restart waiting for its close to complete.
		const managed: ManagedSession = { reconnectAt: adopt ? existing?.reconnectAt : undefined,
			...(adopt && existing?.replaceAfter ? { replacing: true, replaceAfter: existing.replaceAfter } : {}), view: { ...existing?.view, key, cwd: options.cwd, file: sessionFile,
			created: existing?.view.created ?? Date.now(), state: "starting", error: undefined, unresponsive: undefined, interrupted: false, kept: undefined, asleep: undefined, waiting: undefined,
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
			this.deliverAnswers(managed);
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
			const message = error instanceof Error ? error.message : String(error);
			// A lost connection has already failed it, and said so (workerEvent).
			if (managed.view.state !== "failed") console.error(`Could not open ${managed.view.title ?? key}: ${message}`);
			managed.view = { ...managed.view, state: "failed", reconnecting: undefined, historyReady: false, error: message,
				unresponsive: error instanceof WorkerUnresponsiveError || managed.view.unresponsive, inputs: this.inputs!.pending(key) };
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
		try { this.persist(true); } catch (error) { errors.push(error); }
		clearInterval(this.heartbeat); clearInterval(this.stalls); this.packageUpdates?.close(); this.presence?.close(); this.notices.close();
		this.updates.close();
		this.account.close();
		try { await this.search?.close(); } catch (error) { errors.push(error); }
		try { await this.watches?.close(); } catch (error) { errors.push(error); }
		this.pictures?.close();
		try { this.home?.close(); this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close(); } catch (error) { errors.push(error); }
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

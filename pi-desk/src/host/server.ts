import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { uuid } from "../../../pi-party/network.ts";
import { createPartyFork } from "../../../pi-party/fork.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { SessionLease } from "../../../pi-session-ownership/lease.ts";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { AccessStore } from "./access.ts";
import { commandFrom, workerCommandFrom, object, string } from "./commands.ts";
import { SessionWorker } from "./worker-client.ts";
import { sessionDisplay } from "./session-display.ts";
import type { HostEvent, HostState, SessionView, WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import { RelayConnector, type RelayStatus, type RemoteAccess } from "./relay-connector.ts";
import { readAccount } from "./account-config.ts";
import type { NativeAccountIdentity } from "./account-identity.ts";
import { securityHeaders, serveClient } from "./static.ts";
import { readSessionHeader, SessionCatalog } from "./session-files.ts";
import { SavedSessionIndex, CatalogChanged } from "./saved-sessions.ts";
import { isControl } from "../shared/controls.ts";
import { ReceiptConflict, StaleGeneration, WorkerConnectionError } from "./worker-errors.ts";
import { HostControl, removeHostRecord, type HostStatus } from "./host-control.ts";
import { API_HEADER, RELEASE, apiMatches, upgradeMessage } from "../shared/release.ts";
import { InputLedger } from "./inputs.ts";
import { ProviderAccounts } from "./provider-accounts.ts";
import { UpdateCheckpoints } from "./checkpoints.ts";
import type { UpdateCheckpoint } from "../shared/checkpoint.ts";
import { readState } from "../../manage/store.ts";
import { Attachments } from "./attachments.ts";
import type { InputSubmission } from "../shared/inputs.ts";
import { assertRuntimeHost, selectedRuntime } from "../../manage/installation.ts";
import { automaticUpdatePending, launchOperation, runtimeUpdateState } from "../../manage/operations.ts";
import { checkRuntimeUpdate, readUpdateCheck, updateCheckInterval } from "../../manage/update-check.ts";
import type { RuntimeUpdateState } from "../shared/updates.ts";
import { isOpenSession } from "../shared/workspace.ts";
import { Folders } from "./folders.ts";
import { Parties } from "./parties.ts";
import { PartyNetwork } from "./party-network.ts";
import { workspaceIdentity } from "../shared/account.ts";
import { PartyOperations, type DriverControl } from "../../../pi-party/operations.ts";
import { resumeLease } from "../../../pi-session-ownership/handoff.ts";
import { agentId, type PartyOperation, type OperationResult } from "../../../pi-party/network.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { LEASE_MS } from "../../../pi-party/store.ts";
import { DotConnection } from "./dot.ts";

interface Options { cwd: string; port?: number; dataDir?: string; agentDir?: string; sessionDir?: string; publicOrigin?: string; proxy?: string }
interface ManagedSession { view: SessionView; worker?: SessionWorker; initialized?: boolean; initialGeneration?: string; draining?: Promise<void> }
interface EventClient { response: ServerResponse; device: string }
const json = (response: ServerResponse, code: number, value: unknown) => {
	response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
};
const cookie = (request: IncomingMessage) => /(?:^|;\s*)pi_desk=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "";

export class DeskHost {
	private options: Options;
	private access: AccessStore;
	private catalog?: SessionCatalog;
	private storageError?: string;
	private saved?: SavedSessionIndex;
	private folders?: Folders;
	private inputs?: InputLedger;
	private dot?: DotConnection;
	private providerAccounts?: ProviderAccounts;
	private checkpoints?: UpdateCheckpoints;
	private restoringUpdate = false;
	private restoreUpdateJob?: Promise<void>;
	private parties?: Parties;
	private partyNetwork?: PartyNetwork;
	private partyOperations?: PartyOperations;
	private catalogTimer?: ReturnType<typeof setTimeout>;
	private server = createServer((request, response) => { void this.handle(request, response); });
	private sessions = new Map<string, ManagedSession>();
	private startupWaits = new Set<() => void>();
	private clients = new Set<EventClient>();
	private watchers = new Set<(event: HostEvent) => void>();
	private relay?: RelayConnector;
	private relayStatus?: RelayStatus;
	private accountIdentity?: NativeAccountIdentity;
	private accountRevision = 0;
	private accountRetry?: ReturnType<typeof setTimeout>;
	private sequence = 0;
	private history: { id: number; frame: string }[] = [];
	private historyBytes = 0;
	private hostLease?: SessionLease;
	private heartbeat?: ReturnType<typeof setInterval>;
	private attemptWindow = new Map<string, { count: number; until: number }>();
	private closing = false;
	private closeJob?: Promise<void>;
	private control?: HostControl;
	private directory = "";
	private runtime?: string;
	private runtimeHome?: string;
	private updates?: RuntimeUpdateState;
	private updateWatch?: FSWatcher;
	private updateTimer?: ReturnType<typeof setTimeout>;
	private applyingUpdate = false;
	private updateCheckTimer?: ReturnType<typeof setTimeout>;
	private updateCheckAbort = new AbortController();
	private checkingUpdate = false;
	private lastUpdateCheck = 0;
	private updateCheckError?: string;
	private resolveClosed!: () => void;
	private rejectClosed!: (error: unknown) => void;
	readonly closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
	private clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
	origin = "";

	constructor(options: Options) {
		this.options = { ...options, cwd: realpathSync(options.cwd), agentDir: options.agentDir ?? getAgentDir() };
		// Access data is opened only after acquiring the host lease in start().
		this.access = undefined!;
		void this.closed.catch(() => {});
	}

	async start(): Promise<{ origin: string; pairingUrl: string }> {
		const directory = this.options.dataDir ?? join(this.options.agentDir!, "desk");
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.hostLease = new SessionLease(join(directory, "host"));
		try {
			this.runtime = assertRuntimeHost(directory);
			this.runtimeHome = this.runtime ? selectedRuntime()!.home : undefined;
			this.access = new AccessStore(directory);
			this.catalog = new SessionCatalog(directory);
			this.inputs = new InputLedger(directory);
			this.providerAccounts = new ProviderAccounts(directory, this.options.agentDir!);
			this.dot = new DotConnection(directory, this.options.agentDir!, { proxy: this.options.proxy, account: id => {
				const account = this.providerAccounts!.view().accounts.find(account => account.id === id && account.provider === "openai-codex" && !account.native);
				if (!account) throw Error("Choose a saved ChatGPT sign-in for Dot.");
				return { path: this.providerAccounts!.authPath("openai-codex", id), name: account.name };
			} });
			this.dot.start();
			this.saved = new SavedSessionIndex(directory, this.options.cwd, this.options.agentDir!, this.options.sessionDir,
				() => [...this.sessions.values()].flatMap(({ view }) => {
					const file = view.snapshot?.file ?? view.file;
					return file ? [dirname(file)] : [];
				}));
			for (const view of this.catalog.read()) this.sessions.set(view.key, {
				view: { ...view, activation: randomUUID(), inputs: this.inputs.pending(view.key) },
			});
			const restoreTicket = this.recoverUpdateReferences();
			this.restoringUpdate = !!restoreTicket;
			this.checkpoints = new UpdateCheckpoints(this.inputs, () => [...this.sessions.values()].flatMap(managed => managed.worker ? [{
				key: managed.view.key, worker: managed.worker, ready: !!managed.initialized && managed.view.state === "ready",
				controlBusy: !!managed.view.controls?.some(control => control.state === "running"), draining: managed.draining,
			}] : []), () => {
				this.refreshUpdates();
				for (const managed of this.sessions.values()) this.drainInputs(managed);
				this.flushPartyWakes(); this.flushLocalPartyOperations();
			});
			this.parties = new Parties(this.options.agentDir!, () => { this.refreshParties(); this.partyNetwork?.flush(); this.flushLocalPartyOperations(); this.flushPartyWakes(); });
			this.partyOperations = new PartyOperations(join(this.options.agentDir!, "party"));
			this.partyOperations.startHost(); this.flushLocalPartyOperations(); this.flushPartyWakes();
			this.refreshParties();
			this.folders = new Folders({ cwd: this.options.cwd, agentDir: this.options.agentDir!, sessionDir: this.options.sessionDir,
				recent: () => [...this.saved!.recentProjects(), ...[...this.sessions.values()].map(({ view }) => ({
					path: view.snapshot?.cwd ?? view.cwd, modified: view.created,
				}))],
				directories: () => [...new Set([...this.sessions.values()].flatMap(({ view }) =>
					view.file ? [dirname(view.file)] : []))],
			});
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
				for (const client of this.clients) this.write(client.response, ": heartbeat\n\n");
				this.refreshUpdates(); this.refreshParties();
				try { this.partyOperations?.touchHost(); this.flushLocalPartyOperations(); this.flushPartyWakes(); }
				catch { console.error("Party service presence could not be saved."); }
			}, 20_000);
			this.heartbeat.unref();
			await this.connectAccount();
			this.control.publish(directory);
			if (this.runtimeHome) {
				try {
					this.updateWatch = watch(this.runtimeHome, (_event, name) => {
						if (!["state.json", "operation.json"].includes(String(name))) return;
						clearTimeout(this.updateTimer);
						this.updateTimer = setTimeout(() => this.refreshUpdates(), 50);
					});
					this.updateWatch.on("error", () => { this.updateWatch?.close(); this.updateWatch = undefined; });
				} catch { /* The existing heartbeat also refreshes update state. */ }
				this.refreshUpdates();
				this.scheduleUpdateCheck();
			}
			if (restoreTicket) this.restoreUpdateJob = this.restoreUpdatedConversations(restoreTicket).catch(error => {
				console.error("Conversation restoration failed:", error instanceof Error ? error.message : String(error));
			}).finally(() => {
				if (!this.closing && this.inputs?.checkpoint()?.state !== "complete")
					this.inputs?.interrupt(undefined, "Conversation restoration could not complete");
				this.restoringUpdate = false;
				if (!this.closing) {
					this.refreshUpdates();
					for (const managed of this.sessions.values()) this.drainInputs(managed);
					this.flushPartyWakes(); this.flushLocalPartyOperations();
				}
			});
			return { origin: this.origin, pairingUrl: `${this.origin}/#pair=${this.access.invite()}` };
		} catch (error) {
			clearInterval(this.heartbeat);
			this.updateWatch?.close(); clearTimeout(this.updateTimer);
			clearTimeout(this.updateCheckTimer); this.updateCheckAbort.abort();
			await this.saved?.close();
			this.checkpoints?.dispose(); await this.checkpoints?.settled();
			this.inputs?.close();
			this.inputs = undefined;
			this.relay?.close(); this.partyNetwork?.close(); this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close();
			clearTimeout(this.accountRetry); this.accountRevision++; this.accountIdentity?.close();
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
		for (const actor of ticket.sessions) {
			const managed = this.sessions.get(actor.key);
			if (managed && isOpenSession(managed.view) && managed.view.file === actor.file && managed.view.agentId === actor.session)
				managed.view.leaf = actor.leaf;
		}
		if (ticket.state === "held") { ticket.state = "cancelled"; this.inputs!.writeCheckpoint(ticket); return; }
		return ticket;
	}

	private async restoreUpdatedConversations(ticket: UpdateCheckpoint): Promise<void> {
		const workers: { key: string; worker: SessionWorker }[] = [];
		try {
			await Promise.all(ticket.sessions.map(async actor => {
				try {
					const existing = this.sessions.get(actor.key);
					if (!existing || !isOpenSession(existing.view) || existing.view.file !== actor.file || existing.view.agentId !== actor.session)
						throw new Error("The saved conversation was closed or changed; it was not restarted.");
					if (existing.worker) throw new Error("This conversation is already open; its work was not resent.");
					const key = this.createSession(actor.cwd, actor.file, existing, false, ticket.id);
					if (key !== actor.key) throw new Error("This native session is open in another conversation; its work was not resent.");
					workers.push({ key, worker: this.sessions.get(key)!.worker! });
					const managed = await this.waitForSession(key);
					if (managed.view.snapshot?.id !== actor.session || managed.view.snapshot.file !== actor.file)
						throw new Error("The native conversation changed during restoration.");
					if (actor.running && !actor.dispatched && !actor.error) {
						const digest = createHash("sha256").update(`desk-update:${ticket.id}:${actor.key}`).digest("hex");
						const id = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
						this.inputs!.continueCheckpoint(ticket.id, key, { id, activation: managed.view.activation!,
							generation: managed.worker!.generation, command: { kind: "prompt", text: "Continue" } });
						this.inputEvent(managed);
					} else this.inputs!.finishCheckpointActor(ticket.id, key);
				} catch (error) {
					if (!this.closing) this.inputs!.finishCheckpointActor(ticket.id, actor.key, error instanceof Error ? error.message : String(error));
				}
			}));
			if (!this.closing) this.inputs!.completeCheckpoint(ticket.id);
		} finally {
			await Promise.all(workers.map(async ({ key, worker }) => {
				try { await worker.checkpoint(ticket.id, "release"); }
				catch (error) {
					if (!this.closing) {
						this.inputs!.interrupt(key, "The updated worker could not confirm release");
						this.inputs!.finishCheckpointActor(ticket.id, key, error instanceof Error ? error.message : String(error));
					}
				}
			}));
		}
	}

	state(): HostState {
		return { release: RELEASE, name: hostname(), platform: process.platform, cwd: this.options.cwd,
			sessions: [...this.sessions.values()].map(item => item.view).filter(isOpenSession),
			parties: this.parties?.snapshot, relay: this.relayStatus, updates: this.updates, storageError: this.storageError };
	}

	private refreshParties(): void {
		if (this.closing || !this.parties) return;
		const ids = [...this.sessions.values()].filter(item => isOpenSession(item.view))
			.flatMap(({ view }) => view.snapshot?.id ?? view.agentId ?? []);
		if (this.parties.refresh(ids)) { this.emit({ type: "state", state: this.state() }); this.partyNetwork?.flush(); }
	}

	private refreshUpdates(): void {
		if (!this.runtimeHome || this.closing) return;
		const active = [...this.sessions.values()].filter(item => item.worker).length;
		let next: RuntimeUpdateState | undefined;
		try {
			const value = runtimeUpdateState(this.runtimeHome);
			if (!value) throw new Error("The managed runtime selection is missing.");
			next = { ...value, activeSessions: active, checking: this.checkingUpdate, checkError: this.updateCheckError ?? value.checkError };
			if (this.restoringUpdate) next = { ...next, phase: "applying", message: "Restoring conversations…" };
		}
		catch (error) { next = { current: RELEASE.version, phase: "failed", message: error instanceof Error ? error.message : String(error) }; }
		if (JSON.stringify(next) !== JSON.stringify(this.updates)) {
			this.updates = next;
			this.emit({ type: "state", state: this.state() });
		}
		if (active || this.restoringUpdate || this.checkpoints?.held || this.applyingUpdate || next?.phase !== "waiting") return;
		try { if (!automaticUpdatePending(this.runtimeHome)) return; } catch { return; }
		this.applyingUpdate = true;
		// The controller rechecks admission atomically in this host. A session
		// arriving between this hint and that check simply defers activation.
		void launchOperation(this.runtimeHome, "apply").catch(() => {}).finally(() => { this.applyingUpdate = false; });
	}

	private scheduleUpdateCheck(): void {
		if (!this.runtimeHome || !this.runtime || this.closing) return;
		clearTimeout(this.updateCheckTimer);
		const checked = Math.max(readUpdateCheck(this.runtimeHome, this.runtime)?.checkedAt ?? 0, this.lastUpdateCheck);
		this.updateCheckTimer = setTimeout(() => this.checkForUpdates(), Math.max(0, checked + updateCheckInterval - Date.now()));
		this.updateCheckTimer.unref();
	}
	private checkForUpdates(): void {
		if (!this.runtimeHome || this.closing || this.checkingUpdate) return;
		clearTimeout(this.updateCheckTimer);
		this.checkingUpdate = true; this.updateCheckError = undefined; this.refreshUpdates();
		void checkRuntimeUpdate(this.runtimeHome, this.updateCheckAbort.signal).catch(error => {
			if (!this.closing) this.updateCheckError = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			this.checkingUpdate = false; this.lastUpdateCheck = Date.now();
			this.refreshUpdates(); this.scheduleUpdateCheck();
		});
	}

	private hostStatus(): HostStatus {
		const active = [...this.sessions.values()].filter(item => item.worker);
		const ticket = this.inputs?.checkpoint();
		return {
			release: RELEASE, instance: this.control!.record.instance, pid: process.pid, started: this.control!.record.started,
			origin: this.origin, stopping: this.closing, cwd: this.options.cwd, agentDir: this.options.agentDir!,
			sessionDir: this.options.sessionDir, relay: this.relayStatus, runtime: this.runtime, checkpoint: this.checkpoints?.status(),
			restore: ticket && this.runtime && [ticket.source, ticket.target].includes(this.runtime)
				&& ["committed", "complete"].includes(ticket.state)
				? { id: ticket.id, pending: this.restoringUpdate, failures: ticket.sessions.filter(actor => actor.error).length } : undefined,
			sessions: { active: active.length,
				working: active.filter(({ view }) => view.state === "starting" || view.snapshot?.activity !== "idle"
					|| view.controls?.some(control => control.state === "running")).length,
				questions: active.reduce((sum, { view }) => sum + (view.ui?.interactions.length ?? 0), 0) },
		};
	}

	private async connectAccount(): Promise<void> {
		const revision = ++this.accountRevision;
		clearTimeout(this.accountRetry); this.relay?.close(); this.relay = undefined;
		this.partyNetwork?.close(); this.partyNetwork = undefined;
		this.accountIdentity?.close(); this.accountIdentity = undefined; this.relayStatus = undefined;
		const saved = await readAccount(this.directory);
		if (this.closing || revision !== this.accountRevision) return;
		if (!saved) { this.emit({ type: "state", state: this.state() }); return; }
		const update = (status: RelayStatus) => {
			if (this.closing || revision !== this.accountRevision) return;
			this.relayStatus = status; this.emit({ type: "state", state: this.state() });
		};
		update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "connecting" });
		try {
			const { NativeAccountIdentity } = await import("./account-identity.ts");
			const identity = await NativeAccountIdentity.open(this.directory, saved.config, { proxy: this.options.proxy });
			if (this.closing || revision !== this.accountRevision) { identity.close(); return; }
			this.accountIdentity = identity;
			const network = new PartyNetwork(this.parties!.store, workspaceIdentity(identity.config), () => {
				if (this.closing || revision !== this.accountRevision) return;
				this.parties!.networkChanged(); this.refreshParties(); this.flushPartyWakes();
			}, { operations: this.partyOperations!, execute: (computer, request) => this.executePartyOperation(computer, request) });
			this.partyNetwork = network;
			this.relay = new RelayConnector({ account: identity, appOrigin: saved.appOrigin, proxy: this.options.proxy,
				request: (access, request) => this.api(access, request),
				watch: handler => {
					this.watchers.add(handler); handler({ type: "state", state: this.state() });
					return () => this.watchers.delete(handler);
				}, status: update, party: {
					connected: (id, send, close) => network.connected(id, send, close),
					receive: (id, packet) => network.receive(id, packet),
				},
			});
			this.relay.start();
		} catch {
			if (this.closing || revision !== this.accountRevision) return;
			this.relay?.close(); this.relay = undefined; this.partyNetwork?.close(); this.partyNetwork = undefined;
			this.accountIdentity?.close(); this.accountIdentity = undefined;
			update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "offline",
				error: "Account identity is unavailable. Sign in on this computer and unlock its protected credential store." });
			this.accountRetry = setTimeout(() => { void this.connectAccount().catch(() => {}); }, 30_000);
			this.accountRetry.unref();
		}
	}

	private write(response: ServerResponse, frame: string): void {
		if (response.destroyed) return;
		if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
		response.write(frame);
	}

	private emit(event: HostEvent): void {
		const id = ++this.sequence;
		const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
		this.history.push({ id, frame });
		this.historyBytes += Buffer.byteLength(frame);
		while (this.history.length > 512 || this.historyBytes > 2 * 1024 * 1024) {
			this.historyBytes -= Buffer.byteLength(this.history.shift()!.frame);
		}
		for (const client of this.clients) this.write(client.response, frame);
		for (const handler of this.watchers) handler(event);
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
				managed.view = { ...managed.view, state: "closed", interrupted: false, snapshot: undefined, ui: undefined, historyReady: false, error: undefined,
					inputs: this.inputs?.pending(key) };
			}
			this.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			if (message.control.kind === "close" && message.control.state === "completed") this.refreshUpdates();
			if (message.control.state !== "running") this.drainInputs(managed);
			return;
		}
		if (message.type === "snapshot") {
			if (managed.view.leaf !== message.snapshot.leaf || managed.view.name !== message.snapshot.name
				|| managed.view.file !== message.snapshot.file) this.saved?.invalidate();
			managed.view = { ...managed.view, cwd: message.snapshot.cwd, file: message.snapshot.file,
				agentId: message.snapshot.id, name: message.snapshot.name, title: message.snapshot.title, leaf: message.snapshot.leaf, state: "ready", ...sessionDisplay(message.snapshot) };
		} else if (message.type === "history_ready") {
			if (managed.view.ui?.generation !== message.generation) return;
			managed.view = { ...managed.view, historyReady: true };
		} else if (message.type === "ui") managed.view = { ...managed.view, ui: message.snapshot,
			...(managed.view.ui && managed.view.ui.generation !== message.snapshot.generation
				? { state: "starting" as const, snapshot: undefined, historyReady: false } : {}) };
		else if (message.type === "fatal") {
			this.inputs?.interrupt(key, "The session worker stopped");
			managed.view = { ...managed.view, state: "failed", error: message.error, interrupted: true, snapshot: undefined, ui: undefined, historyReady: false,
				inputs: this.inputs?.pending(key) };
			const worker = managed.worker;
			void worker?.close().catch(() => {}).finally(() => {
				if (managed.worker === worker) managed.worker = undefined;
				this.refreshUpdates();
			});
		}
		else { this.emit({ type: "worker", key, message }); return; }
		this.emit({ type: "session", session: managed.view });
		this.persist();
		if (message.type === "snapshot") { this.refreshParties(); this.drainInputs(managed); }
	}

	private inputEvent(managed: ManagedSession): void {
		managed.view = { ...managed.view, inputs: this.inputs!.pending(managed.view.key) };
		if (!this.closing) this.emit({ type: "session", session: managed.view });
	}

	private attachments(key: string): Attachments {
		let referenced: Set<string> | undefined;
		return new Attachments(this.options.agentDir!, key, id => (referenced ??= this.inputs!.files(key)).has(id));
	}

	private drainInputs(managed: ManagedSession): void {
		if (managed.draining || !managed.initialized || this.closing || this.checkpoints?.held || this.restoringUpdate || managed.view.state !== "ready"
			|| !managed.worker || managed.view.controls?.some(control => control.state === "running")) return;
		const worker = managed.worker, key = managed.view.key;
		// Admission returns before IPC dispatch, leaving queued input cancellable.
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
					// Pin files before IPC: an input handler can observe them before native admission.
					this.attachments(key).retain(input.command.attachments ?? []);
					this.inputs!.settle(key, input.id, "sending");
					this.inputEvent(managed);
					await worker.command({ ...input.command,
						behavior: input.command.behavior ?? (input.generation === undefined ? "steer" : undefined) }, generation, input.id);
					this.inputs!.settle(key, input.id, "accepted");
				} catch (error) {
					this.inputs!.settle(key, input.id, error instanceof WorkerConnectionError ? "interrupted" : "failed",
						error instanceof Error ? error.message : String(error));
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
				if (this.storageError !== message) { this.storageError = message; this.emit({ type: "state", state: this.state() }); }
				throw error;
			}
			if (this.storageError) { this.storageError = undefined; this.emit({ type: "state", state: this.state() }); }
		} else if (!this.catalogTimer) this.catalogTimer = setTimeout(() => {
			try { this.persist(true); }
			catch (error) { console.error("Background catalog publication failed:", error); }
		}, 500);
	}

	private persistEvent(immediate = false): void {
		try { this.persist(immediate); }
		catch (error) { console.error("Catalog publication failed:", error); }
	}

	private rememberPartyDriver(view: SessionView): string | undefined {
		const root = view.snapshot?.id ?? view.agentId ?? (view.file ? readSessionHeader(view.file).id : undefined);
		if (!root || !uuid(root) || !view.file || !this.partyOperations || this.partyOperations.driverKnown(root)) return root;
		const children: string[] = [];
		try {
			const directory = join(this.options.agentDir!, "subagents", "sessions", encodeURIComponent(root));
			for (const name of readdirSync(directory)) {
				const child = name.endsWith(".jsonl") ? name.slice(-42, -6) : undefined;
				if (uuid(child)) children.push(child);
			}
		} catch { /* The root may not have a child catalogue. */ }
		this.partyOperations.rememberDriver(root, view.file, children);
		return root;
	}
	private flushPartyWakes(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate || !this.partyOperations || !this.parties) return;
		try {
			const targets: string[] = [];
			for (const { view, worker } of this.sessions.values()) {
				if (!isOpenSession(view)) continue;
				const root = this.rememberPartyDriver(view);
				if (!root) continue;
				const member = this.parties.store.member(root);
				if (member && (!worker || !member.delivery)) targets.push(root);
				for (const child of this.partyOperations.driverChildren(root)) {
					if ((this.partyOperations.driver(child)?.seen ?? 0) <= Date.now() - LEASE_MS) targets.push(child);
				}
			}
			this.partyOperations.autoWakes(this.parties.store, targets, "host", (computer, request) => this.executePartyOperation(computer, request));
		} catch { console.error("Party automatic wakes could not be read."); }
	}

	private flushLocalPartyOperations(): void {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate || !this.partyOperations) return;
		let requests: PartyOperation[];
		try { requests = this.partyOperations.outgoing("local"); }
		catch { console.error("Party operations could not be read."); return; }
		for (const request of requests) void this.partyOperations.receive("local", request,
			operation => this.executePartyOperation("local", operation)).then(result => {
			if (result && !this.closing) this.partyOperations!.settle("local", result);
		}).catch(error => { if (!this.closing) console.error("Party operation failed:", error instanceof Error ? error.message : String(error)); });
	}

	private waitForSession(key: string): Promise<ManagedSession> {
		return new Promise((resolve, reject) => {
			let finished = false;
			const cancel = () => finish(Error("Desk stopped during agent startup."));
			const finish = (error?: Error, managed?: ManagedSession) => {
				if (finished) return; finished = true;
				clearTimeout(timer); this.watchers.delete(check); this.startupWaits.delete(cancel);
				error ? reject(error) : resolve(managed!);
			};
			const check = () => {
				const managed = this.sessions.get(key);
				if (!managed || ["closed", "failed"].includes(managed.view.state)) finish(Error(managed?.view.error ?? "The agent stopped during startup."));
				else if (managed.initialized && managed.worker && managed.view.state === "ready") finish(undefined, managed);
			};
			const timer = setTimeout(() => finish(Error("Agent startup timed out. Check its conversation before retrying.")), 120_000);
			this.startupWaits.add(cancel); this.watchers.add(check);
			if (this.closing) cancel(); else check();
		});
	}

	private waitForControl(key: string, id: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let finished = false;
			const cancel = () => finish(Error("Desk stopped before closure was confirmed."));
			const finish = (error?: Error) => {
				if (finished) return; finished = true;
				clearTimeout(timer); this.watchers.delete(check); this.startupWaits.delete(cancel);
				error ? reject(error) : resolve();
			};
			const check = () => {
				const status = this.sessions.get(key)?.view.controls?.find(control => control.id === id);
				if (status?.state === "completed") finish();
				else if (status && status.state !== "running") finish(Error(status.error ?? "Closure was not confirmed."));
			};
			const timer = setTimeout(() => finish(Error("Closure timed out. Check the agent before trying again.")), 120_000);
			this.startupWaits.add(cancel); this.watchers.add(check);
			if (this.closing) cancel(); else check();
		});
	}

	private async closePartyAgents(party: string, values: unknown): Promise<{ results: { id: string; state?: string; error?: string }[] }> {
		if (!Array.isArray(values) || !values.length || values.length > 64) throw Error("Select 1–64 party agents.");
		const targets = values.map(value => { const item = object(value); return { id: string(item.id, 100), epoch: string(item.epoch, 100) }; });
		if (new Set(targets.map(target => target.id)).size !== targets.length) throw Error("Duplicate party agent.");
		const store = this.parties!.store, results: { id: string; state?: string; error?: string }[] = [];
		// Children settle through their driver before a selected root tears that driver down.
		targets.sort((a, b) => Number(store.member(b.id)?.kind === "child") - Number(store.member(a.id)?.kind === "child"));
		for (const target of targets) {
			try {
				const member = store.member(target.id);
				if (!member || member.computer || member.room !== party || member.epoch !== target.epoch) throw Error("Party membership changed. Review the current members.");
				if (member.kind === "child") {
					const result = await this.controlPartyChild({ id: randomUUID(), kind: "close", target: member.session, party,
						target_epoch: member.epoch, expires: Date.now() + 300_000 });
					results.push({ id: target.id, state: result!.state }); continue;
				}
				const managed = [...this.sessions.values()].find(({ view }) => (view.snapshot?.id ?? view.agentId) === member.session);
				const wasOpen = !!managed?.worker || member.heartbeat > Date.now() - LEASE_MS;
				if (managed?.worker) {
					const id = randomUUID(); managed.worker.submitControl({ kind: "close" }, managed.worker.generation, id);
					this.inputs!.interrupt(managed.view.key, "The party was closed"); this.inputEvent(managed);
					await this.waitForControl(managed.view.key, id);
				} else if (member.heartbeat > Date.now() - LEASE_MS) {
					const file = store.sessionFile(member.session) ?? SessionManager.findById(member.cwd, member.session,
						configuredSessionDirectory(member.cwd, this.options.agentDir!, this.options.sessionDir));
					if (!file || readSessionHeader(file).id !== member.session) throw Error("The desktop owner's native session is unavailable.");
					const { lease } = await resumeLease(file, { takeover: true, signal: AbortSignal.timeout(30_000) }); lease.close();
				}
				results.push({ id: target.id, state: wasOpen ? "closed" : "already_closed" });
			} catch (error) { results.push({ id: target.id, error: error instanceof Error ? error.message : String(error) }); }
		}
		this.refreshParties(); this.partyNetwork?.flush(); return { results };
	}

	private async controlPartyChild(control: DriverControl): Promise<OperationResult["result"]> {
		let reference = this.partyOperations!.driver(control.target);
		if (!reference) {
			for (const { view } of this.sessions.values()) this.rememberPartyDriver(view);
			reference = this.partyOperations!.driver(control.target);
		}
		if (!reference) throw Error("The child's owning parent driver is unavailable; resume its parent conversation first.");
		if (reference.seen <= Date.now() - LEASE_MS) {
			const child = this.parties!.store.member(control.target);
			if (control.kind === "close" && (!child || child.heartbeat <= Date.now() - LEASE_MS)) return { session: control.target, state: "already_closed" };
			const root = reference.root;
			const managed = [...this.sessions.values()].find(({ view }) => (view.snapshot?.id ?? view.agentId) === root);
			if (!reference.file || readSessionHeader(reference.file).id !== root) throw Error("The owning parent's saved native session is unavailable.");
			await this.waitForSession(managed?.worker ? managed.view.key : this.createSession(readSessionHeader(reference.file).cwd, reference.file, managed));
			reference = this.partyOperations!.driver(control.target);
			if (!reference || reference.seen <= Date.now() - LEASE_MS) throw Error("The owning parent did not restore this child driver.");
		}
		this.partyOperations!.queueDriver(reference, control);
		const outcome = await this.partyOperations!.waitDriver(control.id);
		this.parties!.networkChanged(); this.refreshParties(); this.partyNetwork?.flush();
		return outcome.result;
	}

	private async executePartyOperation(computer: string, request: PartyOperation): Promise<OperationResult["result"]> {
		if (this.closing || this.checkpoints?.held || this.restoringUpdate) throw Error("Desk is updating or shutting down.");
		const store = this.parties!.store;
		this.partyOperations!.validate(store, computer, request);
		if (request.kind === "remove") {
			store.detachMember(request.target!, request.party, request.target_epoch!, {
				id: computer === "local" ? request.sender : agentId(computer, request.sender), epoch: request.sender_epoch,
			});
			this.parties!.networkChanged(); this.refreshParties(); this.partyNetwork?.flush();
			return { session: request.target!, state: "removed" };
		}
		if (request.kind === "resume") {
			const member = store.member(request.target!)!;
			if (member.kind === "child") return this.controlPartyChild({
				id: request.id, kind: "resume", target: member.session, party: request.party, target_epoch: request.target_epoch!, expires: request.expires,
				peer: { computer, sender: request.sender, epoch: request.sender_epoch },
			});
			let managed = [...this.sessions.values()].find(({ view }) => (view.snapshot?.id ?? view.agentId) === member.session);
			if (!managed?.worker && member.heartbeat > Date.now() - LEASE_MS) {
				store.resumeDelivery(member.session, request.target_epoch!); this.parties!.networkChanged();
				return { session: member.session, state: "already_running" };
			}
			if (!managed?.worker) {
				const file = managed?.view.file ?? store.sessionFile(member.session)
					?? SessionManager.findById(member.cwd, member.session, configuredSessionDirectory(member.cwd, this.options.agentDir!, this.options.sessionDir));
				if (!file || readSessionHeader(file).id !== member.session) throw Error("The saved native Pi session file is unavailable.");
				managed = await this.waitForSession(this.createSession(member.cwd, file, managed));
			} else managed = await this.waitForSession(managed.view.key);
			this.partyOperations!.validate(store, computer, request);
			store.resumeDelivery(member.session, request.target_epoch!); this.parties!.networkChanged(); this.partyNetwork?.flush();
			return { session: member.session, state: "ready", key: managed.view.key };
		}
		let fork: { cwd: string; file: string } | undefined;
		if (request.kind === "fork") {
			const member = store.member(request.sender)!;
			const file = store.sessionFile(member.session)
				?? SessionManager.findById(member.cwd, member.session, configuredSessionDirectory(member.cwd, this.options.agentDir!, this.options.sessionDir));
			if (!file) throw Error("The source agent\'s saved native session is unavailable.");
			fork = createPartyFork(file, member.session, request.call!);
		}
		const key = this.createSession(fork?.cwd ?? request.cwd!, fork?.file);
		try {
			const managed = await this.waitForSession(key), worker = managed.worker!;
			this.partyOperations!.validate(store, computer, request);
			await worker.command({ kind: "name", name: request.label! });
			this.partyOperations!.validate(store, computer, request);
			this.parties!.setMembership([managed.view.agentId!], request.party);
			this.inputs!.admit(key, { id: request.id, activation: managed.view.activation!, generation: worker.generation,
				command: { kind: "prompt", text: request.task!, behavior: "followUp" } });
			this.inputEvent(managed); this.drainInputs(managed); this.refreshParties(); this.partyNetwork?.flush();
			return { session: managed.view.agentId!, state: "queued", key };
		} catch (error) {
			const managed = this.sessions.get(key);
			if (managed?.worker) {
				await managed.worker.close(); managed.worker = undefined;
				managed.view = { ...managed.view, state: "closed", snapshot: undefined, ui: undefined, historyReady: false };
				this.emit({ type: "session", session: managed.view }); this.persist(true);
			}
			throw error;
		}
	}

	private createSession(cwd: string, sessionFile?: string, existing?: ManagedSession, takeover = false, checkpoint?: string): string {
		if (this.closing || this.checkpoints?.held) throw new WorkerConnectionError("Desk is applying an update or shutting down. Reconnect before starting Pi.");
		if (sessionFile) {
			sessionFile = realpathSync(sessionFile);
			const active = [...this.sessions.values()].find(item => item.worker && item.view.state !== "failed"
				&& (item.view.snapshot?.file ?? item.view.file) === sessionFile);
			if (active) return active.view.key;
			cwd = readSessionHeader(sessionFile).cwd;
		}
		const key = existing?.view.key ?? randomUUID();
		const options: WorkerInit = { cwd: realpathSync(cwd), agentDir: this.options.agentDir, sessionFile, sessionDir: this.options.sessionDir, attachmentScope: key, takeover,
			providerAccountsDirectory: join(this.options.dataDir ?? join(this.options.agentDir!, "desk"), "provider-accounts"),
			...(existing?.view.leaf !== undefined ? { leaf: existing.view.leaf } : {}), ...(checkpoint ? { checkpoint } : {}) };
		const managed: ManagedSession = { view: { ...existing?.view, key, cwd: options.cwd, file: sessionFile,
			created: existing?.view.created ?? Date.now(), state: "starting", error: undefined, interrupted: false,
			snapshot: undefined, ui: undefined, historyReady: false, activation: randomUUID(), inputs: this.inputs!.pending(key) } };
		this.sessions.set(key, managed);
		this.emit({ type: "session", session: managed.view });
		try { this.persist(true); }
		catch (error) {
			if (existing) this.sessions.set(key, existing); else this.sessions.delete(key);
			this.emit({ type: "state", state: this.state() });
			throw error;
		}
		let worker: SessionWorker;
		try {
			worker = new SessionWorker(options, message => {
				if (this.sessions.get(key)?.worker === worker) this.workerEvent(key, message);
			});
		} catch (error) {
			if (existing) this.sessions.set(key, existing); else this.sessions.delete(key);
			this.persistEvent(true); this.emit({ type: "state", state: this.state() });
			throw error;
		}
		managed.worker = worker;
		this.refreshUpdates();
		void worker.start(options).then(snapshot => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed"
				|| managed.view.controls?.some(control => control.kind === "close" && control.state === "running")) return;
			managed.view = { ...managed.view, agentId: snapshot.id, ...sessionDisplay(snapshot), state: "ready",
				cwd: snapshot.cwd, file: snapshot.file, name: snapshot.name, title: snapshot.title, leaf: snapshot.leaf };
			managed.initialized = true; managed.initialGeneration = snapshot.ui.generation;
			this.saved?.invalidate();
			this.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			this.refreshParties(); this.drainInputs(managed);
		}).catch(error => {
			if (this.closing || this.sessions.get(key)?.worker !== worker || managed.view.state === "closed"
				|| managed.view.controls?.some(control => control.kind === "close" && control.state === "running")) return;
			this.inputs!.interrupt(key, "Session startup failed");
			managed.view = { ...managed.view, state: "failed", historyReady: false, error: error instanceof Error ? error.message : String(error),
				inputs: this.inputs!.pending(key) };
			this.emit({ type: "session", session: managed.view });
			this.persistEvent(true);
			void worker.close().catch(() => {}).finally(() => { if (managed.worker === worker) managed.worker = undefined; this.refreshUpdates(); });
		});
		return key;
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
		return origin === this.origin || !!this.options.publicOrigin && origin === this.options.publicOrigin;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		securityHeaders(response);
		try {
			const allowedHosts = [new URL(this.origin).host, ...(this.options.publicOrigin ? [new URL(this.options.publicOrigin).host] : [])];
			if (!request.headers.host || !allowedHosts.includes(request.headers.host)) { json(response, 403, { error: "Unrecognized host." }); return; }
			const url = new URL(request.url ?? "/", this.origin);
			const operator = this.access.isOperator((request.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (request.headers.origin && !this.allowedOrigin(request.headers.origin)) {
				json(response, 403, { error: "Unrecognized request origin." }); return;
			}
			// Process controls are local-only and use a per-incarnation credential,
			// never the persistent operator/device credentials or relay routing.
			if (url.pathname.startsWith("/api/host/")) {
				if (!this.control?.authenticate((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
					json(response, 401, { error: "Local host control authentication required." }); return;
				}
				if (url.pathname === "/api/host/status" && request.method === "GET") {
					json(response, 200, this.hostStatus()); return;
				}
				if (url.pathname === "/api/host/update-checkpoint" && request.method === "GET" && this.checkpoints) {
					const checkpoint = await this.checkpoints.wait(string(url.searchParams.get("id"), 128));
					json(response, 200, { instance: this.control.record.instance, checkpoint }); return;
				}
				if (request.method === "POST") {
					const data = await this.body(request);
					if (data.instance !== this.control.record.instance) { json(response, 409, { error: "The host changed." }); return; }
					if (url.pathname === "/api/host/cancel-update" && this.checkpoints) {
						this.checkpoints.cancel(string(data.checkpoint, 128));
						json(response, 202, { instance: this.control.record.instance }); return;
					}
					if (["/api/host/prepare-update", "/api/host/stop-for-update"].includes(url.pathname)) {
						if (this.dot?.busy) throw Error("Finish the current Dot operation before updating.");
						if (this.providerAccounts?.signingIn) throw Error("Finish or cancel provider sign-in before updating.");
						const target = string(data.target, 64), id = string(data.checkpoint, 128);
						const state = this.runtimeHome ? readState(this.runtimeHome) : undefined;
						if (this.closing || this.restoringUpdate || !this.runtime || data.runtime !== this.runtime || state?.active !== this.runtime
							|| state.pending !== target || state.autoApply !== target || !this.checkpoints) {
							json(response, 409, { error: "The host or prepared update changed." }); return;
						}
						if (url.pathname.endsWith("prepare-update")) {
							const checkpoint = this.checkpoints.prepare(id, this.runtime, target);
							json(response, 202, { instance: this.control.record.instance, checkpoint }); return;
						}
						await this.checkpoints.commit(id, target);
						this.closing = true;
						json(response, 202, { instance: this.control.record.instance });
						setImmediate(() => { void this.close().catch(() => {}); }); return;
					}
					if (url.pathname === "/api/host/stop") {
						if (data.runtime !== undefined && data.runtime !== this.runtime) {
							json(response, 409, { error: "The running runtime changed." }); return;
						}
						this.closing = true;
						json(response, 202, { instance: this.control.record.instance });
						setImmediate(() => { void this.close().catch(() => {}); });
						return;
					}
					if (url.pathname === "/api/host/stop-if-idle") {
						if (this.dot?.busy) throw Error("Dot has an active operation.");
						if (this.providerAccounts?.signingIn) throw Error("Provider sign-in is active.");
						if (this.closing || !this.runtime || data.runtime !== this.runtime) {
							json(response, 409, { error: "The host changed or is already stopping." }); return;
						}
						const active = [...this.sessions.values()].filter(item => item.worker).length;
						if (active) { json(response, 200, { instance: this.control.record.instance, deferred: active }); return; }
						this.closing = true;
						json(response, 202, { instance: this.control.record.instance });
						setImmediate(() => { void this.close().catch(() => {}); });
						return;
					}
					if (url.pathname === "/api/host/invite" && !this.closing) {
						if (data.local !== true) { json(response, 400, { error: "Use account sign-in for remote access." }); return; }
						const destination = `${this.origin}/#pair=${this.access.invite()}`;
						json(response, 200, { instance: this.control.record.instance, url: destination });
						return;
					}
					if (url.pathname === "/api/host/account" && !this.closing) {
						void this.connectAccount().catch(() => {});
						json(response, 202, { instance: this.control.record.instance }); return;
					}
				}
				json(response, 404, { error: "Unknown host control." }); return;
			}
			if (this.closing) {
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
				const paired = this.access.pair(string(data.token, 200), string(data.label, 100));
				const secure = request.headers.origin?.startsWith("https:") ? "; Secure" : "";
				response.setHeader("Set-Cookie", `pi_desk=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
				json(response, 200, paired.device);
				return;
			}
			const device = operator ? "operator" : this.access.authenticate(cookie(request));
			if (url.pathname.startsWith("/api/") && !device) { json(response, 401, { error: "Pair this browser to continue." }); return; }
			if (url.pathname === "/api/events" && request.method === "GET") {
				response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
				const client = { response, device: device! };
				this.clients.add(client);
				const last = Number(request.headers["last-event-id"]);
				const first = this.history[0]?.id ?? this.sequence + 1;
				if (Number.isSafeInteger(last) && last >= first - 1 && last <= this.sequence && request.headers["last-event-id"]) {
					for (const item of this.history) if (item.id > last) this.write(response, item.frame);
				} else this.write(response, `id: ${this.sequence}\ndata: ${JSON.stringify({ type: "state", state: this.state() })}\n\n`);
				request.on("close", () => this.clients.delete(client));
				return;
			}
			if (url.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "POST")) {
				const result = await this.api(device!, { method: request.method, path: `${url.pathname}${url.search}`,
					...(request.method === "POST" ? { body: await this.body(request) } : {}) });
				if (result.asset) {
					response.writeHead(result.status, { "Content-Type": result.asset.mimeType, "Cache-Control": "no-store", "Content-Disposition": "inline" });
					response.end(Buffer.from(result.asset.base64, "base64"));
				} else json(response, result.status, result.body);
				return;
			}
			if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
				await serveClient(this.clientDir, url.pathname, response);
				return;
			}
			json(response, 404, { error: "Not found." });
		} catch (error) {
			if (response.headersSent) { response.destroy(); return; }
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async api(device: string | RemoteAccess, request: ApiRequest): Promise<ApiResponse> {
		const reply = (body: unknown, status = 200): ApiResponse => ({ body, status });
		try {
			if (typeof device === "string" ? device !== "operator" && !this.access.hasDevice(device) : !device.authorized()) {
				return reply({ error: "Device access is no longer authorized." }, 401);
			}
			if (this.closing) return reply({ error: "Desk is applying an update or shutting down. Reconnect shortly." }, 503);
			const url = new URL(request.path, this.origin);
			const data = request.body ?? {};
			const restorationControl = this.restoringUpdate && (/^\/api\/sessions\/[a-f0-9-]+\/close$/.test(url.pathname)
				|| /^\/api\/sessions\/[a-f0-9-]+\/command$/.test(url.pathname) && (data.command as { kind?: string } | undefined)?.kind === "answer");
			if (request.method !== "GET" && (this.checkpoints?.held || this.restoringUpdate && !restorationControl))
				return reply({ error: "Desk is checkpointing or restoring conversations. Wait for the update to finish." }, 503);
			if (url.pathname === "/api/state" && request.method === "GET") return reply(this.state());
			if (url.pathname === "/api/provider-accounts" && request.method === "GET") return reply(await this.providerAccounts!.snapshot());
			if (url.pathname === "/api/provider-accounts/default" && request.method === "POST") return reply(this.providerAccounts!.setDefault(string(data.provider, 200), string(data.id, 36)));
			if (url.pathname === "/api/provider-accounts/sign-ins" && request.method === "POST") return reply(this.providerAccounts!.start(
				string(data.id, 36), string(data.provider, 200), string(data.name, 100), string(data.type, 10) as import("../shared/provider-accounts.ts").ProviderAuthType), 202);
			const signIn = /^\/api\/provider-accounts\/sign-ins\/([a-f0-9-]{36})\/(answer|cancel)$/.exec(url.pathname);
			if (signIn && request.method === "POST") {
				if (signIn[2] === "cancel") await this.providerAccounts!.cancel(signIn[1]!);
				else this.providerAccounts!.answer(signIn[1]!, string(data.prompt, 36), string(data.value, 32_000));
				return reply({});
			}
			if (url.pathname === "/api/dot" && request.method === "GET") return reply(await this.dot!.view());
			if (url.pathname === "/api/dot/connect" && request.method === "POST") {
				void this.dot!.connect(string(data.account, 36)).catch(() => {}); return reply({ accepted: true }, 202);
			}
			if (url.pathname === "/api/dot/disconnect" && request.method === "POST") { await this.dot!.disconnect(); return reply({}); }
			if (url.pathname === "/api/dot/history" && request.method === "GET") return reply(await this.dot!.history(string(url.searchParams.get("before"), 1000)));
			if (url.pathname === "/api/dot/inputs" && request.method === "POST") return reply({ input: this.dot!.send(
				string(data.id, 36), string(data.dot, 200), string(data.text, 32_000),
				Array.isArray(data.files) ? data.files.map(file => string(file, 36)) : [], string(data.connection, 64)) }, 202);
			if (url.pathname === "/api/dot/uploads" && request.method === "POST") return reply(this.dot!.stageFile(
				string(data.id, 36), string(data.dot, 200), string(data.name, 200), string(data.mime, 100), Number(data.size), string(data.connection, 64)));
			const dotFile = /^\/api\/dot\/uploads\/([a-f0-9-]{36})(?:\/(discard))?$/.exec(url.pathname);
			if (dotFile && !dotFile[2] && request.method === "POST") return reply(this.dot!.appendFile(dotFile[1]!, Number(data.offset), string(data.data, 400_000)));
			if (dotFile?.[2] && request.method === "POST") { this.dot!.removeFile(dotFile[1]!); return reply({}); }
			if (url.pathname === "/api/dot/surface" && request.method === "POST") return reply(await this.dot!.openSurface(
				string(data.mode, 20) as import("../shared/dot.ts").DotSurfaceMode));
			const dotSurface = /^\/api\/dot\/surface\/([a-f0-9-]{36})(?:\/(inputs|files|close))?$/.exec(url.pathname);
			if (dotSurface) {
				const id = dotSurface[1]!;
				if (!dotSurface[2] && request.method === "GET") return reply(await this.dot!.surfaceView(id, Number(url.searchParams.get("after"))));
				if (dotSurface[2] === "close" && request.method === "POST") { await this.dot!.closeSurface(id); return reply({}); }
				if (dotSurface[2] === "inputs" && request.method === "POST") {
					await this.dot!.surfaceInput(id, string(data.id, 36), Number(data.width), Number(data.height), data.input as import("../shared/dot.ts").DotSurfaceInput);
					return reply({});
				}
				if (dotSurface[2] === "files" && request.method === "POST") {
					if (!Array.isArray(data.files)) throw Error("Choose files for the native file picker.");
					await this.dot!.surfaceFiles(id, data.files.map(file => string(file, 36))); return reply({});
				}
			}
			if (url.pathname === "/api/dot/downloads" && request.method === "POST") return reply(await this.dot!.download(string(data.message, 500), string(data.attachment, 500)));
			const dotDownload = /^\/api\/dot\/downloads\/([a-f0-9-]{36})(?:\/(release))?$/.exec(url.pathname);
			if (dotDownload) {
				const surface = url.searchParams.get("surface") ?? undefined;
				if (!dotDownload[2] && request.method === "GET") return reply(await this.dot!.downloadChunk(dotDownload[1]!, Number(url.searchParams.get("offset")), surface));
				if (dotDownload[2] === "release" && request.method === "POST") { await this.dot!.releaseDownload(dotDownload[1]!, surface); return reply({}); }
			}
			const dotInput = /^\/api\/dot\/inputs\/([a-f0-9-]{36})(?:\/(cancel))?$/.exec(url.pathname);
			if (dotInput && !dotInput[2] && request.method === "GET") return reply({ input: await this.dot!.input(dotInput[1]!) ?? null });
			if (dotInput?.[2] && request.method === "POST") return reply({ input: this.dot!.cancelInput(
				dotInput[1]!, string(data.dot, 200), string(data.text, 32_000), Array.isArray(data.files) ? data.files.map(file => string(file, 36)) : [], data.connection === undefined ? undefined : string(data.connection, 64)) });
			if (url.pathname === "/api/storage/retry" && request.method === "POST") { this.persist(true); return reply({ saved: true }); }
			if (url.pathname === "/api/parties/close" && request.method === "POST") return reply(await this.closePartyAgents(string(data.party, 48), data.agents));
			if (request.method === "POST" && ["/api/parties/join", "/api/parties/leave"].includes(url.pathname)) {
				const party = string(data.party, 48);
				this.parties!.setMembership(data.agents, url.pathname.endsWith("/leave") ? null : party,
					url.pathname.endsWith("/leave") ? party : undefined);
				this.refreshParties();
				return reply(this.parties!.snapshot);
			}
			if (url.pathname === "/api/runtime/update" && request.method === "POST") {
				if (!this.runtimeHome) return reply({ error: "This host does not use a managed runtime." }, 409);
				await launchOperation(this.runtimeHome, "update");
				this.refreshUpdates();
				return reply({ accepted: true }, 202);
			}
			if (url.pathname === "/api/runtime/update-now" && request.method === "POST") {
				if (this.dot?.busy) throw Error("Finish the current Dot operation before updating.");
				if (this.providerAccounts?.signingIn) throw Error("Finish or cancel provider sign-in before updating.");
				const version = string(data.version, 40);
				if (!this.runtimeHome || !/^\d+\.\d+\.\d+$/.test(version)) return reply({ error: "Select the published update." }, 409);
				await launchOperation(this.runtimeHome, "update-now", version);
				this.refreshUpdates();
				return reply({ accepted: true }, 202);
			}
			if (url.pathname === "/api/runtime/check" && request.method === "POST") {
				if (!this.runtimeHome) return reply({ error: "This host is not a managed installation." }, 409);
				this.checkForUpdates();
				return reply({ accepted: true }, 202);
			}
			if (url.pathname === "/api/runtime/apply" && request.method === "POST") {
				if (this.dot?.busy) throw Error("Finish the current Dot operation before updating.");
				if (this.providerAccounts?.signingIn) throw Error("Finish or cancel provider sign-in before updating.");
				const prepared = string(data.prepared, 64);
				if (!this.runtimeHome || !/^[a-f0-9]{64}$/.test(prepared)) return reply({ error: "Select a prepared update." }, 409);
				await launchOperation(this.runtimeHome, "apply-now", prepared);
				this.refreshUpdates();
				return reply({ accepted: true }, 202);
			}
			if (url.pathname === "/api/folders/places" && request.method === "GET") return reply(await this.folders!.places());
			if (url.pathname === "/api/folders/drives" && request.method === "GET") return reply(await this.folders!.volumes());
			if (url.pathname === "/api/folders" && request.method === "GET") return reply(await this.folders!.page({
				path: url.searchParams.get("path") ?? undefined, query: url.searchParams.get("query") ?? undefined,
				hidden: url.searchParams.get("hidden") === "1", offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
			}));
			if (url.pathname === "/api/sessions" && request.method === "POST") {
				return reply({ key: this.createSession(string(data.cwd, 4000) || this.options.cwd) }, 202);
			}
			if (url.pathname === "/api/resume" && request.method === "POST") {
				const file = realpathSync(string(data.file, 4000));
				const old = [...this.sessions.values()].find(item => (item.view.snapshot?.file ?? item.view.file) === file);
				return reply({ key: this.createSession(this.options.cwd, file, old, data.takeover === true) }, 202);
			}
			const inputRoute = /^\/api\/sessions\/([a-f0-9-]+)\/(inputs|uploads|restart)(?:\/([a-f0-9-]+)(?:\/(cancel|dismiss))?)?$/.exec(url.pathname);
			if (inputRoute) {
				const key = inputRoute[1]!, managed = this.sessions.get(key);
				if (!managed) return reply({ error: "Unknown session." }, 404);
				const id = inputRoute[3];
				if (inputRoute[2] === "inputs" && id) {
					if (request.method === "GET" && !inputRoute[4]) return reply(this.inputs!.read(key, id));
					if (request.method === "POST" && inputRoute[4]) {
						const result = inputRoute[4] === "cancel" ? this.inputs!.cancel(key, id) : this.inputs!.dismiss(key, id);
						this.inputEvent(managed);
						return reply({ result: result ?? null });
					}
				} else if (!id && request.method === "POST") {
					if (inputRoute[2] === "restart") {
						if (managed.worker && (managed.view.state === "starting" || managed.view.state === "ready")) return reply({ key });
						if (managed.worker) throw new Error("Wait for this session worker to stop before restarting it.");
						return reply({ key: this.createSession(managed.view.cwd, managed.view.file, managed, data.takeover === true) }, 202);
					}
					const command = commandFrom(data.command);
					const activation = string(data.activation, 100);
					const generation = data.generation === undefined ? undefined : string(data.generation, 100);
					let input: InputSubmission | undefined;
					if (inputRoute[2] === "inputs") {
						if (command.kind !== "prompt") throw new Error("Expected a message.");
						const id = string(data.id, 100);
						if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid message receipt.");
						input = { id, activation, generation, command };
						const previous = this.inputs!.existing(key, input);
						if (previous) return reply({ accepted: true, input: previous });
					}
					if (this.closing || !managed.worker || managed.view.state === "closed" || managed.view.state === "failed")
						throw new Error("Start or resume this conversation before sending.");
					if (activation !== managed.view.activation) throw new StaleGeneration();
					if (inputRoute[2] === "uploads") {
						switch (command.kind) {
							case "upload_begin": case "upload_chunk": case "upload_finish": case "upload_discard":
								return reply({ result: this.attachments(key).command(command) ?? null });
							default: throw new Error("Expected an upload command.");
						}
					}
					if (managed.view.controls?.some(control => control.state === "running")) throw new Error("Wait for the current operation before sending.");
					if (generation !== undefined ? generation !== managed.view.ui?.generation
						: managed.initialized && managed.initialGeneration !== managed.view.ui?.generation) throw new StaleGeneration();
					if (!input!.command.text.trim() && !input!.command.attachments?.length) throw new Error("Enter a message or attach a file.");
					this.attachments(key).check(input!.command.attachments ?? []);
					const accepted = this.inputs!.admit(key, input!);
					this.inputEvent(managed);
					this.drainInputs(managed);
					return reply({ accepted: true, input: accepted }, 202);
				}
				return reply({ error: "Unknown input operation." }, 404);
			}
			const control = /^\/api\/sessions\/([a-f0-9-]+)\/(close|metadata)$/.exec(url.pathname);
			if (control && request.method === "POST") {
				const managed = this.sessions.get(control[1]!);
				if (!managed) throw new Error("Unknown session.");
				if (control[2] === "close") {
					if (string(data.activation, 100) !== managed.view.activation) throw new StaleGeneration();
					if (!managed.worker) {
						this.inputs!.interrupt(managed.view.key, "The conversation closed");
						managed.view = { ...managed.view, state: "closed", interrupted: false, error: undefined,
							snapshot: undefined, ui: undefined, inputs: this.inputs!.pending(managed.view.key) };
						this.persist(true);
						this.emit({ type: "session", session: managed.view });
						return reply({ accepted: true });
					}
					const result = managed.worker.submitControl({ kind: "close" }, managed.worker.generation, string(data.id, 100));
					if (result.control.state === "running") {
						this.inputs!.interrupt(managed.view.key, "The conversation is closing");
						this.inputEvent(managed);
					}
					return reply(result, 202);
				} else {
					if (managed.worker && data.generation !== managed.view.ui?.generation) throw new StaleGeneration();
					managed.view = { ...managed.view, pinned: data.pinned === true };
				}
				this.persist(true);
				this.emit({ type: "session", session: managed.view });
				return reply({});
			}
			const route = /^\/api\/sessions\/([a-f0-9-]+)\/(command|history|assets\/([a-f0-9]{64})|artifacts\/(sha256-[a-f0-9]{64})|files\/([a-f0-9]{64})(?:\/(text|chunk|open|reveal))?)$/.exec(url.pathname);
			if (route) {
				const managed = this.sessions.get(route[1]!);
				if (!managed) return reply({ error: "Unknown session." }, 404);
				if (!managed.worker || managed.view.state === "closed" || managed.view.state === "failed") throw new Error("Resume this conversation before using its controls.");
				const origin = { message: url.searchParams.get("message"), source: url.searchParams.get("source") ?? undefined };
				if (route[2] === "command" && request.method === "POST") {
					const command = workerCommandFrom(data.command);
					if (["asset", "artifact", "file", "history", "snapshot", "prompt"].includes(command.kind)) throw new Error("Use the corresponding session endpoint.");
					if (isControl(command)) {
						if (command.kind !== "abort" && this.inputs!.pending(managed.view.key).some(input => input.state === "queued" || input.state === "sending"))
							throw new Error("Cancel or finish pending messages before changing this session.");
						return reply({ result: managed.worker.submitControl(command, string(data.generation, 100), string(data.id, 100)) }, 202);
					}
					const result = await managed.worker.command(command, string(data.generation, 100), string(data.id, 100));
					return reply({ result: result ?? null });
				}
				if (route[2] === "history" && request.method === "GET") {
					return reply(await managed.worker.command(workerCommandFrom({ kind: "history",
						before: url.searchParams.has("before") ? string(url.searchParams.get("before"), 100) : undefined,
						after: url.searchParams.get("after") ?? undefined, from: url.searchParams.get("from") ?? undefined,
						source: url.searchParams.has("source") ? string(url.searchParams.get("source"), 100) : undefined })));
				}
				if (route[3] && request.method === "GET") {
					const asset = await managed.worker.command(workerCommandFrom({ kind: "asset", id: route[3], origin })) as { mimeType: string; base64: string };
					return { status: 200, body: null, asset };
				}
				if (route[4] && request.method === "GET") {
					return reply(await managed.worker.command(workerCommandFrom({ kind: "artifact", id: route[4], origin,
						offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
						query: url.searchParams.has("query") ? url.searchParams.get("query") : undefined })));
				}
				if (route[5] && ["open", "reveal"].includes(route[6] ?? "") && request.method === "POST") {
					return reply(await managed.worker.command(workerCommandFrom({ kind: "file", id: route[5], origin, operation: route[6], version: data.version }),
						undefined, string(data.id, 100)));
				}
				if (route[5] && !["open", "reveal"].includes(route[6] ?? "") && request.method === "GET") {
					return reply(await managed.worker.command(workerCommandFrom({ kind: "file", id: route[5], origin, operation: route[6] ?? "info",
						version: url.searchParams.get("version"),
						offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
						line: url.searchParams.has("line") ? Number(url.searchParams.get("line")) : undefined })));
				}
			}
			if (url.pathname === "/api/history" && request.method === "GET") {
				return reply(await this.saved!.page({
					query: url.searchParams.get("query") ?? "",
					offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
					revision: url.searchParams.get("revision") ?? undefined,
					refresh: url.searchParams.get("refresh") === "1",
					cwd: url.searchParams.get("cwd") ?? undefined,
					scan: url.searchParams.get("scan") ?? undefined,
					named: url.searchParams.get("named") === "1",
					reader: url.searchParams.get("reader") ?? undefined,
				}));
			}
			if (url.pathname === "/api/history/cancel" && request.method === "POST") {
				this.saved!.cancel(string(request.body?.scan, 100), string(request.body?.reader, 100));
				return reply({});
			}
			if (typeof device !== "string") return reply({ error: "Not found." }, 404);
			if (url.pathname === "/api/devices" && request.method === "GET") return reply(this.access.devices());
			if (url.pathname === "/api/invite" && request.method === "POST") return reply({ token: this.access.invite() });
			if (url.pathname === "/api/revoke" && request.method === "POST") {
				const id = string(data.id, 100);
				this.access.revoke(id);
				for (const client of this.clients) if (client.device === id) client.response.end();
				return reply({});
			}
			return reply({ error: "Not found." }, 404);
		} catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) },
			error instanceof WorkerConnectionError ? 503 : error instanceof CatalogChanged || error instanceof StaleGeneration || error instanceof ReceiptConflict ? 409 : 400); }
	}

	close(): Promise<void> {
		return this.closeJob ??= this.stop().then(this.resolveClosed, error => { this.rejectClosed(error); throw error; });
	}

	private async stop(): Promise<void> {
		this.closing = true;
		this.checkpoints?.dispose();
		for (const cancel of this.startupWaits) cancel();
		const errors: unknown[] = [];
		try { await this.providerAccounts?.close(); } catch (error) { errors.push(error); }
		try { await this.dot?.close(); } catch (error) { errors.push(error); }
		try { this.persist(true); } catch (error) { errors.push(error); }
		clearInterval(this.heartbeat);
		this.updateWatch?.close(); clearTimeout(this.updateTimer);
		clearTimeout(this.updateCheckTimer); this.updateCheckAbort.abort();
		clearTimeout(this.accountRetry); this.accountRevision++;
		this.relay?.close(); this.partyNetwork?.close();
		this.accountIdentity?.close();
		try { this.partyOperations?.stopHost(); this.partyOperations?.close(); this.parties?.close(); } catch (error) { errors.push(error); }
		try { await this.saved?.close(); } catch (error) { errors.push(error); }
		for (const client of this.clients) client.response.end();
		const workers = await Promise.allSettled([...this.sessions.values()].map(item => item.worker?.close()));
		for (const result of workers) if (result.status === "rejected") errors.push(result.reason);
		try {
			const ticket = this.inputs?.checkpoint();
			if (ticket?.state === "committed") {
				for (const actor of ticket.sessions) {
					const final = this.sessions.get(actor.key)?.worker?.closedCheckpoint;
					if (final?.checkpoint === ticket.id && final.session === actor.session && final.file === actor.file) actor.leaf = final.leaf;
					else actor.error = "The previous worker did not confirm its final saved cursor. Resume manually before continuing work.";
				}
				this.inputs!.writeCheckpoint(ticket);
			}
		} catch (error) { errors.push(error); }
		await Promise.all([...this.sessions.values()].map(item => item.draining));
		await this.checkpoints?.settled(); await this.restoreUpdateJob;
		try { this.inputs?.interrupt(undefined, "The host stopped"); this.inputs?.close(); } catch (error) { errors.push(error); }
		const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
		this.server.closeAllConnections();
		await closed;
		try { if (this.control) removeHostRecord(this.directory, this.control.record.instance); }
		catch (error) { errors.push(error); }
		finally { this.hostLease?.close(); }
		if (errors.length) throw new AggregateError(errors, "Host shutdown encountered errors; check the log.");
	}
}

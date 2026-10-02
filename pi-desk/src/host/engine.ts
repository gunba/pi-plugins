import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StaleGeneration } from "./worker-errors.ts";
import { join } from "node:path";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	readStoredCredential,
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type LoadExtensionsResult,
	type ProjectTrustContext,
	type ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";
import { DeskPresentation } from "./presentation.ts";
import { Transcript } from "./transcript.ts";
import { TranscriptFeed } from "./transcript-feed.ts";
import { recoverReference } from "./references.ts";
import type { ReferenceOrigin } from "../shared/references.ts";
import { installIntegrations } from "./integrations.ts";
import { Attachments } from "./attachments.ts";
import { ArtifactStore } from "../../../pi-output-budget/extensions/artifacts.ts";
import type { UiDetails } from "../../../pi-ui/index.ts";
import type { UiTranscriptSource, UiTranscriptHandle } from "../../../pi-ui/index.ts";
import { materializeSession } from "./session-storage.ts";
import { attachOwnership, releaseOwnership, SessionLease, sessionPath } from "../../../pi-session-ownership/lease.ts";
import { resumeLease } from "../../../pi-session-ownership/handoff.ts";
import type { SessionSnapshot, TreePage, WorkerCommand, WorkerInit, WorkerMessage } from "../shared/protocol.ts";
import { reduceSessionUsage, SESSION_USAGE_CHANGED } from "../../../pi-session-usage/index.ts";
import { resourceSettings, runtimePin } from "./runtime-resources.ts";
import { openingMessage, sessionTitle } from "../shared/session-title.ts";
import { providerIdentity } from "./provider-identity.ts";
import { providerChoices } from "./provider-prompts.ts";
import { promptCommands } from "./prompt-commands.ts";
import { NativeContext } from "./context.ts";
import type { CheckpointAction, CheckpointSnapshot } from "../shared/checkpoint.ts";
import { NativeQueueGuard } from "../../../pi-work-coordination/native-queue.ts";
import { promptCommandName } from "../shared/prompt-commands.ts";

/** The only app module that owns Pi engine/session lifecycle. */
export class DeskEngine {
	readonly presentation: DeskPresentation;
	private runtime?: AgentSessionRuntime;
	private unsubscribe?: () => void;
	private running = false;
	private failed = false;
	private snapshotTimer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private startJob?: Promise<SessionSnapshot>;
	private closeJob?: Promise<void>;
	private replacing = false;
	private readonly send: (message: WorkerMessage) => void;
	private transcript = new Transcript();
	private feed?: TranscriptFeed;
	private sources = new Map<string, TranscriptFeed>();
	private managers = new Set<SessionManager>();
	private reserved?: SessionLease;
	private starting = new AbortController();
	private transition = false;
	private transitionJob?: Promise<unknown>;
	private checkpointHold?: { id: string; running: boolean };
	private authentication?: AbortController;
	private providerFilter = "";
	private attachmentScope?: string;
	private usageRevision = 0;
	private contexts = new WeakMap<AgentSession, NativeContext>();
	private queueGuards = new WeakMap<AgentSession, NativeQueueGuard>();
	private opening?: { manager: SessionManager; text?: string };
	private usageCache?: { manager: SessionManager; leaf: string | null; revision: number; value: SessionSnapshot["usage"] };

	constructor(send: (message: WorkerMessage) => void) {
		this.send = send;
		this.presentation = new DeskPresentation(
			snapshot => { send({ type: "ui", snapshot }); this.scheduleSnapshot(); },
			(view, section) => send({ type: "open_view", view, section }),
			undefined,
			source => this.registerTranscript(source),
			async (name, args) => {
				const session = this.runtime?.session;
				if (/\s/.test(name) || !session?.extensionRunner?.getCommand(name)) throw new Error("Extension command is unavailable.");
				// This registered native command is already inside its owned setting action.
				await session.prompt(`/${name}${args ? ` ${args}` : ""}`, { source: "interactive" });
			},
		);
	}

	private registerTranscript(source: UiTranscriptSource): UiTranscriptHandle {
		const id = randomUUID();
		const feed = new TranscriptFeed(this.transcript, () => source.branch(), () => this.presentation.generation, this.send, () => source.cwd(), id);
		const unsubscribe = source.subscribe(event => feed.event(event));
		this.sources.set(id, feed);
		return { id, close: () => {
			feed.close(); unsubscribe(); this.sources.delete(id);
		} };
	}

	private reference<T>(id: string, origin: ReferenceOrigin, read: () => T | Promise<T>): Promise<T> {
		return recoverReference(read, () => {
			const feed = origin.source === undefined ? this.feed : this.sources.get(origin.source);
			if (!feed) throw new Error("This transcript is no longer available.");
			this.transcript.recover(id, () => feed.restore(origin.message));
		});
	}

	async start(options: WorkerInit): Promise<SessionSnapshot> {
		if (this.closed || this.startJob) throw new Error("Session engine is already started or closing.");
		if (options.checkpoint) {
			if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.checkpoint)) throw new Error("Invalid restore checkpoint.");
			this.checkpointHold = { id: options.checkpoint, running: false };
			this.transition = true; this.presentation.setSuspended(true);
		}
		this.startJob = this.initialize(options);
		return this.startJob;
	}

	private async initialize(options: WorkerInit): Promise<SessionSnapshot> {
		this.attachmentScope = options.attachmentScope;
		if (options.agentDir) process.env.PI_CODING_AGENT_DIR = realpathSync(options.agentDir);
		const agentDir = getAgentDir();
		const pin = runtimePin(options.runtimeDirectory);
		this.transcript = new Transcript(new ArtifactStore(join(agentDir, "tool-output")));
		const cwd = realpathSync(options.cwd);
		const settings = SettingsManager.create(cwd, agentDir);
		let desktop = false;
		if (options.sessionFile) {
			const acquired = await resumeLease(options.sessionFile, { takeover: options.takeover, signal: this.starting.signal });
			this.reserved = acquired.lease; desktop = acquired.desktop;
		}
		let manager: SessionManager;
		try {
			this.starting.signal.throwIfAborted();
			manager = options.sessionFile ? SessionManager.open(realpathSync(options.sessionFile))
				: options.ephemeral ? SessionManager.inMemory(cwd)
				: SessionManager.create(cwd, options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? settings.getSessionDir());
			this.claim(manager);
			// Desktop may have advanced or changed branches since Desk last saw
			// this file. Its newly flushed native head wins after a handoff.
			if (!desktop && options.leaf === null) manager.resetLeaf();
			else if (!desktop && options.leaf) {
				if (!manager.getEntry(options.leaf)) throw new Error("Saved branch position no longer exists.");
				manager.branch(options.leaf);
			}
		} catch (error) { this.reserved?.close(); this.reserved = undefined; this.releaseManagers(); throw error; }
		// Native Pi has loaded and selected the branch. Browsing it need not wait
		// for resource discovery, project trust or extension startup.
		this.openTranscript(manager);
		const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			this.claim(sessionManager);
			const settingsManager = SettingsManager.create(cwd, agentDir);
			let context: NativeContext | undefined;
			const services = await createAgentSessionServices({
				cwd, agentDir, settingsManager: resourceSettings(settingsManager, cwd, agentDir, pin),
				resourceLoaderOptions: {
					extensionFactories: [
						{ name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
						{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
						{ name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
						{ name: "pi-desk", factory: pi => {
						this.presentation.install(pi);
						installIntegrations(pi);
						const releaseUsage = pi.events.on(SESSION_USAGE_CHANGED, () => { this.usageRevision++; this.scheduleSnapshot(); });
						pi.on("session_shutdown", releaseUsage);
						pi.on("before_agent_start", () => { context?.apply(); });
						pi.on("session_tree", () => {
							context?.apply();
							this.feed?.reset();
							this.presentation.advance();
						});
					} }],
				},
				resourceLoaderReloadOptions: {
					resolveProjectTrust: ({ extensionsResult }) => this.resolveTrust(cwd, agentDir, settingsManager, extensionsResult),
				},
			});
			// Only native resource discovery keeps the read projection. Session
			// settings and extension controls retain the original file-backed API.
			services.settingsManager = settingsManager;
			context = new NativeContext(sessionManager, services.resourceLoader, pin ? [pin.root] : []);
			services.resourceLoader = context.resources;
			const saved = sessionManager.buildSessionProjection();
			const model = saved.model && services.modelRuntime.getModel(saved.model.provider, saved.model.modelId);
			const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
				...(model && services.modelRuntime.hasConfiguredAuth(model.provider) ? { model } : {}),
				...(sessionManager.getBranch().some(entry => entry.type === "thinking_level_change") ? { thinkingLevel: saved.thinkingLevel as AgentSession["thinkingLevel"] } : {}),
			});
			context.attach(result.session); this.contexts.set(result.session, context);
			this.queueGuards.set(result.session, new NativeQueueGuard(result.session, () => this.presentation.suspended));
			return { ...result, services, diagnostics: services.diagnostics };
		};
		try {
			this.runtime = await createAgentSessionRuntime(create, { cwd: manager.getCwd(), agentDir, sessionManager: manager,
				sessionStartEvent: { type: "session_start", reason: options.sessionFile ? "resume" : "startup" } });
		} catch (error) { this.releaseManagers(); throw error; }
		if (this.closed) {
			throw new Error("Session startup was cancelled.");
		}
		this.runtime.setRebindSession(session => this.bind(session));
		this.runtime.setBeforeSessionInvalidate(() => {
			this.authentication?.abort();
			this.replacing = true;
			this.unsubscribe?.();
			this.feed?.close();
			this.presentation.reset();
		});
		await this.bind(this.runtime.session);
		if (this.checkpointHold) await this.presentation.maintenance(this.checkpointHold.id, "restore");
		if (this.closed) throw new Error("Session startup was cancelled.");
		for (const diagnostic of this.runtime.diagnostics) this.presentation.notify(diagnostic.message, diagnostic.type);
		return this.snapshot();
	}

	private claim(manager: SessionManager): void {
		if (this.managers.has(manager)) return;
		const file = manager.getSessionFile();
		if (!file) return;
		const lease = this.reserved?.file === sessionPath(file) ? this.reserved : new SessionLease(file);
		if (lease === this.reserved) this.reserved = undefined;
		try { materializeSession(manager); }
		catch (error) { lease.close(); throw error; }
		attachOwnership(manager, lease, true);
		this.managers.add(manager);
	}

	private releaseManagers(except?: SessionManager): void {
		for (const manager of this.managers) if (manager !== except) {
			releaseOwnership(manager);
			this.managers.delete(manager);
		}
	}

	private async switchSession(...args: Parameters<AgentSessionRuntime["switchSession"]>) {
		const current = this.runtime!.session.sessionFile;
		if (current && sessionPath(args[0]) === sessionPath(current)) return { cancelled: true };
		this.reserved = new SessionLease(args[0]);
		try { return await this.runtime!.switchSession(...args); }
		finally { this.reserved?.close(); this.reserved = undefined; }
	}

	private async resolveTrust(cwd: string, agentDir: string, settings: SettingsManager, loaded: LoadExtensionsResult): Promise<boolean> {
		if (this.closed) return false;
		if (!hasTrustRequiringProjectResources(cwd)) return true;
		const store = new ProjectTrustStore(agentDir);
		const context: ProjectTrustContext = {
			cwd, mode: "rpc", hasUI: true,
			ui: {
				select: async (title, options, opts) => {
					const answer = await this.presentation.request({
						kind: "question", title, options: options.map(title => ({ title })),
						allowMultiple: false, allowFreeform: false, allowComment: false,
					}, opts);
					return answer?.kind === "selection" ? answer.selections[0] : undefined;
				},
				input: async (title, placeholder, opts) => {
					const answer = await this.presentation.request({ kind: "input", title, placeholder }, opts);
					return answer?.kind === "freeform" ? answer.text : undefined;
				},
				confirm: async (title, message, opts) => {
					const answer = await this.presentation.request({ kind: "confirm", title, message }, opts);
					return answer?.kind === "confirm" && answer.confirmed;
				},
				notify: (message, type) => this.presentation.notify(message, type),
			},
		};
		for (const extension of loaded.extensions) {
			for (const handler of extension.handlers.get("project_trust") ?? []) {
				const result = await (handler as ProjectTrustHandler)({ type: "project_trust", cwd }, context);
				if (this.closed) return false;
				if (!result || result.trusted === "undecided") continue;
				const trusted = result.trusted === "yes";
				if (result.remember) store.set(cwd, trusted);
				return trusted;
			}
		}
		const saved = store.get(cwd);
		if (saved !== null) return saved;
		const policy = settings.getGlobalSettings().defaultProjectTrust ?? "ask";
		if (policy !== "ask") return policy === "always";
		const answer = await this.presentation.request({
			kind: "question", title: "Trust this project?",
			context: `${cwd}\nProject extensions run with your account's permissions.`,
			options: [{ title: "Trust and remember" }, { title: "Trust once" }, { title: "Skip project resources" }],
			allowMultiple: false, allowFreeform: false, allowComment: false,
		});
		const choice = answer?.kind === "selection" ? answer.selections[0] : undefined;
		if (choice === "Trust and remember") store.set(cwd, true);
		return choice === "Trust and remember" || choice === "Trust once";
	}

	private openTranscript(manager: SessionManager): TranscriptFeed {
		this.feed?.close();
		let leaf: string | null | undefined;
		let branch: ReturnType<SessionManager["getBranch"]> = [];
		const feed = this.feed = new TranscriptFeed(this.transcript, () => {
			const current = manager.getLeafId();
			if (current !== leaf) { branch = manager.getBranch(); leaf = current; }
			return branch;
		}, () => this.presentation.generation, this.send, () => manager.getCwd());
		this.send({ type: "ui", snapshot: this.presentation.snapshot() });
		this.send({ type: "history_ready", generation: this.presentation.generation });
		return feed;
	}

	private async bind(session: AgentSession): Promise<void> {
		this.releaseManagers(session.sessionManager);
		this.replacing = false;
		this.unsubscribe?.();
		this.running = false;
		this.failed = false;
		const feed = this.openTranscript(session.sessionManager);
		this.unsubscribe = session.subscribe(event => {
			feed.event(event);
			if (event.type === "message_end" || event.type === "agent_settled") this.usageRevision++;
			if (event.type === "agent_start") this.running = true;
			if (event.type === "agent_settled") this.running = false;
			if (event.type === "message_update" || event.type === "message_start" || event.type === "message_end") {
				// The shared feed projects native messages and sends only token deltas.
			} else if (event.type === "tool_execution_start" || event.type === "tool_execution_end"
				|| event.type === "turn_end" || event.type === "agent_end") {
				this.send({ type: "event", event: { type: event.type } });
			} else if (event.type === "tool_execution_update") {
				// The feed sends coalesced, bounded previews rather than raw partial results.
			} else {
				// Native custom records and compaction/provider state are not browser DTOs.
				this.send({ type: "event", event: { type: event.type } });
			}
			if (event.type !== "message_update" && event.type !== "tool_execution_update") this.scheduleSnapshot();
		});
		await session.bindExtensions({
			mode: "rpc",
			uiContext: this.presentation.createUi(session.extensionRunner!.createContext().ui.theme),
			abortHandler: () => { void session.abort(); },
			shutdownHandler: () => { void this.close(); },
			onError: error => { this.failed = true; this.presentation.notify(`${error.extensionPath}: ${error.error}`, "error"); },
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: options => this.change(() => this.runtime!.newSession(options)),
				switchSession: (path, options) => this.change(() => this.switchSession(path, options)),
				fork: (entryId, options) => this.change(() => this.runtime!.fork(entryId, options)),
				navigateTree: (targetId, options) => this.change(() => session.navigateTree(targetId, options)),
				reload: () => this.reload(),
			},
		});
		await this.publishProviders();
		this.scheduleSnapshot();
	}

	private async publishProviders(): Promise<void> {
		const models = this.runtime!.services.modelRuntime;
		const generation = this.presentation.generation;
		const current = () => !this.closed && this.presentation.generation === generation
			&& this.runtime?.services.modelRuntime === models;
		const credentials = await models.listCredentials();
		if (!current()) return;
		const actions: Record<string, () => unknown | Promise<unknown>> = {};
		const data: UiDetails = {
			summary: "Accounts are saved on this computer, independently of your Desk login. Pi stores one account per provider; signing in again replaces it. For sign-in from another computer or phone, choose device code when offered. Other running sessions keep their current credentials until refreshed.",
			controls: [{ kind: "text", label: "Find provider", value: this.providerFilter, placeholder: "Provider name",
				help: "Press Enter to filter. Leave blank to show configured accounts and subscription sign-ins.",
				action: { id: "search", label: "Filter providers" } }],
			items: models.getProviders().filter(provider => `${provider.id} ${provider.name}`.toLowerCase().includes(this.providerFilter.toLowerCase()))
				.filter(provider => this.providerFilter.trim() || provider.auth.oauth || models.getProviderAuthStatus(provider.id).configured)
				.sort((a, b) => Number(models.getProviderAuthStatus(b.id).configured) - Number(models.getProviderAuthStatus(a.id).configured) || a.name.localeCompare(b.name))
				.map(provider => {
					const status = models.getProviderAuthStatus(provider.id);
					const credential = credentials.find(item => item.providerId === provider.id);
					const identity = credential?.type === "oauth" ? providerIdentity(readStoredCredential(provider.id)) : undefined;
					const itemActions = [];
					if (provider.auth.oauth) {
						const id = `login:${provider.id}`;
						itemActions.push({ id, label: credential ? "Change account" : provider.auth.oauth.loginLabel ?? "Sign in" });
						actions[id] = () => { if (current()) this.login(provider.id); };
					}
					if (credential) {
						const id = `logout:${provider.id}`;
						itemActions.push({ id, label: "Remove saved credential", destructive: true });
						actions[id] = async () => {
							const answer = await this.presentation.request({ kind: "confirm", title: `Sign out of ${provider.name}?`,
								message: "Remove the saved credential on this computer. This does not revoke provider access or unset environment/model configuration." });
							if (!current() || answer?.kind !== "confirm" || !answer.confirmed) return;
							if (this.running || this.authentication) throw new Error("Finish or stop active work before changing an account.");
							const controller = this.authentication = new AbortController();
							try { await models.logout(provider.id, { signal: controller.signal }); }
							finally { if (this.authentication === controller) this.authentication = undefined; }
							if (current()) { await this.publishProviders(); this.scheduleSnapshot(); }
						};
					}
					return { id: provider.id, title: provider.name, subtitle: provider.id,
						status: status.configured ? `Configured · ${status.source ?? "host"}` : "Not configured",
						body: identity ?? (credential ? credential.type === "oauth" ? "Account identity was not provided by this provider." : "Saved API key" : undefined),
						actions: itemActions };
				}),
		};
		this.presentation.publish("desk-providers", { kind: "details", surface: "settings", title: "Model accounts", data,
			actions: [{ id: "refresh", label: "Refresh accounts" }],
		}, { ...actions, search: async value => {
			if (current() && typeof value === "string") { this.providerFilter = value.slice(0, 200); await this.publishProviders(); }
		}, refresh: async () => {
			await models.refresh({ allowNetwork: false });
			if (current()) { await this.publishProviders(); this.scheduleSnapshot(); }
		} });
	}

	private login(providerId: string): void {
		if (this.authentication || this.running || this.transition) throw new Error("Finish or stop active work before signing in.");
		const models = this.runtime!.services.modelRuntime;
		const generation = this.presentation.generation;
		const controller = this.authentication = new AbortController();
		const current = () => !controller.signal.aborted && generation === this.presentation.generation && !this.closed;
		let data: UiDetails = { summary: "Starting provider sign-in…" };
		const publish = () => {
			if (!current()) return;
			this.presentation.publish("desk-login", { kind: "details", surface: "settings", title: "Provider sign-in", data,
				actions: [{ id: "cancel", label: "Cancel sign-in" }] }, { cancel: () => controller.abort() });
		};
		publish(); this.presentation.open("desk-login"); this.scheduleSnapshot();
		void models.login(providerId, "oauth", {
			signal: controller.signal,
			notify: event => {
				if (!current()) return;
				if (event.type === "auth_url") data = { summary: `${event.instructions ?? "Open the provider page to continue."}\nThe callback goes to the computer running Pi. If you are using another device and the final page cannot connect, copy its full address into the completion field here.`,
					links: [{ label: "Open sign-in page", url: event.url }] };
				else if (event.type === "device_code") data = {
					summary: "Open the provider page and enter this code.", fields: [{ label: "Code", value: event.userCode }],
					links: [{ label: "Open verification page", url: event.verificationUri }],
				};
				else if (event.type === "info") data = { ...data, summary: event.message,
					...(event.links ? { links: event.links.map(link => ({ label: link.label ?? "Open provider page", url: link.url })) } : {}) };
				else data = { ...data, summary: event.message };
				publish();
			},
			prompt: async prompt => {
				if (prompt.type === "secret") throw new Error("This provider needs secret input. Complete its setup with /login in Pi on the host.");
				const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
				const choices = prompt.type === "select" ? providerChoices(prompt) : undefined;
				const answer = await this.presentation.request(choices
					? choices.form
					: { kind: "input", title: "Complete provider sign-in", context: prompt.message, links: data.links,
						placeholder: "placeholder" in prompt ? prompt.placeholder : undefined }, { signal });
				signal.throwIfAborted();
				if (!current() || !answer) { controller.abort(); throw new Error("Sign-in cancelled."); }
				return answer.kind === "selection" ? choices?.resolve(answer.selections[0]!) ?? "" : answer.kind === "freeform" ? answer.text : "";
			},
		}).then(() => { if (current()) this.presentation.notify("Provider sign-in saved on this computer."); })
			.catch(error => {
				if (current()) this.presentation.notify(error instanceof Error ? error.message : String(error), "error");
			}).finally(async () => {
				if (this.authentication !== controller) return;
				try {
					if (this.closed || generation !== this.presentation.generation) return;
					try { await this.publishProviders(); } catch { this.presentation.notify("Account state changed; reload resources to refresh it.", "warning"); }
					if (this.closed || generation !== this.presentation.generation) return;
					this.presentation.publish("desk-login", undefined);
					this.presentation.open("desk-providers");
				} finally { if (this.authentication === controller) this.authentication = undefined; this.scheduleSnapshot(); }
			});
	}

	private scheduleSnapshot(): void {
		if (this.closed || this.replacing || this.transition || this.snapshotTimer || !this.runtime) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			if (!this.closed && !this.replacing && this.runtime) this.send({ type: "snapshot", snapshot: this.snapshot() });
		}, 80);
	}

	snapshot(): SessionSnapshot {
		if (!this.runtime || this.replacing) throw new Error("Session is still starting.");
		const session = this.runtime.session;
		const loaded = this.runtime.services.resourceLoader.getExtensions();
		const active = new Set(session.getActiveToolNames());
		const ui = this.presentation.snapshot();
		const context = session.getContextUsage();
		const defaults = session.settingsManager.getGlobalSettings();
		const queued = (messages: readonly string[]) => ({ count: messages.length, previews: messages.slice(0, 12).map(text => text.length > 300 ? `${text.slice(0, 300)}…` : text) });
		const manager = session.sessionManager, leaf = manager.getLeafId();
		if (this.opening?.manager !== manager || !this.opening.text)
			this.opening = { manager, text: openingMessage(manager.getEntries()) };
		if (!this.usageCache || this.usageCache.manager !== manager || this.usageCache.leaf !== leaf || this.usageCache.revision !== this.usageRevision) {
			const { usage } = reduceSessionUsage(manager.getEntries());
			this.usageCache = { manager, leaf, revision: this.usageRevision, value: usage ? {
				input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total,
			} : undefined };
		}
		return {
			id: session.sessionId, file: session.sessionFile, cwd: this.runtime.cwd, name: session.sessionName,
			title: sessionTitle(session.sessionName, this.opening.text),
			leaf: session.sessionManager.getLeafId(),
			model: session.model ? { id: session.model.id, provider: session.model.provider, name: session.model.name, images: session.model.input.includes("image") } : undefined,
			defaultModel: defaults.defaultProvider && defaults.defaultModel ? { provider: defaults.defaultProvider, id: defaults.defaultModel } : undefined,
			thinking: session.thinkingLevel, thinkingLevels: session.getAvailableThinkingLevels(),
			activity: ui.interactions.length ? "waiting" : this.running || this.transition || this.authentication || session.isCompacting ? "running" : this.failed || loaded.errors.length ? "error" : "idle",
			tools: session.getAllTools().map(tool => ({ name: tool.name, description: tool.description, active: active.has(tool.name) })),
			extensions: [
				...loaded.extensions.map(extension => ({ path: extension.path })),
				...loaded.errors.map(error => ({ path: error.path, error: error.error })),
			],
			commands: promptCommands(session, this.runtime.services.resourceLoader),
			models: this.runtime.services.modelRuntime.getAvailableSnapshot().map(model => ({
				id: model.id, provider: model.provider, name: model.name,
			})),
			queue: { steering: queued(session.getSteeringMessages()), followUp: queued(session.getFollowUpMessages()) },
			context: context ? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent } : undefined,
			usage: this.usageCache.value,
			ui,
		};
	}

	async command(generation: string, command: WorkerCommand): Promise<unknown> {
		if (generation !== this.presentation.generation) throw new StaleGeneration();
		if (command.kind === "answer") { this.presentation.answer(command.id, command.answer); return; }
		if (this.closed || this.replacing) throw new Error("Session is unavailable.");
		// These reads depend on the owned native branch, not a running agent.
		switch (command.kind) {
			case "history": {
				const feed = command.source === undefined ? this.feed : this.sources.get(command.source);
				if (!feed) throw new Error("This transcript is no longer available.");
				return feed.history(command);
			}
			case "asset": return this.reference(command.id, command.origin, () => this.transcript.getAsset(command.id));
			case "artifact": return { ...await this.reference(command.id, command.origin,
				() => this.transcript.artifactPage(command.id, command.offset, command.query)), generation };
			case "file": return this.reference(command.id, command.origin, () => this.transcript.files.command(command));
		}
		if (!this.runtime) throw new Error("Session is unavailable.");
		const session = this.runtime.session;
		if (this.transition && !["snapshot", "history", "asset", "artifact", "file", "tree", "abort", "context_inspect", "context_read"].includes(command.kind)) throw new Error("A session transition is in progress.");
		if (command.kind === "prompt" || command.kind === "compact" || command.kind === "navigate" && command.summarize) {
			const errors = this.runtime.services.resourceLoader.getExtensions().errors;
			if (errors.length) throw new Error(`Fix extension load errors before prompting: ${errors.map(error => error.path).join(", ")}`);
		}
		switch (command.kind) {
			case "snapshot": return this.snapshot();
			case "context_inspect": return this.contexts.get(session)!.inspect();
			case "context_read": return this.contexts.get(session)!.read(command.path);
			case "context_update": case "context_save": return this.change(async () => {
				const context = this.contexts.get(session)!;
				return command.kind === "context_update" ? context.update(command) : context.save(command.path, command.version, command.text);
			}, true);
			case "tree": return this.tree(command.after);
			case "navigate": return this.change(async () => {
				const result = await session.navigateTree(command.entry, { summarize: command.summarize });
				if (!result.cancelled) {
					if (result.editorText) session.extensionRunner!.createContext().ui.setEditorText(result.editorText);
					this.scheduleSnapshot();
				}
				return result;
			});
			case "fork": return this.change(async () => {
				const result = await this.runtime!.fork(command.entry, { position: command.position });
				if (result.selectedText) this.runtime!.session.extensionRunner!.createContext().ui.setEditorText(result.selectedText);
				return result;
			});
			case "compact": return this.change(async () => {
				const result = await session.compact(command.instructions);
				this.presentation.advance();
				this.scheduleSnapshot();
				return { tokensBefore: result.tokensBefore };
			});
			case "model": {
				const model = this.runtime.services.modelRuntime.getModel(command.provider, command.id);
				if (!model) throw new Error("Model is unavailable.");
				if (command.makeDefault) {
					session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
					await session.settingsManager.flush();
				} else {
					// Resolve credentials before interrupting healthy work.
					if (!(await this.runtime.services.modelRuntime.checkAuth(model.provider))) throw new Error(`No API key for ${model.provider}/${model.id}`);
					await this.change(() => session.setModel(model, { persist: false }), true);
				}
				this.scheduleSnapshot();
				return;
			}
			case "thinking": {
				const level = session.getAvailableThinkingLevels().find(level => level === command.level);
				if (!level) throw new Error("Reasoning level is unavailable for this model.");
				await this.change(async () => { session.setThinkingLevel(level); }, true);
				return;
			}
			case "abort": {
				this.authentication?.abort(); this.presentation.cancelInteractions(); session.abortCompaction(); session.abortBranchSummary();
				await session.abort();
				if (!this.closed && !this.replacing && !this.transition && this.runtime?.session === session && session.isIdle && session.getSteeringMessages().length) {
					// Trigger through AgentSession so native retry, settlement, queues and images remain intact.
					void session.sendCustomMessage({ customType: "desk-steering-resume", content: "Process the pending steering messages.", display: false },
						{ triggerTurn: true }).catch(error => this.presentation.notify(error instanceof Error ? error.message : String(error), "error"));
					this.scheduleSnapshot();
				}
				return;
			}
			case "action": return this.presentation.act(command.view, command.revision, command.action, command.value,
				operation => this.change(operation, true));
			case "name": session.setSessionName(command.name); this.scheduleSnapshot(); return;
			case "reload": await this.reload(); return this.snapshot();
			case "prompt": {
				if (this.authentication) throw new Error("Finish or cancel provider sign-in before prompting.");
				if (!command.text.trim() && !command.attachments?.length) throw new Error("Enter a message or attach a file.");
				const slash = promptCommandName(command.text);
				const registered = slash ? session.extensionRunner?.getCommand(slash) : undefined;
				const resourceCommand = slash && (session.promptTemplates.some(template => template.name === slash) || slash.startsWith("skill:"));
				if ((registered || resourceCommand) && command.attachments?.length) throw new Error("Send attachments in a message, not a slash command.");
				const attached = new Attachments(getAgentDir(), this.attachmentScope ?? session.sessionId).prepare(command.attachments ?? [], session.model?.input.includes("image") ?? false);
				// Preflight reports admission without holding an HTTP request through inference.
				return new Promise<{ accepted: true }>((resolve, reject) => {
					let admitted = false;
					const accept = () => { admitted = true; resolve({ accepted: true }); };
					void session.prompt(command.text + attached.text, {
						images: attached.images.length ? attached.images : undefined,
						source: "interactive", streamingBehavior: command.behavior,
						preflightResult: success => { if (success) accept(); },
					}).then(() => { if (!admitted) accept(); }).catch(error => {
						if (!admitted) reject(error);
						else this.presentation.notify(error instanceof Error ? error.message : String(error), "error");
					});
					// Registered commands execute before model preflight and can wait for UI.
					// Acknowledge dispatch, not completion of the user's interaction.
					if (registered) accept();
				});
			}
		}
	}

	private tree(after?: string): TreePage {
		const manager = this.runtime!.session.sessionManager;
		const entries = manager.getEntries();
		const start = after ? entries.findIndex(entry => entry.id === after) + 1 : 0;
		if (after && !start) throw new Error("Tree position no longer exists.");
		const page = entries.slice(start, start + 150);
		return {
			generation: this.presentation.generation, leaf: manager.getLeafId(),
			entries: page.map(entry => ({
				id: entry.id, parentId: entry.parentId, type: entry.type,
				timestamp: entry.timestamp,
				label: entry.type === "message" ? `${entry.message.role}: ${"content" in entry.message ? typeof entry.message.content === "string" ? entry.message.content.slice(0, 160) : entry.message.content.filter(part => part.type === "text").map(part => part.text).join(" ").slice(0, 160) : ""}`
					: entry.type === "custom" || entry.type === "custom_message" ? entry.customType : entry.type,
			})),
			next: start + page.length < entries.length ? page.at(-1)?.id : undefined,
		};
	}

	private checkpointSnapshot(): CheckpointSnapshot {
		const session = this.runtime?.session;
		if (!session || this.replacing || this.closed) throw new Error("Finish opening this conversation before updating.");
		if (session.agent.hasQueuedMessages() || session.pendingMessageCount || this.queueGuards.get(session)?.pending)
			throw new Error("Send or cancel queued Pi input before updating. This Pi version cannot export every queued message and image safely.");
		this.presentation.inspectMaintenance();
		if (!session.isIdle && !this.running)
			throw new Error("Wait for Pi's pending prompt or retry to settle before updating.");
		const manager = session.sessionManager, file = manager.getSessionFile();
		if (!file) throw new Error("This conversation has no saved session to restore.");
		return { session: manager.getSessionId(), file, cwd: manager.getCwd(), leaf: manager.getLeafId(),
			running: this.checkpointHold?.running ?? this.running };
	}

	async checkpoint(id: string, action: CheckpointAction): Promise<CheckpointSnapshot | undefined> {
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid maintenance checkpoint.");
		if (action === "release") {
			if (!this.checkpointHold || this.checkpointHold.id !== id) return;
			await this.transitionJob?.catch(() => {});
			const resume = this.checkpointHold.running, session = this.runtime?.session;
			this.presentation.setSuspended(false);
			try { await this.presentation.maintenance(id, "release"); }
			catch (error) { this.presentation.setSuspended(true); throw error; }
			this.checkpointHold = undefined; this.transition = false;
			this.scheduleSnapshot();
			if (resume && !this.closed && session?.isIdle)
				void session.prompt("Continue", { source: "interactive" }).catch(error =>
					this.presentation.notify(error instanceof Error ? error.message : String(error), "error"));
			return;
		}
		if (this.checkpointHold) {
			if (this.checkpointHold.id !== id) throw new Error("Another maintenance checkpoint holds this conversation.");
			await this.transitionJob;
			return this.checkpointSnapshot();
		}
		if (this.transition || this.authentication || this.runtime?.session.isCompacting)
			throw new Error("Finish the pending setting, sign-in or compaction before updating.");
		const snapshot = this.checkpointSnapshot();
		if (action === "inspect") return snapshot;
		this.checkpointHold = { id, running: snapshot.running };
		this.transition = true; this.presentation.setSuspended(true); this.scheduleSnapshot();
		const session = this.runtime!.session;
		const job = Promise.resolve().then(async () => {
			this.presentation.cancelInteractions();
			// Owners capture/park synchronously before abort yields. Stop the parent
			// concurrently so a foreground child result cannot start another model turn.
			const stopped = await Promise.allSettled([this.presentation.maintenance(id, "hold"), session.abort()]);
			for (const result of stopped) if (result.status === "rejected") throw result.reason;
			if (!session.isIdle) throw new Error("Pi started another turn during the checkpoint.");
			return this.checkpointSnapshot();
		});
		this.transitionJob = job;
		try { return await job; }
		finally { this.transitionJob = undefined; }
	}

	private async change<T>(operation: () => Promise<T>, interrupt = false): Promise<T> {
		if (this.closed) throw new Error("This session is closing.");
		const session = this.runtime!.session;
		if (this.transition || this.authentication || session.isCompacting || this.presentation.snapshot().interactions.length
			|| !interrupt && (this.running || !session.isIdle)) throw new Error("Finish the pending control or interaction before changing this session.");
		const resume = interrupt && (this.running || !session.isIdle);
		this.transition = true;
		this.send({ type: "snapshot", snapshot: this.snapshot() });
		const job = Promise.resolve().then(async () => {
			if (resume) await session.abort();
			if (this.closed || this.runtime?.session !== session) throw new Error("This session is closing or changed.");
			if (interrupt && !session.isIdle) throw new Error("Pi started another turn. Retry the setting change.");
			return operation();
		});
		this.transitionJob = job;
		try { return await job; }
		catch (error) {
			if (this.replacing && !this.closed) this.send({ type: "fatal", error: `Session replacement failed: ${String(error)}. Resume saved history to recover.` });
			throw error;
		}
		finally {
			this.transitionJob = undefined; this.transition = false; this.scheduleSnapshot();
			// Keep native queues, including image/custom content. Never auto-start idle work
			// or add a second turn if an extension has already started one.
			if (resume && !this.closed && !this.replacing && this.runtime?.session === session && session.isIdle)
				void session.prompt("Continue", { source: "interactive" }).catch(error =>
					this.presentation.notify(error instanceof Error ? error.message : String(error), "error"));
		}
	}

	private async reload(): Promise<void> {
		return this.change(async () => {
			const session = this.runtime!.session;
			const theme = session.extensionRunner!.createContext().ui.theme;
			this.feed?.reset();
			this.presentation.reset();
			this.failed = false;
			try {
				await session.reload({ beforeSessionStart: async () => {
					session.extensionRunner!.setUIContext(this.presentation.createUi(theme), "rpc");
				} });
				await this.publishProviders();
			} catch (error) { this.failed = true; throw error; }
		});
	}

	async shutdownCheckpoint(): Promise<(CheckpointSnapshot & { checkpoint: string }) | undefined> {
		const hold = this.checkpointHold;
		await this.close();
		const manager = this.runtime?.session.sessionManager, file = manager?.getSessionFile();
		return hold && manager && file ? { checkpoint: hold.id, session: manager.getSessionId(), file,
			cwd: manager.getCwd(), leaf: manager.getLeafId(), running: hold.running } : undefined;
	}

	close(): Promise<void> {
		if (this.closeJob) return this.closeJob;
		this.closed = true;
		this.starting.abort();
		this.closeJob = Promise.resolve().then(async () => {
			this.authentication?.abort();
			clearTimeout(this.snapshotTimer);
			this.unsubscribe?.();
			this.feed?.close();
			this.presentation.close();
			// Discovery/binding can still own a writer before the runtime is assigned.
			await this.startJob?.catch(() => {});
			try {
				const session = this.runtime?.session;
				if (session) {
					session.abortCompaction(); session.abortBranchSummary();
				}
				const aborting = session?.abort() ?? Promise.resolve();
				void aborting.catch(() => {});
				// Reload/replacement may still be creating the next runtime and owning its writer.
				await this.transitionJob?.catch(() => {});
				// Native shutdown hooks can release tools whose abort is still settling.
				try { await this.runtime?.dispose(); } finally { await aborting; }
			}
			catch (error) {
				this.send({ type: "fatal", error: `Session shutdown failed: ${error instanceof Error ? error.message : String(error)}. Check saved history before resuming.` });
				throw error;
			}
			finally {
				this.unsubscribe?.(); this.feed?.close();
				this.releaseManagers();
				this.reserved?.close(); this.reserved = undefined;
			}
		});
		return this.closeJob;
	}
}

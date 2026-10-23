import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { RELEASE } from "../shared/release.ts";
import type { RuntimeUpdateState } from "../shared/updates.ts";
import { CACHE_COMPACTION_LEAD_MS, QUIET_MS, mcpServerCommands, readAutomatic, readCacheCompaction, restartBlockers, workerHasRunningCommands, writeAutomatic,
	writeCacheCompaction, type AutomaticUpdates } from "./automatic-updates.ts";
import { launchOperation, runtimeUpdateState } from "../../manage/operations.ts";
import { checkRuntimeUpdate, readUpdateCheck, updateCheckInterval } from "../../manage/update-check.ts";
import type { HostCore, ManagedSession } from "./host-core.ts";

/** A delivery or setting change running this long is stuck. */
const STUCK_MS = 60 * 60_000;
/** A failed automatic update is tried again after this long. */
const RETRY_MS = 60 * 60_000;

interface UpdateHost {
	/** The managed runtime this host runs, and the folder of its installation; both undefined outside an installation. */
	runtime(): string | undefined;
	runtimeHome(): string | undefined;
	/** Host-owned work an update must not cut off. */
	dotBusy(): boolean;
	signingIn(): boolean;
}

/**
 * Keeping this computer current: the update state the app shows, checks for new releases, updating the host itself
 * when nothing it carries is in progress, restarting idle conversations onto its version, and compacting idle
 * conversations before their prompt cache expires.
 */
export class HostUpdates {
	state?: RuntimeUpdateState;
	automatic: AutomaticUpdates = { host: true, conversations: true };
	/** Compact an idle conversation before its cache expires once its context is above this share of its budget. */
	cacheCompaction?: number;
	private readonly core: HostCore;
	private readonly host: UpdateHost;
	private watcher?: FSWatcher;
	private watchTimer?: ReturnType<typeof setTimeout>;
	/** The cache use each conversation was last compacted ahead of, so one cache period gets one attempt. */
	private cacheCompacted = new Map<string, number>();
	/** When each open conversation was last seen busy; it qualifies for an automatic restart after QUIET_MS. */
	private quietSince = new Map<string, number>();
	/** The version each conversation was last restarted for, so a failed restart is not repeated. */
	private restartAttempts = new Map<string, string>();
	private maintaining = false;
	private forcedMaintenance?: { only?: string };
	private hostUpdateAttempt?: { version: string; at: number };
	private hostUpdateWaiting?: string;
	private readonly started = Date.now();
	private checkTimer?: ReturnType<typeof setTimeout>;
	private checkAbort = new AbortController();
	private checking = false;
	private lastCheck = 0;
	private checkError?: string;

	constructor(core: HostCore, host: UpdateHost) { this.core = core; this.host = host; }

	/** Read this computer's update and cache-compaction choices. */
	load(): void {
		this.automatic = readAutomatic(this.core.directory);
		this.cacheCompaction = readCacheCompaction(this.core.directory);
	}

	/** Follow the installation's update records and start checking for releases; nothing outside an installation. */
	start(): void {
		const home = this.host.runtimeHome();
		if (!home) return;
		try {
			this.watcher = watch(home, (_event, name) => {
				if (!["state.json", "operation.json"].includes(String(name))) return;
				clearTimeout(this.watchTimer);
				this.watchTimer = setTimeout(() => this.refresh(), 50);
			});
			this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
		} catch { /* The existing heartbeat also refreshes update state. */ }
		this.refresh();
		this.scheduleCheck();
	}

	close(): void {
		this.watcher?.close(); clearTimeout(this.watchTimer);
		clearTimeout(this.checkTimer); this.checkAbort.abort();
	}

	refresh(): void {
		const home = this.host.runtimeHome();
		if (!home || this.core.closing) return;
		const active = [...this.core.sessions.values()].filter(item => item.worker).length;
		let next: RuntimeUpdateState | undefined;
		try {
			const value = runtimeUpdateState(home);
			if (!value) throw new Error("The managed runtime selection is missing.");
			next = { ...value, activeSessions: active, checking: this.checking, checkError: this.checkError ?? value.checkError,
				automatic: this.automatic, outdated: this.outdated().length, ...(this.hostUpdateWaiting ? { waiting: this.hostUpdateWaiting } : {}) };
			if (this.core.restoringUpdate) next = { ...next, phase: "applying", message: "Restoring conversations…" };
		}
		catch (error) { next = { current: RELEASE.version, phase: "failed", message: error instanceof Error ? error.message : String(error) }; }
		if (JSON.stringify(next) !== JSON.stringify(this.state)) {
			this.state = next;
			this.core.emit({ type: "state", state: this.core.state() });
		}
	}

	scheduleCheck(): void {
		const home = this.host.runtimeHome(), runtime = this.host.runtime();
		if (!home || !runtime || this.core.closing) return;
		clearTimeout(this.checkTimer);
		const checked = Math.max(readUpdateCheck(home, runtime)?.checkedAt ?? 0, this.lastCheck);
		this.checkTimer = setTimeout(() => this.check(), Math.max(0, checked + updateCheckInterval - Date.now()));
		this.checkTimer.unref();
	}

	check(): void {
		const home = this.host.runtimeHome();
		if (!home || this.core.closing || this.checking) return;
		clearTimeout(this.checkTimer);
		this.checking = true; this.checkError = undefined; this.refresh();
		void checkRuntimeUpdate(home, this.checkAbort.signal).catch(error => {
			if (!this.core.closing) this.checkError = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			this.checking = false; this.lastCheck = Date.now();
			this.refresh(); this.scheduleCheck();
		});
	}

	setAutomatic(next: AutomaticUpdates): void {
		writeAutomatic(this.core.directory, next); this.automatic = next; this.refresh();
	}

	setCacheCompaction(threshold: number | undefined): void {
		writeCacheCompaction(this.core.directory, threshold); this.cacheCompaction = threshold;
		this.core.emit({ type: "state", state: this.core.state() });
	}

	/** The conversation is working, so its quiet period starts again. */
	active(key: string): void { this.quietSince.delete(key); }

	/** Conversations on an older Desk than this host, with what would stop each being restarted now. */
	outdated(): { managed: ManagedSession; blockers: string[] }[] {
		return [...this.core.sessions.values()].filter(managed => managed.worker && managed.view.state === "ready"
			&& managed.view.workerRuntime?.version !== RELEASE.version).map(managed => ({ managed,
			blockers: restartBlockers(managed.view, this.core.inputs.pending(managed.view.key).some(input => input.state === "queued" || input.state === "sending")) }));
	}

	/**
	 * Keep this computer current without interrupting work: restart one idle conversation at a time onto
	 * this host's version, and update the host itself when every conversation has been quiet for a while.
	 */
	async maintain(force = false, only?: string): Promise<void> {
		if (this.maintaining) { if (force) this.forcedMaintenance = { only }; return; }
		if (this.core.closing || this.core.held || this.core.restoringUpdate) return;
		this.maintaining = true;
		try {
			const now = Date.now(), home = this.host.runtimeHome();
			// Updating the host leaves conversations running: workers outlive it. It waits only for what the host
			// itself carries, messages being delivered and settings being applied. Waiting for every conversation
			// to fall quiet kept a computer with one long-running conversation on an old version for days.
			let hostBusy: string | undefined;
			for (const managed of this.core.sessions.values()) {
				if (!managed.worker || managed.view.state === "closed") continue;
				const key = managed.view.key, title = managed.view.title ?? managed.view.name ?? "A conversation";
				const pending = this.core.inputs.pending(key).filter(input => input.state === "queued" || input.state === "sending");
				// Anything older than an hour is stuck, not in progress, and must not hold every update back.
				if (pending.some(input => now - input.updated < STUCK_MS)) hostBusy ??= `${title} has a message being delivered`;
				if (managed.view.controls?.some(control => control.state === "running" && now - control.started < STUCK_MS)) hostBusy ??= `${title} is applying a setting`;
				const busy = restartBlockers(managed.view, pending.length > 0).some(reason => reason !== "its folder is missing");
				if (busy) { this.quietSince.delete(key); continue; }
				if (!this.quietSince.has(key)) this.quietSince.set(key, now);
			}
			if (this.cacheCompaction) this.compactBeforeCacheExpiry(now);
			// The host first: it interrupts nothing, and a conversation restart below ends this pass.
			const available = this.state?.available, attempt = this.hostUpdateAttempt;
			const waiting = !available || !this.automatic.host || !home ? undefined
				: now - this.started < QUIET_MS ? "Desk started in the last ten minutes"
				: hostBusy ?? (this.host.dotBusy() ? "A Dot operation is running" : this.host.signingIn() ? "A sign-in is in progress"
				: !["idle", "failed"].includes(this.state!.phase) ? `Another update is ${this.state!.phase}`
				// A failed attempt is retried later, not abandoned: one failure used to stop automatic updates for good.
				: attempt?.version === available && now - attempt.at < RETRY_MS ? `The last attempt failed; Desk retries ${new Date(attempt.at + RETRY_MS).toLocaleTimeString()}` : undefined);
			if (this.hostUpdateWaiting !== waiting) { this.hostUpdateWaiting = waiting; this.refresh(); }
			if (!force && !only && available && this.automatic.host && home && !waiting) {
				this.hostUpdateAttempt = { version: available, at: now };
				await launchOperation(home, "update-now", available);
				this.refresh();
			}
			if (force || this.automatic.conversations) {
				for (const { managed, blockers } of this.outdated()) {
					const key = managed.view.key;
					if (only && key !== only) continue;
					// An explicit request retries a restart that failed earlier.
					if (blockers.length || !force && this.restartAttempts.get(key) === RELEASE.version) continue;
					if (!force && now - (this.quietSince.get(key) ?? now) < QUIET_MS) continue;
					// The new version's prompt and tools cost the conversation its prompt cache, so an automatic move waits for
					// the cache to expire. Codex declares no cache lifetime; it moves after the quiet period alone.
					const cache = managed.view.snapshot?.cache;
					if (!force && cache && cache.usedAt + cache.ttlMs > now) continue;
					if (!managed.worker?.pid || await workerHasRunningCommands(managed.worker.pid, mcpServerCommands(this.core.options.agentDir, managed.view.cwd))) continue;
					await this.restartForUpdate(managed);
					if (!force) return;
				}
			}
		} catch (error) {
			console.error(`Automatic update check failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.maintaining = false;
			// A request made during a background pass runs once that pass ends.
			const queued = this.forcedMaintenance; this.forcedMaintenance = undefined;
			if (queued) void this.maintain(true, queued.only);
		}
	}

	/** Restart one idle conversation onto this host's version, keeping its agent reachable meanwhile. */
	private async restartForUpdate(managed: ManagedSession): Promise<void> {
		const key = managed.view.key;
		this.restartAttempts.set(key, RELEASE.version);
		managed.view = { ...managed.view, updating: true };
		this.core.emit({ type: "session", session: managed.view });
		try {
			await this.core.replaceWorker(managed);
			await this.core.waitForSession(key);
		} catch (error) {
			console.error(`Desk could not restart ${managed.view.title ?? key} onto ${RELEASE.version}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			const current = this.core.sessions.get(key);
			if (current?.view.updating) { current.view = { ...current.view, updating: undefined }; this.core.emit({ type: "session", session: current.view }); }
			this.refresh();
		}
	}

	/**
	 * Compact each idle conversation in the last few minutes before its prompt cache expires, when its context is above
	 * the chosen share of its budget: afterwards the next message would pay to cache the whole context again.
	 */
	private compactBeforeCacheExpiry(now: number): void {
		for (const managed of this.core.sessions.values()) {
			const view = managed.view, snapshot = view.snapshot, cache = snapshot?.cache, worker = managed.worker;
			if (!worker || !cache || view.state !== "ready" || snapshot.activity !== "idle" || snapshot.compacting) continue;
			const left = cache.usedAt + cache.ttlMs - now;
			if (left <= 0 || left > CACHE_COMPACTION_LEAD_MS || (snapshot.context?.percent ?? 0) < this.cacheCompaction!) continue;
			if (this.cacheCompacted.get(view.key) === cache.usedAt || view.ui?.interactions.length || view.controls?.some(control => control.state === "running")
				|| this.core.inputs.pending(view.key).some(input => input.state === "queued" || input.state === "sending")) continue;
			this.cacheCompacted.set(view.key, cache.usedAt);
			void worker.submitControl({ kind: "compact", reason: "cache" }, worker.generation, randomUUID())
				.catch(error => console.error(`Desk could not compact ${view.title ?? view.key} before its cache expired: ${error instanceof Error ? error.message : String(error)}`));
		}
	}
}

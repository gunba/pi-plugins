import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSelection } from "./subagent-runtime.ts";

type SavedDecision = {
	version: 1;
	sessionId: string;
	decision: "allowed" | "denied";
	revision: string;
};

export type ModelPermissionUI = {
	available: boolean;
	confirm(title: string, message: string, options: { signal: AbortSignal }): Promise<boolean>;
};

const REQUIRED = "Subagent model and thinking overrides need user approval for this conversation. Inherit the parent settings, or ask the user to run /subagents permissions allow.";

/** Root-conversation consent, shared by all descendants and independent of branch history. */
export class ConversationModelPermissions {
	private readonly directory: string;
	private readonly file: string;
	private readonly sessionId: string;
	private readonly ui: ModelPermissionUI;
	private readonly lifetime = new AbortController();
	private promptController?: AbortController;
	private pending?: Promise<void>;

	constructor(agentDir: string, sessionId: string, ui: ModelPermissionUI) {
		this.sessionId = sessionId;
		this.ui = ui;
		this.directory = join(agentDir, "subagents", "permissions");
		this.file = join(this.directory, `${encodeURIComponent(sessionId)}.json`);
	}

	private read(): SavedDecision | undefined {
		let data: unknown;
		try { data = JSON.parse(readFileSync(this.file, "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const value = data as Partial<SavedDecision> | null;
		if (!value || value.version !== 1 || value.sessionId !== this.sessionId ||
			(value.decision !== "allowed" && value.decision !== "denied") || typeof value.revision !== "string")
			throw new Error("Invalid saved subagent model permission. Run /subagents permissions revoke to reset it.");
		return value as SavedDecision;
	}

	private save(decision: SavedDecision["decision"]): void {
		this.lifetime.signal.throwIfAborted();
		mkdirSync(this.directory, { recursive: true });
		const record: SavedDecision = { version: 1, sessionId: this.sessionId, decision, revision: randomUUID() };
		const temporary = `${this.file}.${record.revision}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		try { renameSync(temporary, this.file); }
		finally { rmSync(temporary, { force: true }); }
	}

	status(): "ask" | SavedDecision["decision"] {
		return this.read()?.decision ?? "ask";
	}

	/** Only a positive UI response can grant consent; tool arguments cannot. */
	private requestGrant(detail: string, signal?: AbortSignal): Promise<void> {
		this.lifetime.signal.throwIfAborted();
		signal?.throwIfAborted();
		if (!this.ui.available) return Promise.reject(new Error(REQUIRED));
		if (!this.pending) {
			const controller = this.promptController = new AbortController();
			const dialogSignal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
			const revision = this.read()?.revision;
			this.pending = (async () => {
				const allowed = await this.ui.confirm(
					"Allow subagent model and thinking changes?",
					`${detail}\n\nAllow agents and their descendants to choose available models and thinking levels for new subagents throughout this conversation? This may change cost and speed. Approval survives resume and branch changes, but not a new or forked conversation. Revoke it with /subagents permissions revoke.`,
					{ signal: dialogSignal },
				);
				dialogSignal.throwIfAborted();
				if (this.read()?.revision !== revision) throw new Error("Subagent model permission changed while approval was open; try again.");
				this.save(allowed === true ? "allowed" : "denied");
				if (allowed !== true) throw new Error(REQUIRED);
			})().finally(() => { this.pending = undefined; this.promptController = undefined; });
		}
		const pending = this.pending;
		if (!signal) return pending;
		return new Promise((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
			if (signal.aborted) abort();
		});
	}

	async authorize(selection: ModelSelection, signal?: AbortSignal): Promise<void> {
		this.lifetime.signal.throwIfAborted();
		signal?.throwIfAborted();
		const decision = this.status();
		if (decision === "denied") throw new Error(REQUIRED);
		if (decision === "ask") await this.requestGrant(
			`Requested child: ${selection.model.provider}/${selection.model.id}; thinking: ${selection.thinkingLevel}.`, signal);
		signal?.throwIfAborted();
		this.lifetime.signal.throwIfAborted();
		if (this.status() !== "allowed") throw new Error(REQUIRED);
	}

	async allow(): Promise<void> {
		if (this.status() !== "allowed") await this.requestGrant("You can approve model and thinking overrides once for this conversation.");
	}

	revoke(): void {
		this.save("denied");
		this.promptController?.abort(new Error("Subagent model permission was revoked"));
	}

	dispose(): void {
		this.lifetime.abort(new Error("Subagent permission conversation closed"));
	}
}

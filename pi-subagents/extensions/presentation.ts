import type { Presentation, UiAction, UiConversation, UiDetails, UiValue, UiView, UiTranscriptHandle } from "../../pi-ui/index.ts";
import type { ConversationModelPermissions } from "./model-permissions.ts";
import type { ParentInvocation, RuntimeChildSnapshot, SubagentRuntime, ThinkingLevel } from "./subagent-runtime.ts";

/** Human controls use the runtime's existing authority and admission paths. */
export class SubagentPresentation {
	private active = true;
	private readonly signatures = new Map<string, string>();
	private model?: string;
	private thinking?: ThinkingLevel;
	private opened?: string;
	private readonly transcripts = new Map<string, UiTranscriptHandle>();
	private readonly lifetime = new AbortController();
	private readonly remote: Presentation;
	private readonly runtime: SubagentRuntime;
	private readonly parent: () => ParentInvocation;
	private readonly permissions: ConversationModelPermissions;
	constructor(remote: Presentation, runtime: SubagentRuntime, parent: () => ParentInvocation, permissions: ConversationModelPermissions) {
		this.remote = remote; this.runtime = runtime; this.parent = parent; this.permissions = permissions;
	}
	private check(): void {
		if (!this.active) throw new Error("This subagent view belongs to a previous session.");
	}
	private async text(title: string, value = "", multiline = false): Promise<string | undefined> {
		const answer = await this.remote.request({ kind: multiline ? "editor" : "input", title, value },
			{ signal: this.lifetime.signal });
		this.check();
		return answer?.kind === "freeform" ? answer.text : undefined;
	}
	private async launch(context: "fresh" | "fork"): Promise<void> {
		const prompt = await this.text(context === "fork" ? "Task for a forked agent" : "Task for a new agent", "", true);
		if (!prompt?.trim()) return;
		const result = await this.runtime.start({
			context, description: prompt.trim().split("\n")[0]!.slice(0, 80), prompt,
			parent: this.parent(), runInBackground: true,
			...(this.model ? { model: this.model } : {}),
			...(this.thinking ? { thinkingLevel: this.thinking } : {}),
			signal: this.lifetime.signal,
		});
		this.check();
		if (result.kind === "continuable") this.open(result.subagentId);
	}
	private async settings(): Promise<void> {
		const model = await this.text("Launch model · provider/id, or empty to inherit", this.model);
		if (model === undefined) return;
		const levels = ["Inherit parent", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const answer = await this.remote.request({
			kind: "question", title: "Launch thinking level", options: levels.map(title => ({ title })),
			allowMultiple: false, allowFreeform: false, allowComment: false,
		}, { signal: this.lifetime.signal });
		this.check();
		if (answer?.kind !== "selection") return;
		this.model = model.trim() || undefined;
		this.thinking = answer.selections[0] === levels[0] ? undefined : answer.selections[0] as ThinkingLevel;
	}
	open(id?: string): void {
		this.check();
		if (id && !this.runtime.snapshot().some(child => child.id === id)) throw new Error("Unknown subagent.");
		this.opened = id;
		this.refresh();
		this.remote.open(id ? `agent:${id}` : "subagents");
	}
	private publish(id: string, view: UiView, callbacks: Record<string, (value: UiValue) => unknown>): void {
		const signature = JSON.stringify(view);
		if (signature === this.signatures.get(id)) return;
		this.signatures.set(id, signature);
		this.remote.publish(id, view, callbacks);
	}
	private child(child: RuntimeChildSnapshot): void {
		const active = ["running", "waiting"].includes(child.state), direct = child.parentId === this.runtime.host.rootSessionId;
		const callbacks: Record<string, (value: UiValue) => unknown> = {};
		const actions: UiAction[] = [];
		const add = (descriptor: UiAction, run: (value: UiValue) => unknown) => {
			actions.push(descriptor);
			callbacks[descriptor.id] = value => { this.check(); try { return run(value); } finally { this.refresh(); } };
		};
		const message = (value: UiValue, followup: boolean) => {
			if (typeof value !== "string" || !value.trim() || value.length > 1_000_000) throw new Error("Enter a message.");
			return followup ? this.runtime.followupTask(this.runtime.rootAuthority, child.id, value)
				: this.runtime.sendMessage(this.runtime.rootAuthority, child.id, value);
		};
		if (direct && !child.diagnosticReason) {
			if (child.canSteer) add({ id: "steer", label: "Steer", input: "message", delivery: "steer" }, value => message(value, false));
			if (child.mode === "continuable") add({ id: "followup", label: active ? "Queue" : "Send", input: "message", delivery: "followUp" }, value => message(value, true));
		}
		if (child.canStop) add({ id: "stop", label: "Stop agent", destructive: true }, () => this.runtime.interrupt(this.runtime.rootAuthority, child.id));
		const data: UiConversation = {
			transcript: this.transcripts.get(child.id)?.id, scope: child.id,
			active, status: child.state, activity: active ? child.activity?.slice(0, 300) : undefined,
			subtitle: `${child.model} · ${child.thinkingLevel} · depth ${child.depth}`,
			error: (child.errorMessage ?? child.diagnosticReason)?.slice(0, 2000),
			fields: [
				{ label: "Agent", value: child.id },
				{ label: "Model", value: child.model },
				{ label: "Thinking", value: child.thinkingLevel },
				{ label: "Queued tasks", value: String(child.queued ?? 0) },
				...(!active ? [{ label: "Active time", value: `${Math.floor((child.activeDurationMs ?? 0) / 1000)}s` }] : []),
				...(!direct ? [{ label: "Messaging", value: "Only the direct parent can send messages to this agent." }] : []),
			],
		};
		this.publish(`agent:${child.id}`, { kind: "conversation", title: child.label, data, actions }, callbacks);
	}
	refresh(): void {
		if (!this.active) return;
		this.remote.batch(() => this.refreshViews());
	}
	private refreshViews(): void {
		const children = this.runtime.snapshot();
		const live = (child: RuntimeChildSnapshot) => ["running", "waiting"].includes(child.state) || (child.queued ?? 0) > 0;
		const shown = children.filter(child => live(child) || child.id === this.opened);
		for (const child of shown) if (!child.diagnosticReason && !this.transcripts.has(child.id) && this.remote.registerTranscript) {
			this.transcripts.set(child.id, this.remote.registerTranscript(this.runtime.transcript(child.id)));
		}
		const present = new Set(shown.map(child => `agent:${child.id}`));
		for (const id of this.signatures.keys()) if (id !== "subagents" && !present.has(id)) {
			this.remote.publish(id, undefined); this.signatures.delete(id);
			const child = id.slice("agent:".length);
			this.transcripts.get(child)?.close(); this.transcripts.delete(child);
		}
		for (const child of shown) this.child(child);
		const callbacks: Record<string, (value: UiValue) => Promise<void>> = {};
		const action = (id: string, label: string, run: () => unknown | Promise<unknown>, destructive = false): UiAction => {
			callbacks[id] = async () => {
				this.check();
				try { await run(); }
				finally { if (this.active) this.refresh(); }
			};
			return { id, label, destructive };
		};
		const controls = [
			action("launch", "New agent", () => this.launch("fresh")),
			action("fork", "Fork conversation", () => this.launch("fork")),
			action("launch-settings", "Launch settings", () => this.settings()),
			action("refresh", "Refresh", () => {}),
		];
		const permission = this.permissions.status();
		controls.push(permission === "allowed"
			? action("revoke", "Revoke model overrides", () => this.permissions.revoke(), true)
			: action("allow", "Allow model overrides…", () => this.permissions.allow()));
		const details: UiDetails = {
			summary: `${children.length} agents · ${children.filter(child => ["running", "waiting"].includes(child.state)).length} active`,
			fields: [
				{ label: "Launch model", value: this.model ?? "Inherit parent" },
				{ label: "Launch thinking", value: this.thinking ?? "Inherit parent" },
				{ label: "Model override permission", value: permission },
			], items: children.filter(child => !live(child)).map(child => ({
				id: child.id, title: child.label, status: child.state,
				subtitle: `${child.model} · ${child.thinkingLevel} · depth ${child.depth}`,
				actions: [action(`open:${child.id}`, "Open history", () => this.open(child.id))],
			})),

		};
		const view = { kind: "details", title: "Subagents", data: details as UiValue, actions: controls };
		this.publish("subagents", view, callbacks);
	}
	close(): void {
		this.active = false; this.lifetime.abort();
		for (const source of this.transcripts.values()) source.close();
		this.transcripts.clear();
		this.remote.batch(() => { for (const id of this.signatures.keys()) this.remote.publish(id, undefined); });
		this.signatures.clear();
	}
}

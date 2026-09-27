import type { Presentation, UiAction, UiDetails, UiValue, UiTranscriptHandle } from "../../pi-ui/index.ts";
import type { ConversationModelPermissions } from "./model-permissions.ts";
import { readSessionTranscript } from "./session-transcript.ts";
import type { ParentInvocation, RuntimeChildSnapshot, SubagentRuntime, ThinkingLevel } from "./subagent-runtime.ts";

/** Human controls use the runtime's existing authority and admission paths. */
export class SubagentPresentation {
	private active = true;
	private selected?: string;
	private offset = 0;
	private signature = "";
	private model?: string;
	private thinking?: ThinkingLevel;
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
		if (result.kind === "continuable") this.selected = result.subagentId;
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
	private async message(child: RuntimeChildSnapshot, followup: boolean): Promise<void> {
		const text = await this.text(followup ? `Follow-up · ${child.label}` : `Steer · ${child.label}`, "", true);
		if (!text?.trim()) return;
		if (followup) this.runtime.followupTask(this.runtime.rootAuthority, child.id, text);
		else this.runtime.sendMessage(this.runtime.rootAuthority, child.id, text);
	}
	open(id?: string): void {
		this.check(); this.selected = id; this.signature = ""; this.refresh();
		this.remote.open("subagents");
	}
	refresh(): void {
		if (!this.active) return;
		const children = this.runtime.snapshot();
		for (const child of children) if (!child.diagnosticReason && !this.transcripts.has(child.id) && this.remote.registerTranscript) {
			this.transcripts.set(child.id, this.remote.registerTranscript(this.runtime.transcript(child.id)));
		}
		const callbacks: Record<string, (value: UiValue) => Promise<void>> = {};
		const action = (id: string, label: string, run: () => unknown | Promise<unknown>, destructive = false): UiAction => {
			callbacks[id] = async () => {
				this.check();
				try { await run(); }
				finally { if (this.active) { this.signature = ""; this.refresh(); } }
			};
			return { id, label, destructive };
		};
		const childActions = (child: RuntimeChildSnapshot): UiAction[] => [
			action(`inspect:${child.id}`, "Transcript", () => { this.selected = child.id; }),
			...(child.parentId === this.runtime.host.rootSessionId && !child.diagnosticReason ? [
				...(child.mode === "continuable" ? [action(`followup:${child.id}`, "Follow-up", () => this.message(child, true))] : []),
				...(["running", "waiting"].includes(child.state) ? [
					action(`steer:${child.id}`, "Steer", () => this.message(child, false)),
				] : []),
			] : []),
			...(["running", "waiting"].includes(child.state) ? [
				action(`interrupt:${child.id}`, "Interrupt", () => this.runtime.interrupt(this.runtime.rootAuthority, child.id), true),
			] : []),
		];
		const controls = [
			action("list", "All agents", () => { this.selected = undefined; }),
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
			], items: [],
		};
		const selected = children.find(child => child.id === this.selected);
		const source = selected && this.transcripts.get(selected.id);
		if (source) details.transcript = source.id;
		if (selected) {
			const transcript = !source ? readSessionTranscript(selected.sessionFile) : undefined;
			details.items = [
				{ id: selected.id, title: selected.label, subtitle: `${selected.model} · ${selected.thinkingLevel} · depth ${selected.depth}`,
					status: selected.state, body: [selected.id, selected.activity, selected.errorMessage, selected.diagnosticReason].filter(Boolean).join("\n"),
					actions: childActions(selected).filter(action => !action.id.startsWith("inspect:")) },
				...(!source ? [{ id: "transcript", title: "Recent transcript", subtitle: "Latest saved entries. Refresh to include completed messages.",
					body: transcript?.error ?? (transcript?.lines.join("\n") || "No messages yet.") }] : []),
			];
		} else {
			this.offset = Math.min(this.offset, Math.max(0, Math.floor((children.length - 1) / 20) * 20));
			details.items = children.slice(this.offset, this.offset + 20).map(child => ({
				id: child.id, title: child.label, subtitle: `${child.model} · ${child.thinkingLevel} · depth ${child.depth}`,
				status: child.state, body: (child.errorMessage ?? child.diagnosticReason ?? child.activity ?? child.lastOutput ?? "").slice(0, 4_000),
				actions: childActions(child),
			}));
			if (this.offset) controls.push(action("previous", "Previous", () => { this.offset -= 20; }));
			if (this.offset + 20 < children.length) controls.push(action("next", "Next", () => { this.offset += 20; }));
		}
		const view = { kind: "details", title: "Subagents", data: details as UiValue, actions: controls };
		const signature = JSON.stringify(view);
		if (signature === this.signature) return;
		this.signature = signature;
		this.remote.publish("subagents", view, callbacks);
	}
	close(): void {
		this.active = false; this.lifetime.abort();
		for (const source of this.transcripts.values()) source.close();
		this.transcripts.clear();
		this.remote.publish("subagents", undefined);
	}
}

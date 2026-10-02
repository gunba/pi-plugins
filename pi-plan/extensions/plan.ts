import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ensureWorkCoordination, getWorkCoordinator, isManagedChild } from "../../pi-work-coordination/index.ts";
import { ensureWorkUi, safeWorkText, type WorkUiSource } from "../../pi-work-ui/index.ts";
import { planWorkSection } from "../../pi-work-ui/sections.ts";
import { getPresentation, type Presentation, type UiDetails } from "../../pi-ui/index.ts";
import { PlanStore, PlanStateError } from "../src/store.ts";
import { DEFAULT_BLOCKED_AFTER_ROUNDS, DEFAULT_MAX_PLAN_ROUNDS, PLAN_COMMAND_ENTRY, PLAN_ROUND_MESSAGE } from "../src/constants.ts";
import { type PlanRef, type PlanRoundIdentity, type PlanView } from "../src/domain.ts";
import { branchContainsRound, decodePlanRoundDetails } from "../src/replay.ts";
import { renderPlanGuidance, renderPlanRoundPrompt, renderPlanWrapup } from "../src/prompt.ts";
import { CreateParameters, UpdateParameters, definition, preparePlanArguments, type CreateParams, type UpdateParams } from "../src/tools.ts";
import { planControls, planPresentation } from "../src/presentation.ts";
import { STEP_STATUSES, stepSummary } from "../src/steps.ts";

interface Attempt extends PlanRoundIdentity { content: string; admitted: boolean }
const ref = (plan: PlanView): PlanRef => ({ id: plan.id, revision: plan.revision });
const result = (plan?: PlanView) => {
	const value = { plan: plan ?? null };
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
};
function stopReason(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string } | null;
		if (message?.role === "assistant") return message.stopReason;
	}
	return undefined;
}

class PlanController {
	private readonly store: PlanStore;
	private readonly work;
	private readonly topLevel: boolean;
	private source?: WorkUiSource;
	private remote?: Presentation;
	private ctx?: ExtensionContext;
	private epoch = 0;
	private stopping = true;
	private signature = "";
	private tail: Promise<void> = Promise.resolve();
	private attempt?: Attempt;
	private wrapup?: string;
	private lastStop?: string;
	private driving = false;
	private requested = false;
	private editing = 0;
	constructor(privateApi: ExtensionAPI) {
		this.pi = privateApi;
		this.store = new PlanStore(privateApi);
		this.work = ensureWorkUi(privateApi);
		this.topLevel = !process.env.PI_SUBAGENT_TASK_PATH && !isManagedChild(privateApi);
	}
	private readonly pi: ExtensionAPI;
	private read(ctx: ExtensionContext): PlanView | undefined {
		this.store.reconcile(ctx.sessionManager.getBranch()); return this.store.get();
	}
	private run<T>(ctx: ExtensionContext, operation: () => T): Promise<T> {
		const epoch = this.epoch;
		const execute = () => {
			if (this.stopping || epoch !== this.epoch || ctx.sessionManager.getSessionId() !== this.ctx?.sessionManager.getSessionId())
				throw new Error("This plan belongs to a retired session context.");
			try { this.read(ctx); return operation(); } finally { this.refreshUi(); this.requestDrive(ctx); }
		};
		const pending = this.tail.then(execute, execute);
		this.tail = pending.then(() => {}, () => {});
		return pending;
	}
	private current(): PlanView | undefined {
		try { return this.store.get(); } catch (error) { if (error instanceof PlanStateError) return undefined; throw error; }
	}
	private refreshUi(): void {
		if (this.stopping || !this.ctx) return;
		const plan = this.current(), ctx = this.ctx;
		const section = planWorkSection(plan, this.store.corruptionReason);
		this.source?.set(section ? { ...section, manage: { label: "Manage plan", run: context => this.manage(context) } } : undefined);
		const view = planPresentation(plan, this.store.corruptionReason);
		const signature = JSON.stringify(view);
		if (!this.remote || signature === this.signature) return;
		this.signature = signature;
		const actions = [...view.actions ?? [], ...(view.data as UiDetails).items?.flatMap(item => item.actions ?? []) ?? []];
		this.remote.publish("plan", view, Object.fromEntries(actions.map(action => [action.id, () => this.action(ctx, action.id, plan)])));
	}
	private async manage(ctx: ExtensionContext): Promise<void> {
		const epoch = this.epoch, plan = this.read(ctx), controls = planControls(plan);
		this.editing++;
		try {
			const choice = await ctx.ui.select("Plan", controls.map(control => control.label));
			const action = controls.find(control => control.label === choice);
			if (action && epoch === this.epoch && !this.stopping) await this.action(ctx, action.id, plan);
		} finally { this.editing--; this.requestDrive(ctx); }
	}
	private async action(ctx: ExtensionContext, action: string, expected?: PlanView): Promise<void> {
		const epoch = this.epoch;
		this.editing++;
		try {
			let mutate: () => unknown;
			if (action === "create" || action === "objective") {
				const objective = await ctx.ui.editor("Plan objective", action === "objective" ? expected?.objective : "");
				if (objective === undefined) return;
				mutate = () => action === "create" ? this.store.create({ objective }) : this.store.edit(ref(expected!), { objective });
			} else if (action === "mode") {
				const choice = await ctx.ui.select("Automatic continuation", ["Off · manual checklist", "On · continue until finished or stopped"]);
				if (!choice) return;
				const autoContinue = choice.startsWith("On");
				let maxRounds = expected!.maxRounds;
				if (autoContinue) {
					const cap = await ctx.ui.editor("Maximum rounds", String(maxRounds || DEFAULT_MAX_PLAN_ROUNDS));
					if (cap === undefined) return;
					maxRounds = Number(cap);
					if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new Error("Round limit must be a positive integer.");
				}
				mutate = () => this.store.edit(ref(expected!), { autoContinue, maxRounds });
			} else if (action === "add" || /^(edit|status|remove):\d+$/.test(action)) {
				const steps = structuredClone(expected!.steps), index = Number(action.split(":")[1]);
				if (action !== "add" && !steps[index]) throw new Error("This step is no longer available.");
				if (action === "add" || action.startsWith("edit:")) {
					const content = await ctx.ui.editor("Plan step", action === "add" ? "" : steps[index]!.content);
					if (content === undefined) return;
					if (action === "add") steps.push({ content, status: "pending" }); else steps[index]!.content = content;
				} else if (action.startsWith("status:")) {
					const chosen = await ctx.ui.select("Step status", STEP_STATUSES.map(status => status.replaceAll("_", " ")));
					if (!chosen) return;
					steps[index]!.status = chosen.replaceAll(" ", "_") as typeof STEP_STATUSES[number];
				} else {
					if (!await ctx.ui.confirm("Remove step?", steps[index]!.content)) return;
					steps.splice(index, 1);
				}
				mutate = () => this.store.edit(ref(expected!), { steps });
			} else {
				if (action === "clear" && !await ctx.ui.confirm("Clear plan?", "Its history stays in this session.")) return;
				mutate = () => action === "clear" ? this.store.clear(ref(expected!))
					: this.control({ plan_id: expected!.id, revision: expected!.revision, action: action as UpdateParams["action"] });
			}
			await this.run(ctx, () => {
				if (epoch !== this.epoch) throw new Error("The session changed.");
				const current = this.store.get();
				if (current?.id !== expected?.id || current?.revision !== expected?.revision) throw new Error("The plan changed. Review it before trying again.");
				mutate(); getWorkCoordinator(ctx.sessionManager.getSessionId())?.cancel("plan-command");
			});
		} finally { this.editing--; this.requestDrive(ctx); }
	}
	private control(params: UpdateParams): PlanView | undefined {
		const planRef = { id: params.plan_id, revision: params.revision }, replacements = definition(params);
		if (params.action !== "edit" && Object.keys(replacements).length) throw new Error("Definition fields are only valid with action edit.");
		if (params.action !== "blocked" && params.blocked_reason !== undefined) throw new Error("blocked_reason is only valid with action blocked.");
		if (params.action === "edit") return this.store.edit(planRef, replacements);
		if (params.action === "pause") return this.store.pause(planRef);
		if (params.action === "resume") return this.store.resume(planRef);
		const current = this.store.get();
		if (!current) throw new Error("No current plan.");
		const automaticRound = this.attempt?.admitted && this.attempt.planId === current.id && this.attempt.round === current.roundsStarted;
		if (params.action === "blocked" && automaticRound && current.roundsStarted < DEFAULT_BLOCKED_AFTER_ROUNDS)
			throw new Error(`Blocked requires at least ${DEFAULT_BLOCKED_AFTER_ROUNDS} consecutive automatic rounds.`);
		const next = params.action === "complete" ? this.store.complete(planRef)
			: this.store.block(planRef, { code: "model-reported", message: params.blocked_reason! });
		if (automaticRound) this.wrapup = renderPlanWrapup(next, params.blocked_reason);
		return next;
	}
	register(): void {
		const guidance = [renderPlanGuidance(DEFAULT_BLOCKED_AFTER_ROUNDS)];
		const call = (title: string, params: { objective?: unknown; steps?: unknown; action?: unknown }, theme: ExtensionContext["ui"]["theme"]) =>
			new Text(theme.fg("toolTitle", title) + [
				typeof params.action === "string" ? params.action : "",
				typeof params.objective === "string" ? safeWorkText(params.objective).slice(0, 120) : "",
				Array.isArray(params.steps) ? `${params.steps.length} steps` : "",
			].filter(Boolean).map(text => ` · ${safeWorkText(text)}`).join(""), 0, 0);
		const renderer = (response: AgentToolResult<{ plan: PlanView | null }>, options: { expanded: boolean }, theme: ExtensionContext["ui"]["theme"]) => {
			const plan = response.details?.plan;
			const text = plan ? `${plan.phase} · ${stepSummary(plan.steps).completed}/${plan.steps.length} steps · ${plan.autoContinue ? plan.activation : "manual"}`
				+ (options.expanded ? `\n${planWorkSection(plan)!.detail}` : "")
				: plan === null ? "No current plan" : response.content.find(block => block.type === "text")?.text ?? "No current plan";
			return new Text(theme.fg(plan !== undefined ? "toolOutput" : "error", safeWorkText(text, true)), 0, 0);
		};
		this.pi.registerTool({
			name: "get_plan", label: "Get Plan", description: "Read the current branch-local plan, steps, exact id/revision and continuation state.",
			promptGuidelines: guidance, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
			execute: async (_id, _params, _signal, _update, ctx) => this.run(ctx, () => result(this.store.get())),
			renderCall: (_params, theme) => call("Read plan", {}, theme),
			renderResult: renderer,
		});
		this.pi.registerTool({
			name: "create_plan", label: "Create Plan", description: "Create one plan with an objective and steps. Automatic continuation is off unless explicitly enabled.",
			promptGuidelines: guidance, parameters: CreateParameters, prepareArguments: preparePlanArguments, executionMode: "sequential",
			execute: async (_id, params: CreateParams, _signal, _update, ctx) => this.run(ctx, () => result(this.store.create({ ...definition(params), objective: params.objective }))),
			renderCall: (params, theme) => call("Create plan", params, theme),
			renderResult: renderer,
		});
		this.pi.registerTool({
			name: "update_plan", label: "Update Plan", description: "Update the exact current plan revision. Edit replaces only supplied fields; steps replaces the whole list. Continuation remains optional.",
			promptGuidelines: guidance, parameters: UpdateParameters, prepareArguments: preparePlanArguments, executionMode: "sequential",
			execute: async (_id, params: UpdateParams, _signal, _update, ctx) => this.run(ctx, () => result(this.control(params))),
			renderCall: (params, theme) => call("Update plan", params, theme),
			renderResult: renderer,
		});
		this.pi.registerCommand("plan", {
			description: "View or manage the plan; /plan <objective> creates a manual plan",
			handler: async (raw, ctx) => {
				const args = raw.trim();
				if (!args) {
					this.read(ctx); this.refreshUi();
					if (this.remote) this.remote.open("plan");
					else if (ctx.hasUI) { if (this.current()) await this.work.open(ctx, "plan"); else await this.manage(ctx); }
					else this.pi.appendEntry(PLAN_COMMAND_ENTRY, { text: this.current() ? planWorkSection(this.current())!.detail : "No current plan." });
					return;
				}
				await this.run(ctx, () => {
					const current = this.store.get();
					if (["pause", "resume", "clear", "complete"].includes(args)) {
						if (!current) throw new Error("No current plan.");
						if (args === "clear") this.store.clear(ref(current));
						else this.control({ plan_id: current.id, revision: current.revision, action: args as UpdateParams["action"] });
					} else if (args === "auto on" || args === "auto off") {
						if (!current) throw new Error("No current plan.");
						this.store.edit(ref(current), { autoContinue: args === "auto on" });
					} else this.store.create({ objective: args });
					getWorkCoordinator(ctx.sessionManager.getSessionId())?.cancel("plan-command");
					this.pi.appendEntry(PLAN_COMMAND_ENTRY, { text: this.current() ? planWorkSection(this.current())!.detail : "Plan cleared." });
				});
			},
		});
		this.pi.registerEntryRenderer(PLAN_COMMAND_ENTRY, entry => new Text(safeWorkText((entry.data as { text: string }).text, true), 0, 0));
		this.pi.registerMessageRenderer(PLAN_ROUND_MESSAGE, (message, options) => {
			try {
				const details = decodePlanRoundDetails(message.details);
				const content = typeof message.content === "string" ? message.content : "";
				return new Text(safeWorkText(options.expanded ? content : `Plan round ${details.round}\n${content.split("\n")[1] ?? ""}`, true), 0, 0);
			} catch { return undefined; }
		});
		const restore = (ctx: ExtensionContext) => {
			this.epoch++; this.ctx = ctx; this.remote = getPresentation(this.pi); this.stopping = false; this.signature = "";
			this.source = this.work.source("plan"); this.attempt = undefined; this.wrapup = undefined; this.lastStop = undefined;
			this.store.restore(ctx.sessionManager.getBranch()); this.refreshUi();
		};
		this.pi.on("session_start", (_event, ctx) => restore(ctx));
		this.pi.on("session_tree", (_event, ctx) => restore(ctx));
		this.pi.on("session_shutdown", () => {
			this.epoch++; this.stopping = true; this.requested = false; this.attempt = undefined; this.wrapup = undefined;
			this.store.disarm(); this.remote?.publish("plan", undefined); this.remote = undefined; this.ctx = undefined;
			this.source?.dispose(); this.source = undefined;
		});
		this.pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "custom" || event.message.customType !== PLAN_ROUND_MESSAGE) return;
			const message = event.message;
			await this.run(ctx, () => {
				try {
					const details = decodePlanRoundDetails(message.details), attempt = this.attempt;
					if (!attempt || details.planId !== attempt.planId || details.revision !== attempt.revision
						|| details.round !== attempt.round || message.content !== attempt.content) return;
					if (!branchContainsRound(ctx.sessionManager.getBranch(), attempt)) this.store.admitRound(attempt, attempt.content);
					attempt.admitted = true;
				} catch { this.store.disarm(); }
			});
		});
		this.pi.on("context", event => this.wrapup === undefined ? undefined : ({
			messages: [...event.messages, { role: "user" as const, content: [{ type: "text" as const, text: this.wrapup }], timestamp: Date.now() }],
		}));
		this.pi.on("agent_end", event => { this.lastStop = stopReason(event.messages); });
		this.pi.on("agent_settled", (_event, ctx) => {
			if (this.stopping) return;
			this.store.reconcile(ctx.sessionManager.getBranch());
			const attempt = this.attempt, plan = this.current();
			if (attempt) {
				try { attempt.admitted ||= branchContainsRound(ctx.sessionManager.getBranch(), attempt); } catch { this.store.disarm(); }
				if (!attempt.admitted) this.store.disarm();
				else if (plan?.id === attempt.planId && plan.phase === "active" && plan.activation === "armed") {
					if (this.lastStop === "aborted") { try { this.store.pause(ref(plan)); } catch { this.store.disarm(); } }
					else if (this.lastStop === "error" || this.lastStop === "length") this.store.disarm();
				}
			} else if (["aborted", "error", "length"].includes(this.lastStop ?? "")) this.store.disarm();
			this.attempt = undefined; this.wrapup = undefined; this.lastStop = undefined;
			this.refreshUi(); this.requestDrive(ctx);
		});
	}
	private requestDrive(ctx: ExtensionContext): void {
		if (this.stopping || !this.topLevel) return;
		this.requested = true;
		if (this.driving) return;
		this.driving = true;
		try { while (this.requested && !this.stopping) { this.requested = false; this.drive(ctx); } }
		finally { this.driving = false; }
	}
	private drive(ctx: ExtensionContext): void {
		if (this.editing || getWorkCoordinator(ctx.sessionManager.getSessionId())?.blocked
			|| !ctx.isIdle() || ctx.hasPendingMessages() || this.attempt || this.remote?.suspended) return;
		this.store.reconcile(ctx.sessionManager.getBranch());
		const plan = this.current();
		if (!plan?.autoContinue || plan.phase !== "active" || plan.activation !== "armed") return;
		if (plan.roundsStarted >= plan.maxRounds) {
			this.store.block(ref(plan), { code: "round-limit", message: `Plan reached its configured limit of ${plan.maxRounds} rounds.` });
			this.refreshUi(); return;
		}
		const round = plan.roundsStarted + 1, content = renderPlanRoundPrompt(plan, round);
		const attempt: Attempt = { planId: plan.id, revision: plan.revision, round, content, admitted: false };
		this.attempt = attempt;
		try {
			this.pi.sendMessage({ customType: PLAN_ROUND_MESSAGE, content, display: true,
				details: { version: 1, planId: plan.id, revision: plan.revision, round } }, { deliverAs: "followUp", triggerTurn: true });
		} catch (error) {
			this.attempt = undefined;
			const current = this.current();
			if (current?.id === plan.id && current.revision === plan.revision && current.phase === "active" && current.activation === "armed")
				this.store.block(ref(current), { code: "queue-failed", message: `Could not queue plan round ${round}: ${String(error)}` });
			this.refreshUi();
		}
	}
}

export default function planExtension(pi: ExtensionAPI): void {
	ensureWorkCoordination(pi);
	new PlanController(pi).register();
}

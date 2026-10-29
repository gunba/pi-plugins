import type { AgentToolResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ensureWorkCoordination, isManagedChild } from "../../pi-work-coordination/index.ts";
import { activeWatches, WATCH_CHANGED } from "../../pi-watch/index.ts";
import { ensureWorkUi, safeWorkText, type WorkUiSource } from "../../pi-work-ui/index.ts";
import { planWorkSection } from "../../pi-work-ui/sections.ts";
import { getPresentation, type Presentation, type UiDetails } from "../../pi-ui/index.ts";
import { PlanStore, PlanStateError } from "../src/store.ts";
import { DEFAULT_BLOCKED_AFTER_ROUNDS, DEFAULT_MAX_PLAN_ROUNDS, PLAN_COMMAND_ENTRY, PLAN_ROUND_MESSAGE } from "../src/constants.ts";
import { type PlanRef, type PlanRoundIdentity, type PlanView } from "../src/domain.ts";
import { branchContainsRound, decodePlanRoundDetails } from "../src/replay.ts";
import { PLAN_CHECK_EVERY, renderPlanCheck, renderPlanGuidance, renderPlanRoundPrompt, renderPlanWrapup } from "../src/prompt.ts";
import { CreateParameters, UpdateParameters, definition, preparePlanArguments, type CreateParams, type UpdateParams } from "../src/tools.ts";
import { planControls, planPresentation } from "../src/presentation.ts";
import { STEP_STATUSES, stepSummary } from "../src/steps.ts";

interface Attempt extends PlanRoundIdentity { content: string; admitted: boolean }
const ref = (plan: PlanView): PlanRef => ({ id: plan.id, revision: plan.revision });
const seenKey = (plan: { id: string; revision: number } | null | undefined) => plan ? `${plan.id}:${plan.revision}` : "";
/**
 * Other plugins read the current plan by emitting this on the extension event bus with a probe object: probe.plan is
 * then the plan, or null when there is none, and stays unset in a session that is shutting down.
 */
export const PLAN_READ = "pi-plan/read-v1";
/** Calling either shows or changes the plan, so the count of calls without an update starts again. */
const PLAN_TOOL_NAMES = new Set(["create_plan", "update_plan"]);
/** Tools whose results showed the model the plan, including get_plan in earlier histories. */
const PLAN_SHOWN_BY = new Set(["get_plan", "create_plan", "update_plan"]);

/** The plan the model last saw in a plan tool's result, in this branch. */
function lastShownPlan(branch: readonly SessionEntry[]): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || !PLAN_SHOWN_BY.has(entry.message.toolName)) continue;
		const plan = (entry.message.details as { plan?: { id: string; revision: number } | null } | undefined)?.plan;
		if (plan !== undefined) return seenKey(plan);
	}
	return "";
}
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
	/** The model's own tool calls since the active plan last changed, and which plan revision that was ("" when none is active). */
	private sinceUpdate = 0;
	private seen = "";
	/** The plan revision the model last saw, as seenKey gives it; "" when it has seen none. */
	private modelSeen = "";
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
					: this.control({ action: action as UpdateParams["action"] }, ref(expected!));
			}
			await this.run(ctx, () => {
				if (epoch !== this.epoch) throw new Error("The session changed.");
				const current = this.store.get();
				if (current?.id !== expected?.id || current?.revision !== expected?.revision) throw new Error("The plan changed. Review it before trying again.");
				mutate();
			});
		} finally { this.editing--; this.requestDrive(ctx); }
	}
	/**
	 * The model's update, applied to the current plan. One that would replace the objective or steps is refused once,
	 * with the current plan, when the plan changed since the model last saw it (in Desk, say), so the model cannot
	 * overwrite a change it has not seen.
	 */
	private update(params: UpdateParams): PlanView | undefined {
		const current = this.store.get();
		if (!current) throw new Error("There is no current plan; create one with create_plan.");
		if ((params.objective !== undefined || params.steps !== undefined) && this.modelSeen !== seenKey(current)) {
			this.modelSeen = seenKey(current);
			throw new Error(`The plan changed since you last saw it, so nothing was applied. It is now: ${JSON.stringify(current)}. `
				+ "Send the update again if it still applies.");
		}
		// A revision this call makes is the model's own, even when a later part of the call fails (complete with steps
		// applies the steps first), so it has not changed behind the model's back.
		try { return this.control(params, ref(current)); }
		finally { const after = this.current(); if (seenKey(after) !== seenKey(current)) this.modelSeen = seenKey(after); }
	}
	/** The plan a tool returns to the model, which has now seen it. */
	private shown(plan: PlanView | undefined) {
		this.modelSeen = seenKey(plan);
		return result(plan);
	}
	private control(params: UpdateParams, planRef: PlanRef): PlanView | undefined {
		const replacements = definition(params);
		// Definition fields sent with another action (complete with the final steps, say) are applied first, in one call.
		if (params.action !== "edit" && Object.keys(replacements).length) {
			const edited = this.store.edit(planRef, replacements);
			planRef = { id: edited.id, revision: edited.revision };
		}
		if (params.action !== "blocked" && params.blocked_reason !== undefined) throw new Error("blocked_reason is only valid with action blocked.");
		// An edit that changes nothing is how models look at the plan (there is no read tool): it returns the plan.
		if (params.action === "edit" && !Object.keys(replacements).length) return this.store.get();
		if (params.action === "edit") return this.store.edit(planRef, replacements);
		if (params.action === "pause") return this.store.pause(planRef);
		if (params.action === "resume") {
			const current = this.store.get();
			// Resuming a plan that is already running changes nothing.
			if (current?.phase === "active" && (!current.autoContinue || current.activation === "armed")) return current;
			return this.store.resume(planRef);
		}
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
			name: "create_plan", label: "Create Plan", description: "Create the plan: an objective and steps.",
			promptGuidelines: guidance, parameters: CreateParameters, prepareArguments: preparePlanArguments, executionMode: "sequential",
			execute: async (_id, params: CreateParams, _signal, _update, ctx) => this.run(ctx, () => this.shown(this.store.create({ ...definition(params), objective: params.objective }))),
			renderCall: (params, theme) => call("Create plan", params, theme),
			renderResult: renderer,
		});
		this.pi.registerTool({
			name: "update_plan", label: "Update Plan", description: "Change the current plan: edit replaces the fields given; pause, resume, complete or blocked change its state.",
			promptGuidelines: guidance, parameters: UpdateParameters, prepareArguments: preparePlanArguments, executionMode: "sequential",
			execute: async (_id, params: UpdateParams, _signal, _update, ctx) => this.run(ctx, () => this.shown(this.update(params))),
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
						else this.control({ action: args as UpdateParams["action"] }, ref(current));
					} else if (args === "auto on" || args === "auto off") {
						if (!current) throw new Error("No current plan.");
						this.store.edit(ref(current), { autoContinue: args === "auto on" });
					} else this.store.create({ objective: args });
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
			this.sinceUpdate = 0; this.seen = ""; this.modelSeen = lastShownPlan(ctx.sessionManager.getBranch());
			this.store.restore(ctx.sessionManager.getBranch()); this.refreshUi();
		};
		this.pi.on("session_start", (_event, ctx) => restore(ctx));
		this.pi.events.on(PLAN_READ, probe => {
			const ctx = this.ctx;
			if (!ctx || this.stopping || !probe || typeof probe !== "object") return;
			try { (probe as { plan?: PlanView | null }).plan = this.read(ctx) ?? null; } catch { /* unreadable: leave it unset */ }
		});
		this.pi.events.on(WATCH_CHANGED, value => {
			const ctx = this.ctx, change = value as { sessionId?: string; count?: number };
			if (ctx && change.count === 0 && change.sessionId === ctx.sessionManager.getSessionId()) this.requestDrive(ctx);
		});
		this.pi.on("session_tree", (_event, ctx) => restore(ctx));
		this.pi.on("session_shutdown", () => {
			this.epoch++; this.stopping = true; this.requested = false; this.attempt = undefined; this.wrapup = undefined;
			this.store.disarm(); this.remote?.publish("plan", undefined); this.remote = undefined; this.ctx = undefined;
			this.source?.dispose(); this.source = undefined;
		});
		this.pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "custom" || event.message.customType !== PLAN_ROUND_MESSAGE) return;
			const message = event.message;
			// A round's prompt states the plan, as a check would.
			this.sinceUpdate = 0;
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
		// In long conversations the plan falls behind the work: nothing but the model's own earlier plan calls shows it
		// the plan, and those recede. An active plan untouched for PLAN_CHECK_EVERY of the model's own tool calls gets a
		// short reminder at the end of the next result, and again every PLAN_CHECK_EVERY calls while it stays untouched.
		// Only that new result changes, so earlier context and the prompt cache are left as they were.
		this.pi.on("tool_result", event => {
			// Calls a script made (codemode) go back to the script, not the model.
			if (event.parentToolCallId || this.stopping) return;
			const plan = this.current(), key = plan?.phase === "active" ? `${plan.id}:${plan.revision}` : "";
			// A plan changed some other way (Desk's plan controls, say) counts from that change; this call is the first since.
			if (key !== this.seen) { this.seen = key; this.sinceUpdate = 0; }
			if (!plan || !key || PLAN_TOOL_NAMES.has(event.toolName)) { this.sinceUpdate = 0; return; }
			if (++this.sinceUpdate % PLAN_CHECK_EVERY) return;
			return { content: [...event.content, { type: "text" as const, text: `\n${renderPlanCheck(plan, this.sinceUpdate)}` }],
				// Replacing the content alone would drop a result's structured form.
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) };
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
		// A conversation that is watching for something is waiting on purpose; its watch wakes it.
		if (this.editing || activeWatches(ctx.sessionManager.getSessionId())
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

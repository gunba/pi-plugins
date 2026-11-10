import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { SIDE_REQUEST_HEADER } from "../../pi-compaction-context/extensions/brief.ts";
import { cacheExpired } from "../../pi-context-window/prompt-cache.ts";
import { SessionArchive, withPayload } from "../../pi-session-memory/extensions/archive.ts";
import { getPresentation, type Presentation, type UiAction, type UiValue, type UiView } from "../../pi-ui/index.ts";
import { isManagedChild } from "../../pi-work-coordination/index.ts";
import { CHANGE_ENTRY, PUBLISHED_ENTRY, applyChange, emptyState, foldBranch, lastPublished, live, normal, quotes,
	type Actor, type Change, type Draft, type Op, type State } from "../src/domain.ts";
import { handbookReader } from "../src/peers.ts";
import { SECTION_TAG, fullText, sectionText, viewData } from "../src/render.ts";
import { TIDY_SYSTEM, WINDOW_CHARS, collectWindow, commitOps, parseReply, planReply, textOf, tidyRequest } from "../src/tidy.ts";

/** Quiet time after the conversation settles before a tidy-up. */
const IDLE_MS = 10 * 60_000;
/** Tidy-ups run about daily, except while a backlog of messages is left. */
const PASS_EVERY_MS = 20 * 3_600_000;
/** After a failed tidy-up, the next automatic one waits this long. */
const RETRY_MS = 3_600_000;
/** Backlog passes follow each other while the conversation stays idle. */
const NEXT_CHUNK_MS = 15_000;
/**
 * A model that takes system messages mid-conversation gets the agent's and the tidy-up's changes at most this often,
 * between cache breaks: each patch appends a copy of the whole section to the conversation, and until a compaction
 * the agent still has the messages those changes came from.
 */
const PATCH_EVERY_MS = 4 * 3_600_000;
/** With no known cache lifetime, a conversation idle this long is taken to have lost its cache. */
const COLD_MS = 6 * 3_600_000;

const Parameters = Type.Object({
	action: Type.Enum(["add", "flag", "purpose", "read"] as const, { type: "string" }),
	kind: Type.Optional(Type.Enum(["instruction", "learning"] as const, { type: "string" })),
	text: Type.Optional(Type.String({ description: "add: the learning, or what an instruction is about; flag: why the entry is wrong or out of date; purpose: the purpose." })),
	quote: Type.Optional(Type.String({ description: "add instruction: the user's exact words for this one instruction, copied from their message: the sentence or part of one that carries it." })),
	holds_while: Type.Optional(Type.String({ description: "The conditions the entry rests on." })),
	points_to: Type.Optional(Type.Array(Type.String(), { description: "Files or addresses the entry refers to." })),
	id: Type.Optional(Type.String({ description: "flag: the entry's ID, such as i3 or l2." })),
	agent: Type.Optional(Type.String({ description: "read: another agent's handbook, by its name or ID from agent_list, on any of the user's computers." })),
}, { additionalProperties: false });
type Params = Static<typeof Parameters>;

const GUIDELINE = "When the user gives an instruction meant to last beyond the current task, or the work shows something that would change "
	+ "how a future task of this kind should be done, add it with the handbook tool. Not for task status, one-off details, tool "
	+ "failures or facts about the user.";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a pass's checks refused, for the change log: the first few, and how many more. */
const refusals = (refused: readonly string[]) => {
	const shown = refused.slice(0, 5).map(item => item.length > 160 ? item.slice(0, 159) + "…" : item);
	return "Not applied: " + shown.join("; ") + (refused.length > shown.length ? "; and " + (refused.length - shown.length) + " more" : "");
};
const userText = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "user" ? textOf(entry.message.content) : "";

class Handbook {
	private readonly pi: ExtensionAPI;
	private readonly topLevel: boolean;
	private ctx?: ExtensionContext;
	private remote?: Presentation;
	private state: State = emptyState();
	/** The section text the model has, and when it was given. */
	private published?: string;
	private publishedAt = 0;
	private compacted = false;
	/** The user changed the handbook since it was last given to the model: their change goes in at the next turn. */
	private userChanged = false;
	private stopping = true;
	private epoch = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private abort?: AbortController;
	private running?: string;
	private error?: string;
	private failedAt = 0;
	/** A pass's changes, waiting for the conversation to be idle. */
	private queued?: { ops: Op[]; epoch: number };
	/** Whether the session had no messages from the user when it started, and its last entry then. */
	private fresh = false;
	private startLeaf: string | null = null;
	private archive?: SessionArchive;
	private signature = "";

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.topLevel = !process.env.PI_SUBAGENT_TASK_PATH && !isManagedChild(pi);
	}

	private full(entry: SessionEntry): SessionEntry {
		const file = this.ctx?.sessionManager.getSessionFile();
		if (file && this.archive?.file !== file) this.archive = new SessionArchive(file);
		return withPayload(entry, file ? this.archive : undefined);
	}

	/** Saves operations as one change. The first change records where reading began. */
	private write(actor: Actor, ops: readonly Op[]): Op[] {
		if (!this.ctx || this.stopping) throw new Error("This conversation is changing. Try again when it is ready.");
		const start: Op[] = this.state.from === undefined ? [{ op: "start", from: this.fresh ? null : this.startLeaf }] : [];
		const all = [...start, ...commitOps(this.state, ops, actor)];
		if (!all.length) return all;
		const change: Change = { v: 1, at: Date.now(), actor, ops: all };
		this.pi.appendEntry(CHANGE_ENTRY, change);
		applyChange(this.state, change);
		if (actor === "user") this.userChanged = true;
		this.refresh();
		return all;
	}

	private restore(ctx: ExtensionContext): void {
		this.epoch++; this.stopping = false; this.ctx = ctx; this.remote = getPresentation(this.pi); this.signature = "";
		this.abort?.abort(); this.abort = undefined; this.running = undefined; this.queued = undefined; this.error = undefined;
		const branch = ctx.sessionManager.getBranch();
		this.state = foldBranch(branch);
		this.published = lastPublished(branch);
		const entry = [...branch].reverse().find(item => item.type === "custom" && item.customType === PUBLISHED_ENTRY);
		this.publishedAt = entry ? Date.parse(entry.timestamp) || 0 : 0;
		this.fresh = !branch.some(item => item.type === "message" && item.message.role === "user");
		this.startLeaf = ctx.sessionManager.getLeafId() ?? null;
		this.refresh();
		this.schedule(IDLE_MS);
	}

	private stop(): void {
		this.epoch++; this.stopping = true; clearTimeout(this.timer); this.timer = undefined;
		this.abort?.abort(); this.abort = undefined; this.queued = undefined;
		this.remote?.publish("handbook", undefined); this.remote = undefined; this.ctx = undefined;
	}

	/** Whether a changed section may go to the model now without costing the conversation its prompt cache. */
	private mayPublish(ctx: ExtensionContext): boolean {
		if (this.compacted) return true;
		const branch = ctx.sessionManager.getBranch(), model = ctx.model as ({ provider: string; promptCache?: { short?: number; long?: number };
			compat?: { supportsMidConvoSystemMessages?: boolean } } | undefined);
		if (cacheExpired(model, branch as never)) return true;
		let last = 0;
		for (let index = branch.length - 1; index >= 0 && !last; index--) {
			const entry = branch[index]!;
			if (entry.type === "message" && entry.message.role === "assistant") last = entry.message.timestamp ?? Date.parse(entry.timestamp);
		}
		if (!last || Date.now() - last > COLD_MS) return true;
		// The changed section goes in a system message appended to the conversation, which keeps the cached prefix.
		return !!model?.compat?.supportsMidConvoSystemMessages && (this.userChanged || Date.now() - this.publishedAt >= PATCH_EVERY_MS);
	}

	private section(ctx: ExtensionContext): string | undefined {
		const text = sectionText(this.state);
		if (text !== (this.published ?? "") && this.mayPublish(ctx)) {
			this.published = text; this.publishedAt = Date.now(); this.compacted = false; this.userChanged = false;
			this.pi.appendEntry(PUBLISHED_ENTRY, { text });
		}
		return this.published || undefined;
	}

	private schedule(delay: number): void {
		clearTimeout(this.timer); this.timer = undefined;
		if (this.stopping || !this.topLevel) return;
		this.timer = setTimeout(() => { this.timer = undefined; void this.tidy(false); }, delay);
		this.timer.unref?.();
	}

	private covered(): string | null | undefined {
		return this.state.covered !== undefined ? this.state.covered : this.fresh ? null : this.startLeaf;
	}

	/** Reads the user's messages since the last pass and applies what the model proposes, checked. */
	private async tidy(force: boolean): Promise<void> {
		const ctx = this.ctx, epoch = this.epoch;
		if (!ctx || this.stopping || this.running || !this.topLevel || this.remote?.suspended) return;
		if (!force && (!ctx.isIdle() || ctx.hasPendingMessages() || Date.now() - this.failedAt < RETRY_MS)) return;
		const model = ctx.model;
		if (!model) { if (force) { this.error = "This conversation has no model to tidy up with."; this.refresh(); } return; }
		const last = this.state.passes.at(-1);
		if (!force && last && Date.now() - last.at < PASS_EVERY_MS && !last.more) return;
		const window = collectWindow(ctx.sessionManager.getBranch() as never, this.covered(), entry => this.full(entry as SessionEntry) as never);
		const waiting = [...this.state.entries.values()].some(entry => live(entry) && (entry.status === "pending" || !entry.reviewed));
		if (!window.messages.length && !waiting) { if (force) { this.error = "Nothing new to read since the last tidy-up."; this.refresh(); } return; }
		const abort = this.abort = new AbortController();
		this.running = "Reading " + window.messages.length + " message" + (window.messages.length === 1 ? "" : "s"); this.error = undefined;
		this.refresh();
		try {
			const result = await ctx.modelRegistry.complete(model, { systemPrompt: TIDY_SYSTEM,
				messages: [{ role: "user", content: tidyRequest(this.state, window, ctx.cwd), timestamp: Date.now() }] },
				{ signal: abort.signal, headers: { [SIDE_REQUEST_HEADER]: "1" }, maxTokens: 16_000 } as never);
			if (epoch !== this.epoch || this.stopping || abort.signal.aborted) return;
			if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "The model request failed.");
			const plan = planReply(this.state, window, parseReply(textOf(result.content)), ctx.cwd);
			this.queued = { epoch, ops: [...plan.ops, ...(window.through ? [{ op: "cover", through: window.through } as Op] : []),
				{ op: "pass", model: result.provider + "/" + result.model, cost: result.usage?.cost?.total ?? 0, messages: window.messages.length,
					...(window.more ? { more: true } : {}), ...(plan.refused.length ? { reason: refusals(plan.refused) } : {}) }] };
			this.failedAt = 0;
		} catch (error) {
			if (epoch !== this.epoch || this.stopping || abort.signal.aborted) return;
			this.error = "Tidy-up failed: " + message(error); this.failedAt = Date.now();
		} finally {
			if (this.abort === abort) this.abort = undefined;
			if (epoch === this.epoch) { this.running = undefined; this.commit(); this.refresh(); }
		}
	}

	/** Saves a finished pass once nothing else is running, so its entries never land inside a turn. */
	private commit(): void {
		const ctx = this.ctx, queued = this.queued;
		if (!ctx || !queued || queued.epoch !== this.epoch || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		this.queued = undefined;
		try { this.write("tidy", queued.ops); } catch (error) { this.error = "The tidy-up's changes could not be saved: " + message(error); this.refresh(); return; }
		if (queued.ops.some(op => op.op === "pass" && op.more)) this.schedule(NEXT_CHUNK_MS);
	}

	private findQuote(quote: string): SessionEntry | undefined {
		const branch = this.ctx!.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "message" && entry.message.role === "user" && quotes(userText(this.full(entry)), quote)) return entry;
		}
	}

	private async tool(params: Params, signal?: AbortSignal): Promise<string> {
		const state = this.state, text = params.text?.trim();
		if (params.action === "read" && params.agent?.trim()) {
			const read = handbookReader();
			if (!read) throw new Error("Other agents' handbooks can be read only in Desk, with agent messaging loaded.");
			return await read(params.agent.trim(), signal);
		}
		if (params.action === "read") return fullText(state);
		if (params.action === "purpose") {
			if (!text) throw new Error("Give the purpose as text.");
			const had = !!state.purpose;
			this.write("agent", [{ op: "purpose", text }]);
			return had ? "Purpose changed. The user can restore the earlier wording from the Handbook view." : "Purpose saved.";
		}
		if (params.action === "flag") {
			const entry = params.id ? state.entries.get(params.id.trim()) : undefined;
			if (!entry || !live(entry)) throw new Error("No current entry " + JSON.stringify(params.id ?? "") + ".");
			if (!text) throw new Error("Say in text why the entry is wrong or out of date.");
			this.write("agent", [{ op: "flag", id: entry.id, reason: text }]);
			return "Flagged " + entry.id + " for review.";
		}
		const extra = { ...(params.holds_while?.trim() ? { holdsWhile: params.holds_while.trim() } : {}),
			...(params.points_to?.length ? { pointsTo: params.points_to.map(item => item.trim()).filter(Boolean).slice(0, 8) } : {}) };
		if (params.kind === "instruction") {
			const quote = params.quote?.trim();
			if (!quote) throw new Error("An instruction needs quote: the user's exact words.");
			const words = normal(quote), quoting = [...state.entries.values()].filter(entry => live(entry) && entry.kind === "instruction" && entry.quote);
			const same = quoting.find(entry => normal(entry.quote!) === words || words.includes(normal(entry.quote!)));
			if (same) return same.id + " already quotes " + (normal(same.quote!) === words ? "those words" : "part of them")
				+ ". If this is a different instruction, quote only the words that carry it.";
			const source = this.findQuote(quote);
			if (!source) throw new Error("That quote is not in the user's messages. Copy their exact words, whole.");
			// Narrower words from an entry the agent itself just added (one quote holding two instructions, say) take its place.
			const wider = quoting.filter(entry => normal(entry.quote!).includes(words) && entry.addedBy === "agent" && !entry.reviewed && !entry.pinned);
			const entry: Draft = { kind: "instruction", text: text ?? "", quote, sources: [source.id], sourceAt: Date.parse(source.timestamp) || Date.now(), ...extra };
			const saved = this.write("agent", [{ op: "add", id: "+1", entry, status: "active" },
				...wider.map(old => ({ op: "end", id: old.id, status: "replaced", by: "+1", reason: "A narrower quote of the same message" } as Op))]);
			const id = (saved.find(op => op.op === "add") as { id: string }).id;
			return "Added " + id + (wider.length ? " in place of " + wider.map(old => old.id).join(" and ") + ", which quoted more of the message; add any other instruction "
				+ (wider.length === 1 ? "it" : "they") + " held the same way" : "") + ". It reaches the handbook section at the next prompt update.";
		}
		if (params.kind === "learning") {
			if (!text) throw new Error("A learning needs text.");
			const twin = [...state.entries.values()].find(entry => live(entry) && normal(entry.text) === normal(text));
			if (twin) return "Already in the handbook as " + twin.id + ".";
			const leaf = this.ctx!.sessionManager.getLeafId();
			const entry: Draft = { kind: "learning", text, sources: leaf ? [leaf] : [], sourceAt: Date.now(), ...extra };
			const [added] = this.write("agent", [{ op: "add", id: "+1", entry, status: "pending" }]).filter(op => op.op === "add");
			return "Noted " + (added as { id: string }).id + " for the next tidy-up, which admits or turns it down.";
		}
		throw new Error("add needs kind: instruction or learning.");
	}

	private refresh(): void {
		const ctx = this.ctx;
		if (!ctx || !this.remote || this.stopping || !this.topLevel) return;
		const state = this.state, entries = [...state.entries.values()];
		const active = entries.filter(entry => entry.status === "active"), waiting = entries.filter(entry => entry.status === "pending").length;
		const instructions = active.filter(entry => entry.kind === "instruction").length;
		const data = viewData(state, {
			...(this.running ? { running: this.running } : {}), ...(this.error ? { error: this.error } : {}),
			...(state.passes.at(-1) ? { nextPass: state.passes.at(-1)!.at + PASS_EVERY_MS } : {}),
			...(ctx.model ? { model: ctx.model.provider + "/" + ctx.model.id } : {}),
			unread: typeof state.from === "string" || state.from === undefined && !this.fresh,
			sectionChars: sectionText(state).length,
		}, ctx.cwd);
		const actions: UiAction[] = [
			{ id: "tidy", label: "Tidy up now" }, { id: "add", label: "Add an instruction" }, { id: "purpose", label: "Edit the purpose" },
			...(data.status.unread ? [{ id: "history", label: "Read earlier messages" }] : []),
			...(state.proposedPurpose ? [{ id: "purpose-accept", label: "Use the proposed purpose" }, { id: "purpose-dismiss", label: "Keep the purpose" }] : []),
			...(state.log.some(item => item.was) ? [{ id: "purpose-restore", label: "Restore an earlier purpose" }] : []),
			{ id: "entry", label: "Change an entry" },
		];
		const view: UiView = { kind: "handbook", title: "Handbook", data: data as unknown as UiValue, actions,
			badges: [{ label: "Handbook", value: String(active.length), icon: "book",
				description: "Handbook: " + instructions + " instruction" + (instructions === 1 ? "" : "s") + ", " + (active.length - instructions)
					+ " learning" + (active.length - instructions === 1 ? "" : "s") + (waiting ? ", " + waiting + " waiting for the tidy-up" : "") }] };
		const signature = JSON.stringify(view);
		if (signature === this.signature) return;
		this.signature = signature;
		this.remote.publish("handbook", view, {
			tidy: () => { void this.tidy(true); },
			add: () => this.act(ctx, "add"), purpose: () => this.act(ctx, "purpose"), history: () => this.act(ctx, "history"),
			"purpose-accept": () => this.act(ctx, "purpose-accept"), "purpose-dismiss": () => this.act(ctx, "purpose-dismiss"),
			"purpose-restore": value => this.act(ctx, "purpose-restore", value),
			entry: value => this.act(ctx, "entry", value),
		});
	}

	/** The user's own changes, from Desk's view. */
	private async act(ctx: ExtensionContext, action: string, value?: UiValue): Promise<void> {
		const state = this.state, epoch = this.epoch;
		const save = (ops: Op[]) => { if (epoch !== this.epoch) throw new Error("The conversation changed."); this.write("user", ops); };
		if (action === "add") {
			const quote = (await ctx.ui.editor("An instruction for this conversation, in your words", ""))?.trim();
			if (quote) save([{ op: "add", id: "+1", entry: { kind: "instruction", text: "", quote, sources: [], sourceAt: Date.now() }, status: "active" }]);
		} else if (action === "purpose") {
			const text = (await ctx.ui.editor("What this conversation is for, and what it is not for", state.purpose?.text ?? ""))?.trim();
			if (text) save([{ op: "purpose", text }]);
		} else if (action === "purpose-accept") {
			if (state.proposedPurpose) save([{ op: "purpose", text: state.proposedPurpose.text }]);
		} else if (action === "purpose-dismiss") save([{ op: "dismiss-purpose" }]);
		else if (action === "purpose-restore") {
			// Only a wording the purpose once had: the view sends the one beside the change that replaced it.
			const text = typeof value === "string" ? value.trim() : "";
			if (text && state.log.some(item => item.was === text)) save([{ op: "purpose", text, reason: "Restored an earlier wording" }]);
		}
		else if (action === "history") {
			const branch = ctx.sessionManager.getBranch(), end = typeof state.from === "string" ? branch.findIndex(entry => entry.id === state.from) : branch.length;
			let chars = 0, count = 0;
			for (const entry of branch.slice(0, end < 0 ? branch.length : end + 1)) {
				const text = userText(this.full(entry));
				if (text.trim()) { chars += Math.min(text.length, 4_600); count++; }
			}
			const passes = Math.max(1, Math.ceil(chars / WINDOW_CHARS)), model = ctx.model;
			const price = model?.cost ? ((chars / 3.5 + passes * 6_000) * model.cost.input + passes * 3_000 * model.cost.output) / 1e6 : undefined;
			const ok = await ctx.ui.confirm("Read this conversation's earlier messages?", "The tidy-up reads your " + count + " earlier message"
				+ (count === 1 ? "" : "s") + " in about " + passes + " pass" + (passes === 1 ? "" : "es") + (model ? " with " + model.provider + "/" + model.id : "")
				+ (price !== undefined ? ", about $" + price.toFixed(2) + " at API prices" : "") + ". It runs while the conversation is idle and adds what lasts to the handbook.");
			if (ok) { save([{ op: "cover", through: null, reason: "Reading the earlier messages" }]); this.schedule(NEXT_CHUNK_MS); }
		} else if (action === "entry") {
			const request = value && typeof value === "object" && !Array.isArray(value) ? value as { id?: unknown; act?: unknown } : {};
			const entry = typeof request.id === "string" ? state.entries.get(request.id) : undefined;
			if (!entry) throw new Error("That entry is no longer in the handbook.");
			const id = entry.id;
			switch (request.act) {
				case "pin": case "unpin": save([{ op: "pin", id, pinned: request.act === "pin" }]); break;
				case "edit": {
					const instruction = entry.kind === "instruction";
					const text = (await ctx.ui.editor(instruction ? "The instruction, in your words" : "The learning", instruction ? entry.quote ?? entry.text : entry.text))?.trim();
					if (text) save([{ op: "edit", id, ...(instruction ? { quote: text } : { text }) }]);
					break;
				}
				case "remove":
					if (await ctx.ui.confirm("Remove " + id + " from the handbook?", "It stays in the change log.")) save([{ op: "end", id, status: "removed" }]);
					break;
				case "admit": save([{ op: "admit", id }]); break;
				case "reject": save([{ op: "end", id, status: "rejected" }]); break;
				case "keep": save([{ op: "unflag", id }]); break;
				case "accept": {
					const proposal = entry.flag?.proposal;
					if (proposal) save([{ op: "add", id: "+1", entry: proposal, status: "active" }, { op: "end", id, status: "replaced", by: "+1" }]);
					else save([{ op: "end", id, status: entry.kind === "instruction" ? "removed" : "retired" }]);
					break;
				}
				default: throw new Error("Unknown change.");
			}
		} else throw new Error("Unknown action.");
	}

	register(): void {
		if (!this.topLevel) {
			// A helper has no handbook, but it inherits its parent's tools and fails to start without each one, so it gets
			// the tool for reading other agents' handbooks.
			this.pi.registerTool({
				name: "handbook", label: "Handbook",
				description: "Read another agent's handbook (its purpose, the user's instructions and what it learned) with action read and agent. "
					+ "A helper has no handbook of its own.",
				parameters: Parameters, executionMode: "sequential",
				execute: async (_id, params: Params, signal) => {
					if (params.action !== "read" || !params.agent?.trim()) throw new Error("A helper has no handbook of its own: only read with agent works here.");
					return { content: [{ type: "text" as const, text: await this.tool(params, signal) }], details: {} };
				},
				renderCall: (params, theme) => new Text(theme.fg("toolTitle", "Handbook ") + [params.action, params.agent].filter(Boolean).join(" · "), 0, 0),
			});
			return;
		}
		this.pi.registerTool({
			name: "handbook", label: "Handbook",
			description: "This conversation's handbook (shown in <conversation_handbook>): add the user's lasting instruction, quoted exactly, "
				+ "or a learning about doing this conversation's kind of work; flag an entry that is wrong or out of date; write the purpose "
				+ "if there is none; or read the whole handbook, or with agent, another agent's.",
			promptGuidelines: [GUIDELINE], parameters: Parameters, executionMode: "sequential",
			execute: async (_id, params: Params, signal) => ({ content: [{ type: "text" as const, text: await this.tool(params, signal) }], details: {} }),
			renderCall: (params, theme) => new Text(theme.fg("toolTitle", "Handbook ") + [params.action, params.kind, params.id].filter(Boolean).join(" · "), 0, 0),
		});
		this.pi.registerCommand("handbook", {
			description: "Show this conversation's handbook; /handbook tidy reads the messages since the last tidy-up now; /handbook history reads the earlier ones too",
			handler: async (args, ctx) => {
				const command = args.trim();
				if (command === "tidy" || command === "history") {
					if (command === "history") this.write("user", [{ op: "cover", through: null, reason: "Reading the earlier messages" }]);
					// A backlog takes several passes; each saves before the next.
					for (;;) {
						const before = this.state.passes.at(-1)?.at;
						await this.tidy(true);
						const last = this.state.passes.at(-1);
						if (this.error || !last || last.at === before || !last.more) break;
					}
					ctx.ui.notify(this.error ?? fullText(this.state), this.error ? "error" : "info");
				} else if (this.remote) this.remote.open("handbook");
				else ctx.ui.notify(fullText(this.state), "info");
			},
		});
		// The handbook must never stop the conversation: a failure here is reported in the view and the turn goes on.
		const guard = (work: () => void) => { try { work(); } catch (error) { this.error = "Handbook: " + message(error); this.refresh(); } };
		this.pi.on("session_start", (_event, ctx) => guard(() => this.restore(ctx)));
		this.pi.on("session_tree", (_event, ctx) => guard(() => this.restore(ctx)));
		this.pi.on("session_shutdown", () => this.stop());
		this.pi.on("session_compact", () => { this.compacted = true; });
		this.pi.on("before_agent_start", (event, ctx) => guard(() => {
			if (this.stopping) return;
			const text = this.section(ctx);
			if (text) event.systemPromptOptions.sections[SECTION_TAG] = text;
		}));
		this.pi.on("agent_start", () => { clearTimeout(this.timer); this.timer = undefined; });
		this.pi.on("agent_settled", () => guard(() => {
			if (this.stopping) return;
			// Where reading begins is saved after the first turn: a new conversation's first message, or where the handbook
			// arrived in an existing one, so a restart before the first tidy-up neither rereads nor skips messages.
			if (this.state.from === undefined) this.write("tidy", []);
			this.commit(); this.schedule(IDLE_MS);
		}));
	}
}

export default function handbookExtension(pi: ExtensionAPI): void {
	new Handbook(pi).register();
}

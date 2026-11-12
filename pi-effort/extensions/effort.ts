import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEPTH, downAfter, levelBelow, startDown, type Rating, type Work } from "../src/policy.ts";
import { views } from "../src/shared.ts";

/** This conversation's switch and the user's level, so both survive a restart in the middle of a lowered run. */
const STATE = "pi-effort/state-v1";
/** One record per decision, for comparing levels against how the work turned out. */
const LOG = "pi-effort/log-v1";
/** The message that carries a raise into the conversation in the middle of a run. */
export const RAISE_NOTE = "pi-effort/raise";

const CLASSIFIER = "typesafe/jev-latest";
/** A slow classifier must not hold a message back: without an answer the stretch runs at the setting. */
const CLASSIFIER_MS = 2_500;
const DESK_ATTACHMENTS = "\n\nAttached files on the host:\n";
const DICTATED = "(Dictated: speech recognition may have misheard some words.)";

const QUESTIONS = {
	demand: {
		type: "score" as const,
		instructions: "`earlier` holds what one person asked an AI agent earlier in a conversation, oldest first. `message` is what they say now. "
			+ "Read `message` in the light of `earlier`. How much investigation, checking and judgement does the agent now need, "
			+ "compared with the most demanding work asked for in this conversation?",
		criteria: [
			"Almost none: a quick answer, a look-up or one simple step",
			"Some: contained work whose end is clear",
			"As much as the most demanding work in the conversation, or more; or it carries that work on; or it cannot be told",
		],
	},
	short: {
		type: "bool" as const,
		instructions: "Does `message` say that work already done is wrong, incomplete, still broken or misunderstood?",
		criteria: { true: "Yes, a result fell short", false: "No" },
	},
};

interface Settings { auto?: boolean; classifier?: string }
const settingsPath = () => join(getAgentDir(), "pi-effort.json");
function settings(): Settings {
	try { return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings; } catch { return {}; }
}

/** What the user typed: without the file list Desk appends, the dictation notice, or an expanded skill's text. */
function words(text: string): string {
	let own = text.split(DESK_ATTACHMENTS)[0]!.trim();
	if (own.endsWith(DICTATED)) own = own.slice(0, -DICTATED.length).trim();
	const skill = own.startsWith("<skill") ? own.lastIndexOf("</skill>") : -1;
	return skill < 0 ? own : own.slice(skill + "</skill>".length).trim();
}

const cut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)} …`;

/** The user's earlier messages, oldest first: as many of the latest as fit the classifier's attention. */
function earlier(ctx: ExtensionContext): string[] {
	const said: string[] = [];
	let room = 8_000;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0 && room > 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = cut(words(typeof content === "string" ? content
			: content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")), 400);
		if (!text) continue;
		said.unshift(text);
		room -= text.length;
	}
	return said;
}

/** Edits and plans among the calls a turn made. A program's calls are listed on its result. */
function did(results: readonly { toolName: string; isError: boolean; details?: unknown }[]): Pick<Work, "edits" | "planned"> {
	let edits = 0, planned = false;
	for (const result of results) {
		const calls = (result.details as { calls?: { name?: string; status?: string }[] } | undefined)?.calls
			?? [{ name: result.toolName, status: result.isError ? "error" : "ok" }];
		for (const call of calls) {
			if (call.status !== "ok") continue;
			if (call.name === "edit" || call.name === "write") edits++;
			else if (call.name === "create_plan") planned = true;
		}
	}
	return { edits, planned };
}

/**
 * Automatic effort. The user's level is the conversation's level and the most it uses. A stretch of work may start
 * up to two levels lower when what arrived looks lighter than the conversation's hardest work, and climbs back as
 * the run shows its size. Levels change only where a message enters the conversation: the provider applies a new
 * level from such a point and not in the middle of a tool loop, and the prompt cache holds across the change.
 */
export default function effort(pi: ExtensionAPI): void {
	/** This conversation's own switch; undefined follows the computer's default. */
	let choice: boolean | undefined;
	/** The level the user chose. Known once a run has started with automatic effort on. */
	let setting: string | undefined;
	let run: (Work & { down: number }) | undefined;
	/** What the user just sent while the agent was idle, before Pi expands it. */
	let typed: string | undefined;
	/** The start for follow-ups waiting behind the current run. */
	let queued: number | undefined;
	/** Level changes made here whose events are still to come: any other change is the user's. */
	const own: string[] = [];
	let saved = "";

	const on = () => choice ?? settings().auto === true;
	/** Only Claude models change effort inside a conversation without losing the cache. */
	const usable = (ctx: ExtensionContext) => {
		const model = ctx.model as { api?: string; compat?: { supportsMidConvoEffort?: boolean } } | undefined;
		return model?.api === "anthropic-messages" && model.compat?.supportsMidConvoEffort === true;
	};
	const level = (ctx: ExtensionContext, down: number) =>
		levelBelow(setting!, down, ctx.model ? getSupportedThinkingLevels(ctx.model) : []);
	const use = (target: string) => {
		if (pi.getThinkingLevel() === target) return;
		own.push(target);
		pi.setThinkingLevel(target as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		// Pi clamps a level the model lacks, and then reports the level it chose instead.
		if (pi.getThinkingLevel() !== target) own.splice(own.lastIndexOf(target), 1, pi.getThinkingLevel());
	};
	const publish = (ctx: ExtensionContext) => {
		views.set(ctx.sessionManager.getSessionId(), { auto: on() && usable(ctx), usable: usable(ctx), setting: setting ?? pi.getThinkingLevel() });
	};
	const save = () => {
		const state = { ...(choice !== undefined ? { auto: choice } : {}), ...(setting ? { setting } : {}) };
		const text = JSON.stringify(state);
		if (text === saved) return;
		saved = text;
		pi.appendEntry(STATE, state);
	};

	async function rate(ctx: ExtensionContext, message: string): Promise<Rating | undefined> {
		if (!message) return undefined;
		const [provider, ...id] = (settings().classifier ?? CLASSIFIER).split("/");
		const model = ctx.modelRegistry.findOfType("classifier", provider!, id.join("/"));
		if (!model) return undefined;
		try {
			const signals = [AbortSignal.timeout(CLASSIFIER_MS), ...(ctx.signal ? [ctx.signal] : [])];
			const result = await ctx.modelRegistry.classify(model,
				{ state: { earlier: earlier(ctx), message: cut(message, 4_000) }, questions: QUESTIONS }, { signal: AbortSignal.any(signals) });
			const demand = result.stopReason === "stop" ? result.answers.demand : undefined, short = result.answers?.short;
			return demand?.type === "score" && short?.type === "bool" ? { demand: demand.score, short: short.probability } : undefined;
		} catch { return undefined; }
	}

	pi.on("session_start", (_event, ctx) => {
		choice = undefined; setting = undefined; run = undefined; typed = undefined; queued = undefined; own.length = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE) continue;
			const data = entry.data as { auto?: boolean; setting?: string } | undefined;
			choice = data?.auto; setting = data?.setting;
		}
		saved = JSON.stringify({ ...(choice !== undefined ? { auto: choice } : {}), ...(setting ? { setting } : {}) });
		// A restart in the middle of a lowered run leaves the lower level behind.
		if (setting && on() && usable(ctx)) use(setting);
		else setting = undefined;
		publish(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const at = own.indexOf(event.level);
		if (at >= 0) { own.splice(0, at + 1); return; }
		// The user chose this level, or a model change clamped it: it is the setting from here on.
		setting = event.level;
		if (run) run.down = 0;
		save();
		publish(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (run && !usable(ctx)) { run = undefined; if (setting) use(setting); }
		publish(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		typed = undefined;
		if (!on() || !usable(ctx)) return;
		const text = words(event.text);
		if (!event.streamingBehavior) { typed = text; return; }
		if (event.streamingBehavior === "followUp") {
			queued = Math.min(queued ?? DEPTH, startDown(await rate(ctx, text), false));
			return;
		}
		// Steering can only raise the level, and at the setting there is nothing left to ask.
		if (!run || run.down === 0) return;
		const rating = await rate(ctx, text), down = startDown(rating, false);
		if (!run || down >= run.down) return;
		run.down = down;
		use(level(ctx, down));
		pi.appendEntry(LOG, { at: "steer", level: level(ctx, down), down, ...rating });
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const mine = event.messageType === "user" ? typed : undefined, waiting = queued;
		typed = undefined; queued = undefined; run = undefined;
		if (!on() || !usable(ctx)) { publish(ctx); return; }
		setting ??= pi.getThinkingLevel();
		const first = !ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant");
		const rating = mine === undefined ? undefined : await rate(ctx, mine);
		// Nothing of the user's to read (a watch, another agent, a plan round): start low and let the run show its size.
		const down = mine !== undefined ? startDown(rating, first) : first ? 0 : waiting ?? DEPTH;
		run = { down, steps: 0, edits: 0, planned: false };
		use(level(ctx, down));
		save();
		publish(ctx);
		pi.appendEntry(LOG, { at: "start", level: level(ctx, down), setting, down,
			by: mine !== undefined ? "user" : event.messageType === "custom" ? event.message.customType : "extension", ...(first ? { first } : {}), ...rating });
	});

	pi.on("turn_end", (event, ctx) => {
		if (!run || !setting || event.outcome !== "completed") return;
		const done = did(event.toolResults);
		run.steps++; run.edits += done.edits; run.planned ||= done.planned;
		if (!event.toolResults.length) {
			// The run stops here unless a follow-up waits; that message starts a stretch of its own.
			if (queued === undefined || !ctx.hasPendingMessages()) return;
			run = { down: queued, steps: 0, edits: 0, planned: false };
			queued = undefined;
			use(level(ctx, run.down));
			return { entries: [...event.entries, { type: "custom" as const, customType: LOG, data: { at: "follow-up", level: level(ctx, run.down), down: run.down } }] };
		}
		const down = Math.min(run.down, downAfter(run));
		if (down === run.down) return;
		run.down = down;
		const target = level(ctx, down);
		use(target);
		// The provider applies a new level only from a turn with new input, and tool results alone are not that.
		return { entries: [...event.entries,
			{ type: "custom" as const, customType: LOG, data: { at: "climb", level: target, down, steps: run.steps, edits: run.edits, planned: run.planned } },
			{ type: "custom_message" as const, customType: RAISE_NOTE, content: `[Effort raised to ${target}: this work has grown past a quick step.]`, display: false },
		] };
	});

	pi.on("agent_settled", (_event, ctx) => {
		run = undefined; queued = undefined; typed = undefined;
		// Idle, the conversation shows the user's own level.
		if (setting && on() && usable(ctx)) use(setting);
		publish(ctx);
	});

	pi.registerCommand("effort", {
		description: "Automatic effort: /effort on or off for this conversation; /effort default on or off for this computer",
		handler: async (raw, ctx) => {
			const [first, second] = raw.trim().toLowerCase().split(/\s+/);
			const flag = (word: string | undefined) => word === "on" ? true : word === "off" ? false : undefined;
			if (first === "default" && flag(second) !== undefined) {
				writeFileSync(settingsPath(), `${JSON.stringify({ ...settings(), auto: flag(second) }, null, "\t")}\n`);
			} else if (flag(first) !== undefined) {
				choice = flag(first);
			} else if (first === "follow") {
				choice = undefined;
			} else if (first) {
				ctx.ui.notify("Use /effort on, /effort off, /effort follow (use this computer's default), or /effort default on|off.", "error");
				return;
			}
			if (!on() && setting) { run = undefined; use(setting); }
			save();
			publish(ctx);
			const here = choice === undefined ? `follows this computer's default (${settings().auto === true ? "on" : "off"})` : choice ? "on" : "off";
			const now = !on() ? "" : !usable(ctx) ? " It does nothing with this model: only Claude models change effort without losing the prompt cache."
				: ` Work runs at ${setting ?? pi.getThinkingLevel()} or up to ${DEPTH} levels below it, never under medium.`;
			ctx.ui.notify(`Automatic effort for this conversation: ${here}.${now}`, "info");
		},
	});
}

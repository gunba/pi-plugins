// pi-clones — fork the running agent into a background clone that inherits the
// full session context, works one extra task, and alerts main when its result is ready.
//
// A clone is the same agent (same system prompt, conversation, tools, auth) plus
// one appended task — not a context-free "subagent". It runs in-process via the
// Pi SDK, so it shares the parent's model client + auth and can reuse warm
// prompt-cache prefixes, and it boots as a resume of a forked branch so the inherited
// context is frozen (memedit treats resumed entries as context-only).
//
// See DESIGN.md for the full rationale, the spike evidence, and the cost model.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
// Hidden clone session dir: a sibling of the normal sessions dir, never scanned
// by SessionManager.list/listAll, so clones never appear in resume history.
const CLONES_DIR = join(AGENT_DIR, "clones");

const MAX_DEPTH = 2; // root(0) → clone(1) → sub-clone(2); depth 2 cannot fork further
const MAX_CONCURRENT = 4; // live clones per owning session
const CLONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // prune clone session files older than this
const STATUS_POLL_COOLDOWN_MS = 30_000; // discourage context-burning status polling loops

const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const BLOCKED_TOOLS = new Set(["ask_user"]); // no human attends a clone
const CLONE_TOOLS = new Set([
	"clone",
	"clone_status",
	"clone_result",
	"clone_log",
	"clone_stop",
	"clone_continue",
	"clone_dismiss",
]);

const META_TYPE = "pi-clone-meta"; // CustomEntry: depth marker (not sent to LLM)
const ADVICE_TYPE = "pi-clones-advice"; // CustomEntry: "advice shown" marker
const RESULT_TYPE = "pi-clone-result"; // CustomMessage: concise completion alert (full result stays retrievable)

const ADVICE_TEXT =
	"[pi-clones] You can fork yourself into a clone — a background copy with all of your current " +
	"knowledge and context, plus one task you assign. It is you, not a stranger: do not re-explain " +
	"context, just state the new objective and its definition of done. Use clones only for genuinely " +
	'parallel or independently-researchable work (wide reads, investigations, "go find out X while I ' +
	'continue", independent verification). Once you delegate work to a clone, do not repeat that same ' +
	"work yourself; continue only with non-overlapping parent work unless the clone reports a blocker " +
	"or the user redirects you. A clone has no user to ask: if it hits a decision only the human can " +
	"make, it records the blocker in its result and stops — it escalates to you, never to the user. " +
	'Default clones are read-only (safe for parallel research); pass mode:"inherit" only for ' +
	"non-overlapping work that may edit files. Do not poll clone_status after starting background " +
	"clones: wait for completion alerts, continue non-overlapping work, or check status only when " +
	"the user asks, a clone seems stuck, or a meaningful delay has passed. Wait for a completion " +
	"alert or a done/error/stopped status before calling clone_result; use clone_log only to diagnose " +
	"a confusing result. Use clone_dismiss to write off completed clones you no longer need in status " +
	"lists.";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

type CloneState =
	| "starting"
	| "running"
	| "compacting"
	| "done"
	| "error"
	| "stopped";
type CloneToolResult = AgentToolResult<Record<string, unknown>> & {
	isError?: boolean;
};

interface CloneRecord {
	id: string;
	task: string;
	depth: number;
	mode: "read-only" | "inherit";
	state: CloneState;
	background: boolean;
	startedAt: number;
	lastActivityAt: number;
	finishedAt?: number;
	toolCount: number;
	compactions: number;
	tokens: number;
	activity?: string;
	lastText: string;
	error?: string;
	notifiedAt?: number;
	dismissedAt?: number;
	sessionFile?: string;
	// biome-ignore lint: SDK runtime objects, kept loosely typed on purpose.
	session?: any;
	// biome-ignore lint: SDK runtime objects, kept loosely typed on purpose.
	manager?: any;
	unsubscribe?: () => void;
}

// --------------------------------------------------------------------------
// Pure helpers (stateless — safe at module scope)
// --------------------------------------------------------------------------

function shortId(): string {
	return Math.random().toString(16).slice(2, 10);
}

function truncate(s: string, n: number): string {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function safeSnippet(s: string, n: number): string {
	return truncate(s, n).replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
}

function ago(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n: number): string {
	if (!n) return "0";
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

// biome-ignore lint: message blocks are loosely typed across providers.
function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

// biome-ignore lint: messages array is loosely typed across providers.
function lastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			const t = textOf(messages[i]);
			if (t.trim()) return t;
		}
	}
	return "";
}

// Current clone depth of a session = max depth recorded in its branch metas.
function currentDepth(ctx: ExtensionContext): number {
	try {
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		let depth = 0;
		for (const e of branch) {
			// biome-ignore lint: SessionEntry union, narrowed structurally.
			const any = e as any;
			if (
				any?.customType === META_TYPE &&
				typeof any?.data?.depth === "number"
			) {
				depth = Math.max(depth, any.data.depth);
			}
		}
		return depth;
	} catch {
		return 0;
	}
}

function hasAdviceMarker(ctx: ExtensionContext): boolean {
	try {
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		// biome-ignore lint: SessionEntry union, narrowed structurally.
		return branch.some((e: any) => e?.customType === ADVICE_TYPE);
	} catch {
		return false;
	}
}

// Prune clone session files older than the retention window. Best-effort and
// idempotent: it only removes files past the cutoff, so a live or recently-
// finished clone (fresh mtime) is never touched. Returns the count removed.
function sweepStaleClones(): number {
	let names: string[];
	try {
		names = readdirSync(CLONES_DIR);
	} catch {
		return 0; // dir absent → nothing to sweep
	}
	const cutoff = Date.now() - CLONE_RETENTION_MS;
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(CLONES_DIR, name);
		try {
			if (statSync(file).mtimeMs < cutoff) {
				unlinkSync(file);
				removed++;
			}
		} catch {
			/* race with another sweeper or stat error — ignore */
		}
	}
	return removed;
}

// --------------------------------------------------------------------------
// Extension factory — ALL state lives here (per-session closure).
//
// A clone loads pi-clones again in the same process; a module-global `pi` or
// record map would be clobbered across in-process sessions. Factory-local state
// gives each session its own isolated `pi`, clone map, and owner id.
// --------------------------------------------------------------------------

export default function piClones(pi: ExtensionAPI): void {
	const clones = new Map<string, CloneRecord>();
	const lastStatusChecks = new Map<string, number>();

	const liveStates: CloneState[] = ["starting", "running", "compacting"];
	const runningCount = () =>
		[...clones.values()].filter((c) => liveStates.includes(c.state)).length;
	const terminalClones = () =>
		[...clones.values()].filter((c) => !liveStates.includes(c.state));
	const activeClones = () =>
		[...clones.values()].filter((c) => liveStates.includes(c.state));

	function maybeAdvice(ctx: ExtensionContext): string {
		if (hasAdviceMarker(ctx)) return "";
		try {
			pi.appendEntry(ADVICE_TYPE, { at: Date.now() });
		} catch {
			/* best-effort marker */
		}
		return `${ADVICE_TEXT}\n\n`;
	}

	function cloneAllowlist(
		mode: "read-only" | "inherit",
		newDepth: number,
	): string[] {
		let allow =
			mode === "inherit"
				? pi.getActiveTools().filter((n) => !BLOCKED_TOOLS.has(n))
				: [...READONLY_TOOLS];
		// Nested clones only in inherit mode and only below the depth ceiling.
		if (mode !== "inherit" || newDepth >= MAX_DEPTH) {
			allow = allow.filter((n) => !CLONE_TOOLS.has(n));
		}
		allow = allow.filter((n) => !BLOCKED_TOOLS.has(n)); // ask_user never reaches a clone
		return [...new Set(allow)];
	}

	// biome-ignore lint: SDK event is a wide union; handled structurally.
	function onEvent(rec: CloneRecord, ev: any): void {
		rec.lastActivityAt = Date.now();
		switch (ev?.type) {
			case "tool_execution_start":
				rec.toolCount++;
				rec.activity = ev.toolName ?? ev.name ?? "tool";
				rec.state = "running";
				break;
			case "tool_execution_end":
				rec.activity = undefined;
				break;
			case "message_start":
			case "turn_start":
				rec.state = rec.state === "compacting" ? "compacting" : "running";
				break;
			case "message_end": {
				const t = textOf(ev.message);
				if (ev.message?.role === "assistant" && t.trim()) rec.lastText = t;
				const u = ev.message?.usage;
				if (u) rec.tokens += (u.input || 0) + (u.output || 0);
				break;
			}
			case "compaction_start":
				rec.state = "compacting";
				rec.compactions++;
				break;
			case "compaction_end":
				rec.state = "running";
				break;
			default:
				break;
		}
	}

	function teardown(rec: CloneRecord): void {
		try {
			rec.unsubscribe?.();
		} catch {
			/* ignore */
		}
		try {
			rec.session?.dispose?.();
		} catch {
			/* ignore */
		}
		rec.session = undefined; // keep `manager` for clone_log/clone_result
	}

	function finalText(rec: CloneRecord): string {
		try {
			const msgs = rec.manager?.buildSessionContext?.()?.messages ?? [];
			const t = lastAssistantText(msgs);
			if (t.trim()) return t;
		} catch {
			/* fall through */
		}
		return rec.lastText;
	}

	function resultText(rec: CloneRecord): string {
		const text = finalText(rec);
		if (rec.state !== "error") return text;
		const error = `Clone ${rec.id} failed: ${rec.error ?? "unknown error"}`;
		return text.trim() ? `${error}\n\nPartial output:\n${text}` : error;
	}

	function notifyCompletion(rec: CloneRecord): void {
		if (rec.notifiedAt) return;
		rec.notifiedAt = Date.now();
		const body =
			rec.state === "error"
				? `failed: ${rec.error ?? "unknown error"}`
				: rec.lastText || "no final text";
		const content = `Clone ${rec.id} finished with state ${rec.state}.\nTask: ${safeSnippet(rec.task, 180)}\nPreview: ${safeSnippet(body, 500)}\n\nUse clone_result({id:"${rec.id}"}) if the full handoff is needed for the next step. Use clone_log only to diagnose a surprising result.`;
		try {
			pi.sendMessage(
				{
					customType: RESULT_TYPE,
					content,
					display: true,
					details: {
						id: rec.id,
						task: rec.task,
						state: rec.state,
						toolCount: rec.toolCount,
						tokens: rec.tokens,
						elapsedMs: (rec.finishedAt ?? Date.now()) - rec.startedAt,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			/* parent may be gone; nothing to do */
		}
	}

	function finish(rec: CloneRecord): void {
		if (rec.state === "stopped") {
			rec.finishedAt = rec.finishedAt ?? Date.now();
			teardown(rec);
			return;
		}
		if (!liveStates.includes(rec.state)) return;
		rec.state = "done";
		rec.finishedAt = Date.now();
		rec.lastText = finalText(rec);
		teardown(rec);
		if (rec.background) notifyCompletion(rec);
	}

	function fail(rec: CloneRecord, err: unknown): void {
		if (rec.state === "stopped") {
			rec.finishedAt = rec.finishedAt ?? Date.now();
			teardown(rec);
			return;
		}
		if (!liveStates.includes(rec.state)) return;
		rec.state = "error";
		// biome-ignore lint: error is unknown.
		rec.error = String((err as any)?.message ?? err);
		rec.finishedAt = Date.now();
		teardown(rec);
		if (rec.background) notifyCompletion(rec);
	}

	function framedTask(task: string, continued: boolean): string {
		const kind = continued
			? "You are continuing an existing clone branch with your previous clone transcript available."
			: "You are a clone: a background fork of the main session with full shared context.";
		return `${task}\n\n[${kind} Work only this task. You have no user to ask — if you hit a decision only a human can make, state it as a BLOCKER and stop. End with a clear, self-contained final answer the main session can act on.]`;
	}

	async function continueClone(
		ctx: ExtensionContext,
		rec: CloneRecord,
		task: string,
		mode: "read-only" | "inherit",
		background: boolean,
	): Promise<CloneRecord> {
		const running = runningCount();
		if (running >= MAX_CONCURRENT) {
			throw new Error(
				`clone limit reached (${running}/${MAX_CONCURRENT}); stop or await existing clones first`,
			);
		}
		if (liveStates.includes(rec.state)) {
			throw new Error(
				`clone ${rec.id} is already ${rec.state}; stop or wait before continuing it`,
			);
		}
		if (!rec.manager) {
			throw new Error(`clone ${rec.id} has no session manager to continue`);
		}

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: AGENT_DIR,
			modelRegistry: ctx.modelRegistry,
			...(ctx.model ? { model: ctx.model } : {}),
			thinkingLevel: pi.getThinkingLevel(),
			sessionManager: rec.manager,
			tools: cloneAllowlist(mode, rec.depth),
		});
		session.setAutoCompactionEnabled?.(true);

		const now = Date.now();
		rec.task = task;
		rec.mode = mode;
		rec.state = "starting";
		rec.background = background;
		rec.startedAt = now;
		rec.lastActivityAt = now;
		rec.finishedAt = undefined;
		rec.toolCount = 0;
		rec.compactions = 0;
		rec.tokens = 0;
		rec.activity = undefined;
		rec.lastText = "";
		rec.error = undefined;
		rec.notifiedAt = undefined;
		rec.dismissedAt = undefined;
		rec.session = session;
		rec.unsubscribe = session.subscribe((ev: unknown) => onEvent(rec, ev));

		const run = session
			.prompt(framedTask(task, true))
			.then(() => finish(rec))
			.catch((e: unknown) => fail(rec, e));

		if (!background) await run;
		return rec;
	}

	async function spawnClone(
		ctx: ExtensionContext,
		task: string,
		mode: "read-only" | "inherit",
		background: boolean,
	): Promise<CloneRecord> {
		const running = runningCount();
		if (running >= MAX_CONCURRENT) {
			throw new Error(
				`clone limit reached (${running}/${MAX_CONCURRENT}); stop or await existing clones first`,
			);
		}
		const depth = currentDepth(ctx);
		if (depth >= MAX_DEPTH) {
			throw new Error(
				`max clone depth (${MAX_DEPTH}) reached; this session cannot fork further`,
			);
		}
		const newDepth = depth + 1;

		// Seed: fork the parent branch into the hidden clones dir so the clone
		// boots as a resume with the full inherited (frozen) context present.
		const parentFile = ctx.sessionManager.getSessionFile?.();
		if (!parentFile) {
			throw new Error(
				"parent session has no file to fork (in-memory session); cannot clone",
			);
		}

		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.forkFrom(parentFile, ctx.cwd, CLONES_DIR);
			manager.appendCustomEntry?.(META_TYPE, {
				depth: newDepth,
				task,
				parentId: ctx.sessionManager.getSessionId?.(),
			});

			const allow = cloneAllowlist(mode, newDepth);

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				agentDir: AGENT_DIR,
				modelRegistry: ctx.modelRegistry, // shared auth (incl. Anthropic OAuth)
				...(ctx.model ? { model: ctx.model } : {}),
				thinkingLevel: pi.getThinkingLevel(),
				sessionManager: manager,
				tools: allow,
			});
			session.setAutoCompactionEnabled?.(true); // never brick at the token limit

			const now = Date.now();
			const rec: CloneRecord = {
				id: shortId(),
				task,
				depth: newDepth,
				mode,
				state: "starting",
				background,
				startedAt: now,
				lastActivityAt: now,
				toolCount: 0,
				compactions: 0,
				tokens: 0,
				lastText: "",
				sessionFile: manager.getSessionFile?.(),
				session,
				manager,
			};
			clones.set(rec.id, rec);
			rec.unsubscribe = session.subscribe((ev: unknown) => onEvent(rec, ev));

			const run = session
				.prompt(framedTask(task, false))
				.then(() => finish(rec))
				.catch((e: unknown) => fail(rec, e));

			if (!background) await run;
			return rec;
		} catch (e) {
			const file = manager?.getSessionFile?.();
			if (file) {
				try {
					unlinkSync(file);
				} catch {
					/* best-effort cleanup of a failed setup fork */
				}
			}
			throw e;
		}
	}

	function statusPollSuppression(key: string, hasLiveClone: boolean): string {
		if (!hasLiveClone) return "";
		const now = Date.now();
		const last = lastStatusChecks.get(key);
		lastStatusChecks.set(key, now);
		if (last === undefined || now - last >= STATUS_POLL_COOLDOWN_MS) return "";
		const waitSeconds = Math.ceil((STATUS_POLL_COOLDOWN_MS - (now - last)) / 1000);
		return (
			`Active clone status was checked ${ago(last)} ago. Pi intentionally suppresses rapid clone_status polling ` +
			`because completion alerts are pushed automatically. Do not call clone_status in a loop; wait for alerts, ` +
			`continue non-overlapping work, or try again in ~${waitSeconds}s if the user explicitly needs an update.`
		);
	}

	function activeStatusNotice(hasLiveClone: boolean): string {
		return hasLiveClone
			? "\n\nDo not poll clone_status. Completion alerts are pushed automatically; check again only on user request, suspected stuck clone, or after a meaningful delay."
			: "";
	}

	function statusLine(rec: CloneRecord): string {
		const usage = rec.tokens ? ` · ${fmtTokens(rec.tokens)} tok` : "";
		const act = rec.activity ? ` · ${rec.activity}` : "";
		const dismissed = rec.dismissedAt
			? ` · written off ${ago(rec.dismissedAt)} ago`
			: "";
		const snippet = rec.lastText ? ` · “${truncate(rec.lastText, 80)}”` : "";
		return (
			`${rec.id} [${rec.state}] d${rec.depth}/${rec.mode} · “${truncate(rec.task, 60)}” · ` +
			`${rec.toolCount} tools${usage}${rec.compactions ? ` · ⇊${rec.compactions}` : ""} · ` +
			`last activity ${ago(rec.lastActivityAt)} ago (${new Date(rec.lastActivityAt).toISOString()})${act}${dismissed}${snippet}` +
			`${rec.error ? ` · ERROR: ${truncate(rec.error, 120)}` : ""}`
		);
	}

	// ----------------------------------------------------------------------
	// Tools
	// ----------------------------------------------------------------------

	pi.registerTool({
		name: "clone",
		label: "Clone",
		description:
			"Fork yourself into a background clone that inherits your full context and works one extra task in " +
			"parallel. Returns a clone_id immediately and alerts you when the clone finishes. Use for " +
			"parallelisable research/investigation; the clone already has your context, so state only the new task.",
		promptGuidelines: [
			"After delegating a task to a clone, do not repeat the same work yourself; continue only with non-overlapping work unless the clone reports a blocker or the user redirects you.",
			"Do not poll clone_status in a loop. Background clones push completion alerts; call clone_status only when the user asks for an update, a clone appears stuck, or a meaningful delay has passed.",
			"Do not call clone_result for running clones; wait for a completion alert or a done/error/stopped status. Use clone_log only to diagnose surprising results.",
			"Clone completion alerts are concise; fetch clone_result only when the full handoff is needed for the next step, then use clone_dismiss to write off completed clones you no longer need listed.",
			'If a clone started read-only but now needs to edit, use clone_continue with mode:"inherit" and a focused continuation task instead of starting over from scratch.',
		],
		parameters: Type.Object({
			task: Type.String({
				description:
					"The single, well-scoped task for the clone. It already has all of your context — do not " +
					"re-explain; state only the new objective and its definition of done.",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("read-only"), Type.Literal("inherit")], {
					description:
						'"read-only" (default): clone gets read-only tools — safe for parallel research. ' +
						'"inherit": clone gets your active tools (can edit) — only for genuinely non-overlapping work.',
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Default true: return immediately and alert on completion. false: block and return inline.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<CloneToolResult> {
			try {
				const mode: "read-only" | "inherit" = params.mode ?? "read-only";
				const background = params.background !== false;
				const advice = maybeAdvice(ctx);
				const rec = await spawnClone(ctx, params.task, mode, background);
				if (background) {
					return {
						content: [
							{
								type: "text",
								text:
									`${advice}Clone ${rec.id} started (depth ${rec.depth}, ${mode}). It will alert you when ` +
									`finished. Do not poll clone_status; wait for the completion alert. Use clone_status({id:"${rec.id}"}) ` +
									`only if the user asks for an update or the clone seems stuck, and wait for done/error/stopped before ` +
									`clone_result({id:"${rec.id}"}).`,
							},
						],
						details: { id: rec.id, state: rec.state, depth: rec.depth, mode },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `${advice}Clone ${rec.id} finished (${rec.state}).\n\n${rec.lastText || "(no final text — use clone_log)"}`,
						},
					],
					details: { id: rec.id, state: rec.state, depth: rec.depth, mode },
				};
			} catch (e) {
				// biome-ignore lint: error is unknown.
				const error = String((e as any)?.message ?? e);
				return {
					content: [{ type: "text", text: `clone failed: ${error}` }],
					details: { error },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "clone_status",
		label: "Clone status",
		description:
			'One-off inspection of clones spawned by this session; active clones are listed by default. This is not a polling tool: background clones push completion alerts. Pass include:"completed" or include:"all" ' +
			"when you need written-off/completed clone records.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"Clone id; when set, returns that clone even if completed or written off.",
				}),
			),
			include: Type.Optional(
				Type.Union(
					[
						Type.Literal("active"),
						Type.Literal("completed"),
						Type.Literal("all"),
					],
					{
						description:
							"Default active: list only running/starting/compacting clones. completed lists terminal, not-written-off clones. all includes written-off clones too.",
					},
				),
			),
		}),
		async execute(_toolCallId, params): Promise<CloneToolResult> {
			if (params.id) {
				const rec = clones.get(params.id);
				if (!rec)
					return {
						content: [{ type: "text", text: `no clone with id ${params.id}` }],
						details: { id: params.id, error: "not_found" },
						isError: true,
					};
				const hasLiveClone = liveStates.includes(rec.state);
				const suppressed = statusPollSuppression(`id:${rec.id}`, hasLiveClone);
				if (suppressed) {
					return {
						content: [{ type: "text", text: suppressed }],
						details: { id: rec.id, state: rec.state, suppressed: true },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `${statusLine(rec)}${activeStatusNotice(hasLiveClone)}`,
						},
					],
					details: {
						id: rec.id,
						state: rec.state,
						dismissed: Boolean(rec.dismissedAt),
					},
				};
			}
			if (clones.size === 0)
				return {
					content: [{ type: "text", text: "no clones in this session" }],
					details: { count: 0 },
				};

			const include = params.include ?? "active";
			const records =
				include === "active"
					? activeClones()
					: include === "completed"
						? terminalClones().filter((c) => !c.dismissedAt)
						: [...clones.values()];
			const sorted = records.sort((a, b) => b.startedAt - a.startedAt);
			if (sorted.length === 0) {
				const terminal = terminalClones().filter((c) => !c.dismissedAt).length;
				const suffix =
					include === "active" && terminal
						? ` (${terminal} completed; use include:\"completed\" if you need ids, or clone_dismiss to write them off)`
						: "";
				return {
					content: [{ type: "text", text: `no ${include} clones${suffix}` }],
					details: {
						count: 0,
						active: activeClones().length,
						completed: terminal,
					},
				};
			}
			const hasLiveClone = sorted.some((rec) => liveStates.includes(rec.state));
			const suppressed = statusPollSuppression(`list:${include}`, hasLiveClone);
			if (suppressed) {
				return {
					content: [{ type: "text", text: suppressed }],
					details: {
						count: sorted.length,
						active: activeClones().length,
						completed: terminalClones().filter((c) => !c.dismissedAt).length,
						suppressed: true,
					},
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `${sorted.map(statusLine).join("\n")}${activeStatusNotice(hasLiveClone)}`,
					},
				],
				details: {
					count: sorted.length,
					active: activeClones().length,
					completed: terminalClones().filter((c) => !c.dismissedAt).length,
				},
			};
		},
	});

	pi.registerTool({
		name: "clone_result",
		label: "Clone result",
		description:
			"Fetch a clone's final answer after it reaches done/error/stopped. If the clone is still running, wait for its completion alert rather than polling.",
		parameters: Type.Object({ id: Type.String({ description: "Clone id." }) }),
		async execute(_toolCallId, params): Promise<CloneToolResult> {
			const rec = clones.get(params.id);
			if (!rec)
				return {
					content: [{ type: "text", text: `no clone with id ${params.id}` }],
					details: { id: params.id, error: "not_found" },
					isError: true,
				};
			if (liveStates.includes(rec.state)) {
				return {
					content: [
						{
							type: "text",
							text: `${statusLine(rec)}\n\nClone is still ${rec.state}; do not poll for progress. Wait for the completion alert or check status only after a meaningful delay before fetching the final result.`,
						},
					],
					details: { id: rec.id, state: rec.state },
				};
			}
			const text = resultText(rec);
			return {
				content: [
					{
						type: "text",
						text: text || "(no output — use clone_log to inspect)",
					},
				],
				details: { id: rec.id, state: rec.state },
			};
		},
	});

	pi.registerTool({
		name: "clone_continue",
		label: "Clone continue",
		description:
			'Continue a completed/error/stopped clone from its existing branch with a new focused task. Use this to upgrade a read-only clone to mode:"inherit" instead of starting over.',
		parameters: Type.Object({
			id: Type.String({ description: "Clone id to continue." }),
			task: Type.String({
				description:
					"The focused continuation task. The clone already has its prior transcript; state only what to do next.",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("read-only"), Type.Literal("inherit")], {
					description:
						"Tool mode for the continuation. Defaults to the clone's previous mode; pass inherit to enable writes/tools.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Default true: return immediately and alert on completion. false: block and return inline.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<CloneToolResult> {
			try {
				const rec = clones.get(params.id);
				if (!rec)
					return {
						content: [{ type: "text", text: `no clone with id ${params.id}` }],
						details: { id: params.id, error: "not_found" },
						isError: true,
					};
				const mode: "read-only" | "inherit" = params.mode ?? rec.mode;
				const background = params.background !== false;
				const continued = await continueClone(
					ctx,
					rec,
					params.task,
					mode,
					background,
				);
				if (background) {
					return {
						content: [
							{
								type: "text",
								text: `Clone ${continued.id} continued (${mode}). It will alert you when finished. Do not poll clone_status; use it only if the user asks for an update or the clone seems stuck.`,
							},
						],
						details: { id: continued.id, state: continued.state, mode },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Clone ${continued.id} continuation finished (${continued.state}).\n\n${continued.lastText || "(no final text — use clone_log)"}`,
						},
					],
					details: { id: continued.id, state: continued.state, mode },
				};
			} catch (e) {
				// biome-ignore lint: error unknown.
				const error = String((e as any)?.message ?? e);
				return {
					content: [{ type: "text", text: `clone_continue failed: ${error}` }],
					details: { id: params.id, error },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "clone_log",
		label: "Clone log",
		description:
			"Browse a clone's transcript when its result looks wrong. Returns the last `tail` messages (default 20).",
		parameters: Type.Object({
			id: Type.String({ description: "Clone id." }),
			tail: Type.Optional(
				Type.Integer({
					description: "How many trailing messages to show (default 20).",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<CloneToolResult> {
			const rec = clones.get(params.id);
			if (!rec)
				return {
					content: [{ type: "text", text: `no clone with id ${params.id}` }],
					details: { id: params.id, error: "not_found" },
					isError: true,
				};
			const tail = Math.max(1, Math.min(100, Math.floor(params.tail ?? 20)));
			try {
				const msgs = rec.manager?.buildSessionContext?.()?.messages ?? [];
				const slice = msgs.slice(-tail);
				const rendered = slice
					.map((m: unknown) => {
						const message = m as {
							role?: string;
							content?: Array<{ type?: string }>;
						};
						return `[${message.role ?? "unknown"}] ${truncate(textOf(message) || `(${message.content?.[0]?.type || "non-text"})`, 400)}`;
					})
					.join("\n");
				return {
					content: [{ type: "text", text: rendered || "(empty transcript)" }],
					details: { id: rec.id, shown: slice.length, total: msgs.length },
				};
			} catch (e) {
				// biome-ignore lint: error unknown.
				const error = String((e as any)?.message ?? e);
				return {
					content: [
						{ type: "text", text: `could not read clone log: ${error}` },
					],
					details: { id: rec.id, error },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "clone_stop",
		label: "Clone stop",
		description:
			"Abort a running clone. Its final/partial output remains available via clone_result / clone_log after it stops.",
		parameters: Type.Object({ id: Type.String({ description: "Clone id." }) }),
		async execute(_toolCallId, params): Promise<CloneToolResult> {
			const rec = clones.get(params.id);
			if (!rec)
				return {
					content: [{ type: "text", text: `no clone with id ${params.id}` }],
					details: { id: params.id, error: "not_found" },
					isError: true,
				};
			if (!liveStates.includes(rec.state)) {
				return {
					content: [
						{ type: "text", text: `clone ${rec.id} already ${rec.state}` },
					],
					details: { id: rec.id, state: rec.state },
				};
			}
			rec.state = "stopped";
			try {
				rec.session?.abort?.();
			} catch {
				/* ignore */
			}
			rec.lastText = finalText(rec);
			teardown(rec);
			return {
				content: [{ type: "text", text: `clone ${rec.id} stopped` }],
				details: { id: rec.id, state: rec.state },
			};
		},
	});

	pi.registerTool({
		name: "clone_dismiss",
		label: "Clone dismiss",
		description:
			"Write off completed/error/stopped clones so clone_status omits them. Omit id to dismiss every terminal clone.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description: "Clone id; omit to dismiss all terminal clones.",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<CloneToolResult> {
			const now = Date.now();
			if (params.id) {
				const rec = clones.get(params.id);
				if (!rec)
					return {
						content: [{ type: "text", text: `no clone with id ${params.id}` }],
						details: { id: params.id, error: "not_found" },
						isError: true,
					};
				if (liveStates.includes(rec.state)) {
					return {
						content: [
							{
								type: "text",
								text: `clone ${rec.id} is still ${rec.state}; stop or wait before writing it off`,
							},
						],
						details: { id: rec.id, state: rec.state },
						isError: true,
					};
				}
				rec.dismissedAt = now;
				return {
					content: [{ type: "text", text: `clone ${rec.id} written off` }],
					details: { id: rec.id, state: rec.state, dismissed: true },
				};
			}

			const done = terminalClones().filter((c) => !c.dismissedAt);
			for (const rec of done) rec.dismissedAt = now;
			return {
				content: [
					{
						type: "text",
						text: done.length
							? `wrote off ${done.length} completed clone(s)`
							: "no completed clones to write off",
					},
				],
				details: { count: done.length },
			};
		},
	});

	// ----------------------------------------------------------------------
	// Human command: /clones — compact status summary (TUI only).
	// ----------------------------------------------------------------------
	pi.registerCommand("clones", {
		description: "List active background clones spawned by this session.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || !ctx.ui) return;
			const active = activeClones().sort((a, b) => b.startedAt - a.startedAt);
			const completed = terminalClones().filter((c) => !c.dismissedAt).length;
			const text = active.length
				? active.map(statusLine).join("\n")
				: `no active clones${completed ? ` (${completed} completed; use clone_status({include:\"completed\"}) or clone_dismiss)` : ""}`;
			ctx.ui.notify(text, "info");
		},
	});

	// ----------------------------------------------------------------------
	// Lifecycle: abort live clones on parent shutdown.
	// ----------------------------------------------------------------------
	// Retention sweep: only the human's session (depth 0) prunes old clone files,
	// so clones don't each re-sweep. Past the window means past any usefulness for
	// clone_log/clone_result, and no tombstones accumulate in the tree.
	pi.on("session_start", async (_event, ctx) => {
		if (currentDepth(ctx) === 0) sweepStaleClones();
	});

	pi.on("session_shutdown", () => {
		for (const rec of clones.values()) {
			if (liveStates.includes(rec.state)) {
				rec.state = "stopped";
				try {
					rec.session?.abort?.();
				} catch {
					/* ignore */
				}
				teardown(rec);
			}
		}
	});
}

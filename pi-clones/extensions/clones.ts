// pi-clones — fork the running agent into a background clone that inherits the
// full session context, works one extra task, and re-merges its result into main.
//
// A clone is the same agent (same system prompt, conversation, tools, auth) plus
// one appended task — not a context-free "subagent". It runs in-process via the
// Pi SDK, so it shares the parent's model client + auth and reuses the warm
// prompt cache, and it boots as a resume of a forked branch so the inherited
// context is frozen (memedit treats resumed entries as context-only).
//
// See DESIGN.md for the full rationale, the spike evidence, and the cost model.

import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
// Hidden clone session dir: a sibling of the normal sessions dir, never scanned
// by SessionManager.list/listAll, so clones never appear in resume history.
const CLONES_DIR = join(AGENT_DIR, "clones");

const MAX_DEPTH = 2; // root(0) → clone(1) → sub-clone(2); depth 2 cannot fork further
const MAX_CONCURRENT = 4; // live clones per owning session

const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const BLOCKED_TOOLS = new Set(["ask_user"]); // no human attends a clone
const CLONE_TOOLS = new Set(["clone", "clone_status", "clone_result", "clone_log", "clone_stop"]);

const META_TYPE = "pi-clone-meta"; // CustomEntry: depth marker (not sent to LLM)
const ADVICE_TYPE = "pi-clones-advice"; // CustomEntry: "advice shown" marker
const RESULT_TYPE = "pi-clone-result"; // CustomMessage: re-merged result (sent to LLM)

const ADVICE_TEXT =
	"[pi-clones] You can fork yourself into a clone — a background copy with all of your current " +
	"knowledge and context, plus one task you assign. It is you, not a stranger: do not re-explain " +
	"context, just state the new objective and its definition of done. Use clones only for genuinely " +
	'parallel or independently-researchable work (wide reads, investigations, "go find out X while I ' +
	'continue", independent verification). A clone has no user to ask: if it hits a decision only the ' +
	"human can make, it records the blocker in its result and stops — it escalates to you, never to the " +
	'user. Default clones are read-only (safe for parallel research); pass mode:"inherit" only for ' +
	"non-overlapping work that may edit files. You are alerted when a clone finishes; you can also call " +
	"clone_status (timestamps show progress), clone_result, or clone_log (to inspect a confusing result).";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

type CloneState = "starting" | "running" | "compacting" | "done" | "error" | "stopped";

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
			if (any?.customType === META_TYPE && typeof any?.data?.depth === "number") {
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

// --------------------------------------------------------------------------
// Extension factory — ALL state lives here (per-session closure).
//
// A clone loads pi-clones again in the same process; a module-global `pi` or
// record map would be clobbered across in-process sessions. Factory-local state
// gives each session its own isolated `pi`, clone map, and owner id.
// --------------------------------------------------------------------------

export default function piClones(pi: ExtensionAPI): void {
	const clones = new Map<string, CloneRecord>();

	const liveStates: CloneState[] = ["starting", "running", "compacting"];
	const runningCount = () => [...clones.values()].filter((c) => liveStates.includes(c.state)).length;

	function maybeAdvice(ctx: ExtensionContext): string {
		if (hasAdviceMarker(ctx)) return "";
		try {
			pi.appendEntry(ADVICE_TYPE, { at: Date.now() });
		} catch {
			/* best-effort marker */
		}
		return `${ADVICE_TEXT}\n\n`;
	}

	function cloneAllowlist(mode: "read-only" | "inherit", newDepth: number): string[] {
		let allow = mode === "inherit" ? pi.getActiveTools().filter((n) => !BLOCKED_TOOLS.has(n)) : [...READONLY_TOOLS];
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

	function deliver(rec: CloneRecord): void {
		const body =
			rec.state === "error"
				? `Clone ${rec.id} failed: ${rec.error ?? "unknown error"}`
				: rec.lastText || "(clone produced no final text — use clone_log to inspect)";
		const content = `<clone_result id="${rec.id}" state="${rec.state}">\nTask: ${rec.task}\n\n${body}\n</clone_result>`;
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
			rec.finishedAt = Date.now();
			teardown(rec);
			return;
		}
		rec.state = "done";
		rec.finishedAt = Date.now();
		rec.lastText = finalText(rec);
		teardown(rec);
		if (rec.background) deliver(rec);
	}

	function fail(rec: CloneRecord, err: unknown): void {
		rec.state = "error";
		// biome-ignore lint: error is unknown.
		rec.error = String((err as any)?.message ?? err);
		rec.finishedAt = Date.now();
		teardown(rec);
		if (rec.background) deliver(rec);
	}

	async function spawnClone(
		ctx: ExtensionContext,
		task: string,
		mode: "read-only" | "inherit",
		background: boolean,
	): Promise<CloneRecord> {
		const running = runningCount();
		if (running >= MAX_CONCURRENT) {
			throw new Error(`clone limit reached (${running}/${MAX_CONCURRENT}); stop or await existing clones first`);
		}
		const depth = currentDepth(ctx);
		if (depth >= MAX_DEPTH) {
			throw new Error(`max clone depth (${MAX_DEPTH}) reached; this session cannot fork further`);
		}
		const newDepth = depth + 1;

		// Seed: fork the parent branch into the hidden clones dir so the clone
		// boots as a resume with the full inherited (frozen) context present.
		const parentFile = ctx.sessionManager.getSessionFile?.();
		if (!parentFile) {
			throw new Error("parent session has no file to fork (in-memory session); cannot clone");
		}
		const manager = SessionManager.forkFrom(parentFile, ctx.cwd, CLONES_DIR);
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

		const framed =
			`${task}\n\n[You are a clone: a background fork of the main session with full shared context. ` +
			"Work only this task. You have no user to ask — if you hit a decision only a human can make, state it " +
			"as a BLOCKER and stop. End with a clear, self-contained final answer the main session can act on.]";

		const run = session
			.prompt(framed)
			.then(() => finish(rec))
			.catch((e: unknown) => fail(rec, e));

		if (!background) await run;
		return rec;
	}

	// biome-ignore lint: rec is fully typed; output is a status line.
	function statusLine(rec: CloneRecord): string {
		const usage = rec.tokens ? ` · ${fmtTokens(rec.tokens)} tok` : "";
		const act = rec.activity ? ` · ${rec.activity}` : "";
		const snippet = rec.lastText ? ` · “${truncate(rec.lastText, 80)}”` : "";
		return (
			`${rec.id} [${rec.state}] d${rec.depth}/${rec.mode} · “${truncate(rec.task, 60)}” · ` +
			`${rec.toolCount} tools${usage}${rec.compactions ? ` · ⇊${rec.compactions}` : ""} · ` +
			`last activity ${ago(rec.lastActivityAt)} ago (${new Date(rec.lastActivityAt).toISOString()})${act}${snippet}` +
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
		parameters: Type.Object({
			task: Type.String({
				description:
					"The single, well-scoped task for the clone. It already has all of your context — do not " +
					"re-explain; state only the new objective and its definition of done.",
			}),
			mode: Type.Optional(
				Type.String({
					description:
						'"read-only" (default): clone gets read-only tools — safe for parallel research. ' +
						'"inherit": clone gets your active tools (can edit) — only for genuinely non-overlapping work.',
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Default true: return immediately and alert on completion. false: block and return inline.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				const mode: "read-only" | "inherit" = params.mode === "inherit" ? "inherit" : "read-only";
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
									`finished. Poll clone_status({id:"${rec.id}"}) for progress, or clone_result({id:"${rec.id}"}).`,
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
				return { content: [{ type: "text", text: `clone failed: ${String((e as any)?.message ?? e)}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "clone_status",
		label: "Clone status",
		description:
			"Inspect clones spawned by this session: state, last-activity timestamp (to tell progress from a stall), " +
			"tool count, tokens, and a snippet of the latest output. Omit id for all clones.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Clone id; omit to list all clones from this session." })),
		}),
		async execute(_toolCallId, params) {
			if (params.id) {
				const rec = clones.get(params.id);
				if (!rec) return { content: [{ type: "text", text: `no clone with id ${params.id}` }], isError: true };
				return { content: [{ type: "text", text: statusLine(rec) }], details: { id: rec.id, state: rec.state } };
			}
			if (clones.size === 0) return { content: [{ type: "text", text: "no clones in this session" }] };
			const lines = [...clones.values()].sort((a, b) => b.startedAt - a.startedAt).map(statusLine);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: clones.size } };
		},
	});

	pi.registerTool({
		name: "clone_result",
		label: "Clone result",
		description: "Fetch a clone's final answer (or its current partial output if still running).",
		parameters: Type.Object({ id: Type.String({ description: "Clone id." }) }),
		async execute(_toolCallId, params) {
			const rec = clones.get(params.id);
			if (!rec) return { content: [{ type: "text", text: `no clone with id ${params.id}` }], isError: true };
			const text = rec.state === "done" || rec.state === "error" ? finalText(rec) : rec.lastText;
			const note = liveStates.includes(rec.state) ? `(still ${rec.state}; partial)\n\n` : "";
			return {
				content: [{ type: "text", text: `${note}${text || "(no output yet — use clone_log to inspect)"}` }],
				details: { id: rec.id, state: rec.state },
			};
		},
	});

	pi.registerTool({
		name: "clone_log",
		label: "Clone log",
		description: "Browse a clone's transcript when its result looks wrong. Returns the last `tail` messages (default 20).",
		parameters: Type.Object({
			id: Type.String({ description: "Clone id." }),
			tail: Type.Optional(Type.Number({ description: "How many trailing messages to show (default 20)." })),
		}),
		async execute(_toolCallId, params) {
			const rec = clones.get(params.id);
			if (!rec) return { content: [{ type: "text", text: `no clone with id ${params.id}` }], isError: true };
			const tail = Math.max(1, Math.min(100, params.tail ?? 20));
			try {
				const msgs = rec.manager?.buildSessionContext?.()?.messages ?? [];
				const slice = msgs.slice(-tail);
				// biome-ignore lint: messages loosely typed.
				const rendered = slice
					.map((m: any) => `[${m.role}] ${truncate(textOf(m) || `(${(m.content && m.content[0]?.type) || "non-text"})`, 400)}`)
					.join("\n");
				return {
					content: [{ type: "text", text: rendered || "(empty transcript)" }],
					details: { id: rec.id, shown: slice.length, total: msgs.length },
				};
			} catch (e) {
				// biome-ignore lint: error unknown.
				return { content: [{ type: "text", text: `could not read clone log: ${String((e as any)?.message ?? e)}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "clone_stop",
		label: "Clone stop",
		description: "Abort a running clone. Its partial output remains available via clone_result / clone_log.",
		parameters: Type.Object({ id: Type.String({ description: "Clone id." }) }),
		async execute(_toolCallId, params) {
			const rec = clones.get(params.id);
			if (!rec) return { content: [{ type: "text", text: `no clone with id ${params.id}` }], isError: true };
			if (!liveStates.includes(rec.state)) {
				return { content: [{ type: "text", text: `clone ${rec.id} already ${rec.state}` }] };
			}
			rec.state = "stopped";
			try {
				rec.session?.abort?.();
			} catch {
				/* ignore */
			}
			rec.lastText = finalText(rec);
			teardown(rec);
			return { content: [{ type: "text", text: `clone ${rec.id} stopped` }], details: { id: rec.id, state: rec.state } };
		},
	});

	// ----------------------------------------------------------------------
	// Human command: /clones — compact status summary (TUI only).
	// ----------------------------------------------------------------------
	pi.registerCommand("clones", {
		description: "List background clones spawned by this session.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || !ctx.ui) return;
			const text =
				clones.size === 0 ? "no clones in this session" : [...clones.values()].sort((a, b) => b.startedAt - a.startedAt).map(statusLine).join("\n");
			ctx.ui.notify(text, "info");
		},
	});

	// ----------------------------------------------------------------------
	// Lifecycle: abort live clones on parent shutdown.
	// ----------------------------------------------------------------------
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

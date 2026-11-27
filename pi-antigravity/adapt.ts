/**
 * Loaded right after the Gemini provider (pi-antigravity-acp-provider), and by Desk's sign-in after it, to change the
 * runtime and provider it shares on globalThis before Pi registers them. Each change replaces a member the package
 * does not export (0.1.23: src/runtime.ts, src/provider.ts) and checks for it first: if a later version renames one,
 * that change is skipped and the package behaves as published.
 */
const SHARED = Symbol.for("pi-antigravity-acp:runtime"), ADAPTED = Symbol.for("pi-antigravity:adapted");
/** How long a connection waits for the server's first answer; the provider allows 30 s. */
const START_TIMEOUT_MS = 2 * 60_000;
/** How long a discovered model list is reused before the server is asked again. */
const MODELS_FRESH_MS = 12 * 60 * 60_000;

type Members = Record<string | symbol, unknown>;
interface PermissionRequest {
	toolCall?: { _meta?: { is_mcp_tool_call?: unknown; mcp?: { server?: unknown } } };
	options?: { optionId: string; kind: string }[];
}
interface Binding { writer?: { finished?: boolean }; abortRequested?: boolean }
interface RefreshContext { allowNetwork?: boolean; force?: boolean; stored?: { checkedAt?: number } }

export default function adaptAntigravity(): void {
	const shared = (globalThis as Record<symbol, { runtime?: Members; provider?: Members } | undefined>)[SHARED];
	const runtime = shared?.runtime, provider = shared?.provider;
	if (!runtime || !provider || runtime[ADAPTED]) return;
	allowPiTools(runtime);
	waitForStart(runtime);
	reuseModelList(provider);
	runtime[ADAPTED] = true;
}

/**
 * Antigravity asks before every tool call outside "yolo", Pi's tools included: Gemini reaches them through the
 * provider's MCP server "pi-bridge", and each call was a question, or refused where none can be shown. Those calls run
 * as Pi tool calls under Pi's command guard, as Claude's do, so each is allowed once here; Antigravity's own commands
 * and edits still ask.
 */
function allowPiTools(runtime: Members): void {
	if (typeof runtime.requestPermission !== "function") return;
	const ask = (runtime.requestPermission as (binding: Binding | undefined, request: PermissionRequest) => Promise<unknown>).bind(runtime);
	runtime.requestPermission = (binding: Binding | undefined, request: PermissionRequest) => {
		const meta = request?.toolCall?._meta, allow = request?.options?.find(option => option.kind === "allow_once");
		const piTool = meta?.is_mcp_tool_call === true && meta.mcp?.server === "pi-bridge";
		// A finished or cancelled turn goes to the provider, which refuses it.
		const live = !!binding?.writer && !binding.writer.finished && !binding.abortRequested;
		return piTool && allow && live ? Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } }) : ask(binding, request);
	};
}

/**
 * The Windows server is a PyInstaller program that unpacks about 140 MB of its own files into a new temporary folder
 * at every start, and Defender scans them with several cores: on the work laptop the first answer came 10 to 27 s
 * after the start, so with the provider's 30 s limit sign-in and conversations failed under load.
 */
function waitForStart(runtime: Members): void {
	if (typeof runtime.connectionFactory !== "function") return;
	const create = runtime.connectionFactory as (options: { initializeTimeoutMs?: number }) => unknown;
	runtime.connectionFactory = (options: { initializeTimeoutMs?: number }) =>
		create({ ...options, initializeTimeoutMs: Math.max(options?.initializeTimeoutMs ?? 0, START_TIMEOUT_MS) });
}

/**
 * Pi refreshes model lists over the network as each conversation starts and whenever the model list is opened, and
 * the provider answers every time by starting a separate server, whatever the age of its last list. That list is
 * reused for 12 hours instead; a forced refresh still asks.
 */
function reuseModelList(provider: Members): void {
	if (typeof provider.refreshModels !== "function") return;
	const refresh = provider.refreshModels as (context: RefreshContext) => Promise<void>;
	provider.refreshModels = (context: RefreshContext) => {
		const checked = context?.stored?.checkedAt;
		const fresh = context?.allowNetwork && !context.force && typeof checked === "number" && Date.now() - checked < MODELS_FRESH_MS;
		return refresh.call(provider, fresh ? { ...context, allowNetwork: false } : context);
	};
}

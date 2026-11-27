import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { type Relay, startRelay } from "./relay.ts";

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
/** How often a Windows process looks for unpack folders left by stopped servers. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

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
	hidePiToolLines(runtime);
	passAddedMessages(runtime);
	adjustConnections(runtime);
	offerPiToolsNatively(runtime);
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

interface ToolUpdate { sessionUpdate?: string; toolCallId?: string; title?: string | null; status?: string | null; _meta?: { mcp?: { server?: unknown } } }

/**
 * The provider writes a line into the thinking block for each tool call Antigravity reports, such as "[Antigravity
 * tool: pi-bridge_pi_codemode — pending]". A call to one of Pi's tools also arrives as that tool's own card, so its
 * lines are dropped; Antigravity's own actions keep theirs, as they have no card. Tool updates do nothing else there.
 */
function hidePiToolLines(runtime: Members): void {
	if (typeof runtime.consumeUpdate !== "function") return;
	const consume = (runtime.consumeUpdate as (binding: unknown, notification: { update?: ToolUpdate }) => void).bind(runtime);
	const piCalls = new Set<string>();
	const piTool = (update: ToolUpdate) => update._meta?.mcp?.server === "pi-bridge" || /^(mcp_)?pi-bridge_/.test(update.title ?? "");
	runtime.consumeUpdate = (binding: unknown, notification: { update?: ToolUpdate }) => {
		const update = notification?.update, id = update?.toolCallId ?? "";
		if (update?.sessionUpdate === "tool_call" && piTool(update)) return void piCalls.add(id);
		if (update?.sessionUpdate === "tool_call_update" && (piCalls.has(id) || piTool(update))) {
			if (update.status === "completed" || update.status === "failed") piCalls.delete(id);
			return;
		}
		consume(binding, notification);
	};
}

interface Block { type: string; text?: string; data?: string; mimeType?: string }
interface PiMessage { role?: string; content?: string | Block[] }
interface ToolAnswer { content?: Block[]; isError?: boolean }
interface ToolBinding { key?: string; pendingTools?: Map<string, { resolve: (answer: ToolAnswer) => void }> }

/**
 * A message added to a Pi conversation while its tools run, Jordan's or another agent's, goes into the context after
 * the tool results, where Claude reads it with them. The provider hands Antigravity only the results, as the answers to
 * its still-running pi-bridge calls, and counts the rest of the context as delivered, so Gemini never saw such a message
 * and went looking for one it had been sent. The messages are appended to the first answer handed over instead.
 */
function passAddedMessages(runtime: Members): void {
	if (typeof runtime.runQueued !== "function" || typeof runtime.requestPiTool !== "function") return;
	const run = (runtime.runQueued as (...args: unknown[]) => Promise<void>).bind(runtime);
	const request = (runtime.requestPiTool as (binding: ToolBinding | undefined, invocation: { id?: string }) => Promise<ToolAnswer>).bind(runtime);
	// Keyed like the runtime's bindings; set as each model call starts, before the answers it carries are handed over.
	const added = new Map<string, Block[]>();
	runtime.runQueued = (model: unknown, context: { messages?: PiMessage[] }, options: { sessionId?: string } | undefined, writer: unknown) => {
		if (options?.sessionId) {
			const key = `sid:${options.sessionId}`, blocks = addedDuringTools(context?.messages ?? []);
			if (blocks.length) added.set(key, blocks); else added.delete(key);
		}
		return run(model, context, options, writer);
	};
	runtime.requestPiTool = (binding: ToolBinding | undefined, invocation: { id?: string }) => {
		const answer = request(binding, invocation);
		const pending = binding?.pendingTools?.get(invocation?.id ?? ""), key = binding?.key;
		if (pending && key) {
			const resolve = pending.resolve;
			pending.resolve = result => {
				const blocks = added.get(key);
				added.delete(key);
				resolve(blocks ? { ...result, content: [...(result?.content ?? []), ...blocks] } : result);
			};
		}
		return answer;
	};
}

/** The user-role messages (Pi's custom messages among them) that follow tool results after the latest assistant message. */
function addedDuringTools(messages: PiMessage[]): Block[] {
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	const tail = messages.slice(start), first = tail.findIndex(message => message.role === "toolResult");
	if (first < 0) return [];
	const blocks: Block[] = [];
	for (const message of tail.slice(first)) {
		if (message.role !== "user") continue;
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
		for (const block of content) {
			if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return blocks.length ? [{ type: "text", text: "Added to the conversation while this tool ran, not part of its output:" }, ...blocks] : [];
}

interface SessionMeta { antigravity?: { disabledTools?: string[]; eagerMcpServers?: string[] } }
interface Connection { sessionToolMetadata?: () => SessionMeta }

/** The MCP server through which the provider offers Pi's tools. */
const PI_BRIDGE = "pi-bridge";
/**
 * Antigravity's own tools that Pi's cover: commands, files, search, the web, questions, subagents and timers. Calls
 * to them bypassed Pi's command guard and Desk's change tracking, asked for permission where Pi's would not, and kept
 * their results out of Desk's tool cards. Its image generation and "finish" stay.
 */
const COVERED_BY_PI = ["run_command", "view_file", "create_file", "edit_file", "list_directory", "search_directory", "find_file",
	"search_web", "read_url_content", "ask_question", "invoke_subagent", "run_workflow", "schedule"];

/**
 * The server lists the tools of a client's MCP servers in Gemini's instructions by name only, and Gemini reads one's
 * description from a file before its first call; Antigravity's own tools are declared to the model in full. So Pi's
 * tools, plan tools included, were the ones Gemini knew least about, and it reached for Antigravity's terminal first.
 * Each session asks the server (session options in _meta.antigravity, 2026 builds) to declare Pi's tools in full
 * (eagerMcpServers) and to leave out its own tools that Pi's cover (disabledTools).
 *
 * The server also takes a client's system instructions (systemPrompt.append), but it refused every model call of a
 * session whose instructions held Pi's opening line ("… running inside pi, a coding agent harness …"), answering
 * "Resource has been exhausted" while the account had 95% of its allowance left. Pi's prompt stays in the first
 * message.
 */
function offerPiToolsNatively(runtime: Members): void {
	if (typeof runtime.connectionFactory !== "function") return;
	const create = runtime.connectionFactory as (options: ConnectionOptions) => Connection;
	runtime.connectionFactory = (options: ConnectionOptions) => {
		const connection = create(options), meta = connection.sessionToolMetadata?.bind(connection);
		if (meta) connection.sessionToolMetadata = () => {
			const base = meta();
			return { ...base, antigravity: { ...base?.antigravity, eagerMcpServers: [PI_BRIDGE],
				disabledTools: [...new Set([...base?.antigravity?.disabledTools ?? [], ...COVERED_BY_PI])] } };
		};
		return connection;
	};
}

interface ConnectionOptions { initializeTimeoutMs?: number; env?: NodeJS.ProcessEnv }

/**
 * Every server the provider starts goes through its connection factory, which this wraps.
 *
 * The Windows server is a PyInstaller program that unpacks about 140 MB of its own files into a new temporary folder
 * at every start, and Defender scans them with several cores: on the work laptop the first answer came 10 to 27 s
 * after the start, so with the provider's 30 s limit sign-in and conversations failed under load. Each connection
 * waits up to START_TIMEOUT_MS instead. The provider stops a server by ending its process tree, so the unpacker never
 * deletes its folder; those are swept up (sweepUnpacks).
 *
 * On Windows the server's HTTPS also goes through a proxy in this process (relay.ts), which lets it work behind TLS
 * inspection such as the work laptop's Netskope; it is pointed there unless its environment names a proxy or
 * certificates of its own. The factory is synchronous and the proxy's port is known only once it listens, so the
 * runtime's methods that start servers (SERVER_STARTS) wait for that first.
 *
 * Starting servers at once on Windows multiplies the cost: when a conversation's first message on the laptop came with
 * the model list and the allowance figures, three servers started together and none answered within the 2 minutes,
 * while one alone answered in 27 s. There a process starts one at a time, a conversation's own ahead of the others.
 */
function adjustConnections(runtime: Members): void {
	if (typeof runtime.connectionFactory !== "function") return;
	const create = runtime.connectionFactory as (options: ConnectionOptions) => unknown;
	const windows = process.platform === "win32", relay = windows ? openRelay() : undefined;
	const queue = windows ? oneAtATime() : undefined;
	for (const method of windows ? SERVER_STARTS : []) {
		const start = runtime[method];
		if (typeof start !== "function") continue;
		runtime[method] = async (...args: unknown[]) => {
			await relay?.relay.ready;
			const run = () => (start as (...args: unknown[]) => Promise<unknown>).apply(runtime, args);
			// A sign-in lasts as long as Jordan takes in the browser, so it doesn't hold up the others.
			return method === "loginGoogle" ? run() : queue!(method === "createBinding", run);
		};
	}
	runtime.connectionFactory = (options: ConnectionOptions) => {
		if (windows) sweepUnpacks();
		const env = relay && options?.env ? throughRelay(options.env, relay) : undefined;
		return create({ ...options, initializeTimeoutMs: Math.max(options?.initializeTimeoutMs ?? 0, START_TIMEOUT_MS), ...(env ? { env } : {}) });
	};
}

/** The runtime's methods that call the connection factory (0.1.23); all are async. A conversation's own server comes from createBinding. */
const SERVER_STARTS = ["discoverModels", "fetchQuota", "loginGoogle", "verifyApiKey", "createBinding"];

/** Runs one task at a time, in arrival order except that urgent ones go ahead of waiting ones that aren't. */
function oneAtATime(): <T>(urgent: boolean, task: () => Promise<T>) => Promise<T> {
	const waiting: { urgent: boolean; go: () => void }[] = [];
	let running = false;
	return async (urgent, task) => {
		if (running) await new Promise<void>(go => {
			const ahead = urgent ? waiting.findIndex(entry => !entry.urgent) : -1;
			waiting.splice(ahead < 0 ? waiting.length : ahead, 0, { urgent, go });
		});
		running = true;
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			running = !!next;
			next?.go();
		}
	};
}
const OWN_NETWORK_SETTINGS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "PI_ANTIGRAVITY_ACP_PROXY", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];
/**
 * The server's environment for the relay. Its Python reads REQUESTS_CA_BUNDLE (requests) and SSL_CERT_FILE (urllib,
 * httpx, aiohttp), its gRPC GRPC_DEFAULT_SSL_ROOTS_FILE_PATH, and its Go harness SSL_CERT_FILE, which on Windows
 * replaces the system's certificates, so the bundle holds those as well as the relay's authority.
 */
function throughRelay(env: NodeJS.ProcessEnv, { relay, bundle }: { relay: Relay; bundle: string }): NodeJS.ProcessEnv | undefined {
	if (!relay.url || Object.entries(env).some(([key, value]) => value && OWN_NETWORK_SETTINGS.includes(key.toUpperCase()))) return undefined;
	return { ...env, REQUESTS_CA_BUNDLE: bundle, SSL_CERT_FILE: bundle, GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: bundle, HTTPS_PROXY: relay.url };
}

/** Starts the relay and writes ca-bundle.pem beside the provider's config: the certificates Node trusts and the relay's. */
function openRelay(): { relay: Relay; bundle: string } | undefined {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim().replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), ".pi", "agent");
		const folder = join(agentDir, "antigravity-acp-provider"), bundle = join(folder, "ca-bundle.pem");
		mkdirSync(folder, { recursive: true });
		const trusted = trustedCertificates(), relay = startRelay(folder, trusted);
		const text = `${[...trusted, relay.authority.trim()].join("\n")}\n`;
		if (!existsSync(bundle) || readFileSync(bundle, "utf8") !== text) {
			// A server starting meanwhile reads the old file or the new one, never half of one.
			const temp = `${bundle}.${process.pid}.tmp`;
			writeFileSync(temp, text);
			renameSync(temp, bundle);
		}
		return { relay, bundle };
	} catch { return undefined; }
}

/** The certificates Node trusts: its own, the system's and NODE_EXTRA_CA_CERTS. */
function trustedCertificates(): string[] {
	const certificates = new Set<string>();
	const add = (list: readonly string[] | undefined) => { for (const pem of list ?? []) certificates.add(pem.trim()); };
	if (typeof tls.getCACertificates === "function") for (const kind of ["default", "system", "extra"] as const) add(tls.getCACertificates(kind));
	else {
		add(tls.rootCertificates);
		const extra = process.env.NODE_EXTRA_CA_CERTS;
		if (extra) add(readFileSync(extra, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
	}
	return [...certificates];
}

let swept = 0;
/**
 * Removes Antigravity's unpack folders (_MEI, then its process ID in 8 hex digits) whose process has ended. A folder
 * is recognised by the server's licence file, so other PyInstaller programs' folders are left alone.
 */
function sweepUnpacks(): void {
	if (Date.now() - swept < SWEEP_INTERVAL_MS) return;
	swept = Date.now();
	void (async () => {
		const temp = tmpdir();
		for (const name of await readdir(temp).catch(() => [] as string[])) {
			const pid = /^_MEI([0-9a-f]{8})[0-9a-f]*$/i.exec(name)?.[1];
			const folder = join(temp, name);
			if (!pid || !existsSync(join(folder, "agy_acp_licenses.txt")) || running(parseInt(pid, 16))) continue;
			await rm(folder, { recursive: true, force: true }).catch(() => {});
		}
	})();
}
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

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

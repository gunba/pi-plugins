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
	adjustConnections(runtime);
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

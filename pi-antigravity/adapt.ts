import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

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
 * Its Python also trusts only the certificates it ships, not Windows': behind the work laptop's Netskope inspection,
 * which signs Google's sites with RSM's own certificate, Google's sign-in page completed and the token exchange that
 * follows failed. On Windows the server gets the certificates Node trusts, including Windows' and those in
 * NODE_EXTRA_CA_CERTS, unless its environment already names a bundle.
 */
function adjustConnections(runtime: Members): void {
	if (typeof runtime.connectionFactory !== "function") return;
	const create = runtime.connectionFactory as (options: ConnectionOptions) => unknown;
	runtime.connectionFactory = (options: ConnectionOptions) => {
		const windows = process.platform === "win32", bundle = windows ? trustedCertificates() : undefined;
		if (windows) sweepUnpacks();
		return create({ ...options, initializeTimeoutMs: Math.max(options?.initializeTimeoutMs ?? 0, START_TIMEOUT_MS),
			...(bundle && options?.env ? { env: { REQUESTS_CA_BUNDLE: bundle, SSL_CERT_FILE: bundle, GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: bundle, ...options.env } } : {}) });
	};
}

let bundlePath: string | undefined;
/** The certificates Node trusts, written once per process as a PEM bundle beside the provider's config. */
function trustedCertificates(): string | undefined {
	if (bundlePath !== undefined) return bundlePath || undefined;
	bundlePath = "";
	try {
		const certificates = new Set<string>();
		const add = (list: readonly string[] | undefined) => { for (const pem of list ?? []) certificates.add(pem.trim()); };
		if (typeof tls.getCACertificates === "function") for (const kind of ["default", "system", "extra"] as const) add(tls.getCACertificates(kind));
		else {
			add(tls.rootCertificates);
			const extra = process.env.NODE_EXTRA_CA_CERTS;
			if (extra) add(readFileSync(extra, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
		}
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim().replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), ".pi", "agent");
		const file = join(agentDir, "antigravity-acp-provider", "ca-bundle.pem"), text = `${[...certificates].join("\n")}\n`;
		mkdirSync(join(agentDir, "antigravity-acp-provider"), { recursive: true });
		if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
		bundlePath = file;
	} catch { /* The server keeps its own certificates. */ }
	return bundlePath || undefined;
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

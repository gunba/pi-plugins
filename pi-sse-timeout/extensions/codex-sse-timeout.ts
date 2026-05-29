import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;

type State = {
  enabled: boolean;
  timeoutMs: number;
  patchedFetch?: typeof fetch;
  originalFetch?: typeof fetch;
  counters: Record<string, number>;
};

const GLOBAL_KEY = Symbol.for("pi.sseTimeout.state");
const FETCH_PATCH_KEY = Symbol.for("pi.sseTimeout.fetchPatchVersion");
const EXTENSION_NAME = "pi-sse-timeout";
const PATCH_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const BUILTIN_CODEX_SSE_HEADER_TIMEOUT_RE = /^Codex SSE response headers timed out after 10000ms$/;
const CONFIG_DIR = process.env.PI_SSE_TIMEOUT_DIR || join(os.homedir(), ".pi", "agent", "pi-sse-timeout");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOG_FILE = join(CONFIG_DIR, "events.ndjson");
const ENV_TIMEOUT = "PI_CODEX_SSE_HEADER_TIMEOUT_MS";

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function parseTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && /^(off|disable|disabled)$/i.test(value.trim())) return 10_000;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function readConfigTimeout(): number {
  const envTimeout = parseTimeout(process.env[ENV_TIMEOUT]);
  if (envTimeout !== undefined) return envTimeout;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { timeoutMs?: unknown };
    return parseTimeout(parsed.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

function writeConfigTimeout(timeoutMs: number) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ timeoutMs }, null, 2), "utf8");
}

function getState(): State {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: State };
  if (!g[GLOBAL_KEY]) {
    const timeoutMs = readConfigTimeout();
    g[GLOBAL_KEY] = {
      enabled: process.env.PI_SSE_TIMEOUT_DISABLE !== "1",
      timeoutMs,
      counters: {},
    };
  }
  return g[GLOBAL_KEY]!;
}

function log(state: State, event: string, data: Json = {}) {
  state.counters[event] = (state.counters[event] || 0) + 1;
  mkdirSync(CONFIG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, `${JSON.stringify({ ts: nowIso(), event, pid: process.pid, ...data })}\n`, "utf8");
}

function isCodexResponsesUrl(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    return url.hostname === "chatgpt.com" && url.pathname.endsWith("/backend-api/codex/responses");
  } catch {
    return false;
  }
}

function headersFrom(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof Request !== "undefined" && input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

function summarizeHeaders(headers: Headers): Json {
  const sessionId = headers.get("session-id") || undefined;
  const clientRequestId = headers.get("x-client-request-id") || undefined;
  return {
    openai_beta: headers.get("openai-beta") || headers.get("OpenAI-Beta") || undefined,
    session_id: sessionId ? { prefix: sessionId.slice(0, 8), length: sessionId.length, sha256_16: hash16(sessionId) } : undefined,
    x_client_request_id: clientRequestId ? { prefix: clientRequestId.slice(0, 8), length: clientRequestId.length, sha256_16: hash16(clientRequestId) } : undefined,
  };
}

function summarizeBody(body: unknown): Json | undefined {
  if (typeof body !== "string") return undefined;
  const out: Json = {
    bytes: Buffer.byteLength(body, "utf8"),
    sha256_16: hash16(body),
  };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const cacheKey = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : undefined;
    const input = Array.isArray(parsed.input) ? parsed.input : [];
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    out.payload = {
      model: parsed.model,
      service_tier: parsed.service_tier,
      reasoning: parsed.reasoning,
      prompt_cache_key: cacheKey ? { prefix: cacheKey.slice(0, 8), length: cacheKey.length, sha256_16: hash16(cacheKey) } : undefined,
      input_count: input.length,
      tool_count: tools.length,
      approx_text_chars: countTextChars(input),
      function_output_bytes: countFunctionOutputBytes(input),
    };
  } catch {
    // Keep hash/bytes only.
  }
  return out;
}

function countTextChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTextChars(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + countTextChars(item), 0);
}

function countFunctionOutputBytes(input: unknown[]): number {
  let bytes = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "function_call_output" && typeof obj.output === "string") {
      bytes += Buffer.byteLength(obj.output, "utf8");
    }
  }
  return bytes;
}

function isBuiltinHeaderTimeout(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : reason && typeof reason === "object" && "message" in reason
        ? String((reason as { message?: unknown }).message)
        : String(reason ?? "");
  return BUILTIN_CODEX_SSE_HEADER_TIMEOUT_RE.test(message);
}

function errorInfo(error: unknown): Json {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function configuredTimeoutError(timeoutMs: number): Error {
  return new Error(`Codex SSE response headers timed out after ${timeoutMs}ms (configured by pi-sse-timeout)`);
}

function syntheticCodexErrorResponse(message: string, code = "pi_sse_timeout"): Response {
  return new Response(`data: ${JSON.stringify({ type: "error", code, message })}\n\n`, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function cleanupResponseBody(response: Response, cleanup: () => void): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchWithConfiguredTimeout(
  state: State,
  originalFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const fetchId = randomUUID();
  const start = performance.now();
  const callerSignal = init?.signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressedBuiltinTimeout = false;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  const onCallerAbort = () => {
    const reason = callerSignal?.reason;
    if (isBuiltinHeaderTimeout(reason)) {
      suppressedBuiltinTimeout = true;
      log(state, "sse_builtin_header_timeout_suppressed", {
        fetchId,
        elapsedMs: elapsedMs(start),
        configuredTimeoutMs: state.timeoutMs,
      });
      return;
    }
    controller.abort(reason ?? new Error("Request was aborted"));
  };

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: false });
  }

  if (state.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(configuredTimeoutError(state.timeoutMs)), state.timeoutMs);
  }

  log(state, "sse_fetch_start", {
    fetchId,
    configuredTimeoutMs: state.timeoutMs,
    url: typeof input === "string" ? input.replace(/^https:\/\/chatgpt\.com/, "https://chatgpt.com") : undefined,
    headers: summarizeHeaders(headersFrom(input, init)),
    body: summarizeBody(init?.body),
  });

  try {
    const response = await originalFetch(input, { ...init, signal: controller.signal });
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    log(state, "sse_fetch_headers", {
      fetchId,
      elapsedMs: elapsedMs(start),
      status: response.status,
      suppressedBuiltinTimeout,
      headers: {
        content_type: response.headers.get("content-type") || undefined,
        cf_ray: response.headers.get("cf-ray") || undefined,
        retry_after: response.headers.get("retry-after") || undefined,
        request_id: response.headers.get("x-request-id") || response.headers.get("request-id") || undefined,
      },
    });
    return cleanupResponseBody(response, cleanup);
  } catch (error) {
    cleanup();
    const reason = controller.signal.reason;
    const thrown = controller.signal.aborted && reason instanceof Error ? reason : error;
    const info = errorInfo(thrown);
    log(state, "sse_fetch_error", {
      fetchId,
      elapsedMs: elapsedMs(start),
      suppressedBuiltinTimeout,
      error: info,
    });

    if (suppressedBuiltinTimeout) {
      const message =
        typeof info.message === "string" && info.message.trim()
          ? info.message
          : "Codex SSE request failed after Pi's built-in 10s header timeout was suppressed by pi-sse-timeout";
      log(state, "sse_synthetic_error_response", {
        fetchId,
        elapsedMs: elapsedMs(start),
        configuredTimeoutMs: state.timeoutMs,
        message,
      });
      return syntheticCodexErrorResponse(message);
    }

    throw thrown;
  }
}

function fetchPatchVersion(value: unknown): number | undefined {
  if (typeof value !== "function") return undefined;
  const version = Reflect.get(value, FETCH_PATCH_KEY);
  return typeof version === "number" ? version : undefined;
}

function installFetchPatch(state: State) {
  if (typeof globalThis.fetch !== "function") return;

  const currentFetch = globalThis.fetch as typeof fetch;
  const currentPatchVersion = fetchPatchVersion(currentFetch);
  if (currentPatchVersion === PATCH_VERSION) {
    state.patchedFetch = currentFetch;
    return;
  }

  const replacingLegacyPatch = state.patchedFetch && currentFetch === state.patchedFetch && state.originalFetch;
  const originalFetch = replacingLegacyPatch
    ? state.originalFetch!
    : (currentFetch.bind(globalThis) as typeof fetch);
  const mode = !state.patchedFetch
    ? "install"
    : replacingLegacyPatch
      ? "replace_legacy"
      : currentPatchVersion === undefined
        ? "rewrap_outermost"
        : "upgrade_patch";

  const patchedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = getState();
    if (!current.enabled || !isCodexResponsesUrl(input)) return originalFetch(input, init);
    return fetchWithConfiguredTimeout(current, originalFetch, input, init);
  }) as typeof fetch;

  Object.defineProperty(patchedFetch, FETCH_PATCH_KEY, {
    value: PATCH_VERSION,
    enumerable: false,
    configurable: false,
  });

  state.originalFetch = originalFetch;
  state.patchedFetch = patchedFetch;
  globalThis.fetch = patchedFetch;
  log(state, mode === "install" ? "patch_installed" : "patch_reinstalled", {
    timeoutMs: state.timeoutMs,
    mode,
    previousPatchVersion: currentPatchVersion,
  });
}

function statusText(state: State): string {
  return [
    `pi-sse-timeout: ${state.enabled ? "enabled" : "disabled"}`,
    `Codex SSE response-header timeout: ${state.timeoutMs === 0 ? "disabled" : `${state.timeoutMs}ms`}`,
    `Config: ${CONFIG_FILE}`,
    `Log: ${LOG_FILE}`,
    `Env override: ${ENV_TIMEOUT}`,
    `Patch: v${PATCH_VERSION}, ${globalThis.fetch === state.patchedFetch ? "outermost" : "not outermost"}`,
    `Counters: ${JSON.stringify(state.counters)}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const state = getState();

  pi.on("session_start", async (_event: any, ctx: any) => {
    state.timeoutMs = readConfigTimeout();
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, state.enabled ? `sse:${state.timeoutMs}ms` : "sse-timeout:off");
  });

  pi.on("before_provider_request", async () => {
    // Pi can call configureHttpDispatcher() after extension load, replacing
    // global fetch. Reinstall immediately before each provider request.
    state.timeoutMs = readConfigTimeout();
    installFetchPatch(state);
  });

  pi.registerCommand("sse-timeout", {
    description: "Show or set the Codex SSE response-header timeout override",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(statusText(state), "info");
        return;
      }
      if (trimmed === "off" || trimmed === "disable") {
        state.enabled = false;
        ctx.ui.setStatus(EXTENSION_NAME, "sse-timeout:off");
        ctx.ui.notify(statusText(state), "info");
        return;
      }
      if (trimmed === "on" || trimmed === "enable") {
        state.enabled = true;
        installFetchPatch(state);
        ctx.ui.setStatus(EXTENSION_NAME, `sse:${state.timeoutMs}ms`);
        ctx.ui.notify(statusText(state), "info");
        return;
      }
      const match = trimmed.match(/^(?:set\s+)?(\d+)$/i);
      if (!match) {
        ctx.ui.notify("Usage: /sse-timeout [status|on|off|set <ms>|<ms>]", "warning");
        return;
      }
      const timeoutMs = Number(match[1]);
      state.timeoutMs = timeoutMs;
      state.enabled = true;
      writeConfigTimeout(timeoutMs);
      if (!state.patchedFetch) installFetchPatch(state);
      ctx.ui.setStatus(EXTENSION_NAME, `sse:${state.timeoutMs}ms`);
      ctx.ui.notify(statusText(state), "info");
    },
  });
}

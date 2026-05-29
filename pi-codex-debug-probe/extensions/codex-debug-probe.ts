import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonRecord = Record<string, unknown>;

type ProbeState = {
  enabled: boolean;
  log?: (event: string, data?: JsonRecord) => void;
  counters: Record<string, number>;
  originalFetch?: typeof fetch;
  patchedFetch?: typeof fetch;
  originalWebSocket?: typeof WebSocket;
  patchedWebSocket?: typeof WebSocket;
};

const GLOBAL_KEY = Symbol.for("pi.codexDebugProbe.state");
const EXTENSION_NAME = "codex-debug-probe";
const DEFAULT_LOG_DIR = join(os.homedir(), ".pi", "agent", "codex-debug-probe");
const LOG_DIR = process.env.CODEX_DEBUG_PROBE_DIR || DEFAULT_LOG_DIR;
const LOG_FILE = join(LOG_DIR, "events.ndjson");
const SUMMARY_FILE = join(LOG_DIR, "latest-summary.json");
const LOG_RAW_IDS = envFlag("CODEX_DEBUG_PROBE_LOG_RAW_IDS");

function envFlag(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value);
}

function getState(): ProbeState {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ProbeState };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { enabled: process.env.CODEX_DEBUG_PROBE !== "0", counters: {} };
  }
  return g[GLOBAL_KEY]!;
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string | Uint8Array): string {
  return hash(value).slice(0, 16);
}

function summarizeId(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const out: JsonRecord = {
    prefix: value.slice(0, 8),
    length: value.length,
    sha256_16: shortHash(value),
  };
  if (LOG_RAW_IDS) out.raw = value;
  return out;
}

function summarizeText(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  return { chars: value.length, bytes: Buffer.byteLength(value, "utf8"), sha256_16: shortHash(value) };
}

function safeError(error: unknown): JsonRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as Error & { code?: unknown }).code,
      reason: summarizeAbortReason((error as Error & { reason?: unknown }).reason),
    };
  }
  return { message: String(error) };
}

function summarizeAbortReason(reason: unknown): unknown {
  if (!reason) return undefined;
  if (reason instanceof Error) return safeError(reason);
  if (typeof reason === "string") return reason;
  if (typeof reason === "object") {
    const r = reason as Record<string, unknown>;
    return {
      name: typeof r.name === "string" ? r.name : undefined,
      message: typeof r.message === "string" ? r.message : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    };
  }
  return String(reason);
}

function isCodexUrl(url: unknown): boolean {
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as { url?: string })?.url;
    if (!raw) return false;
    const parsed = new URL(raw);
    return parsed.pathname.endsWith("/codex/responses") || parsed.pathname.includes("/codex/responses");
  } catch {
    return false;
  }
}

function urlSummary(url: unknown): JsonRecord {
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as { url?: string })?.url || String(url);
    const parsed = new URL(raw);
    return { protocol: parsed.protocol, host: parsed.host, pathname: parsed.pathname };
  } catch {
    return { rawType: typeof url };
  }
}

function headersObject(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function headersFromFetch(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof Request !== "undefined" && input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

function summarizeRequestHeaders(headers: Headers): JsonRecord {
  return {
    content_type: headers.get("content-type") || undefined,
    content_length: headers.get("content-length") || undefined,
    openai_beta: headers.get("openai-beta") || headers.get("OpenAI-Beta") || undefined,
    session_id: summarizeId(headers.get("session-id") || undefined),
    x_client_request_id: summarizeId(headers.get("x-client-request-id") || undefined),
    user_agent: summarizeUserAgent(headers.get("user-agent") || undefined),
  };
}

function summarizeResponseHeaders(headers: Headers): JsonRecord {
  const h = headersObject(headers);
  const out: JsonRecord = {};
  for (const key of [
    "date",
    "server",
    "content-type",
    "content-length",
    "transfer-encoding",
    "cf-ray",
    "cf-cache-status",
    "x-request-id",
    "request-id",
    "retry-after",
    "retry-after-ms",
    "openai-processing-ms",
    "x-envoy-upstream-service-time",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  ]) {
    if (h[key]) out[key] = h[key];
  }
  return out;
}

function summarizeUserAgent(value: string | undefined): JsonRecord | undefined {
  if (!value) return undefined;
  return { chars: value.length, sha256_16: shortHash(value), prefix: value.slice(0, 40) };
}

function byteLengthOfBody(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}

function summarizeFetchBody(body: unknown): JsonRecord {
  const bytes = byteLengthOfBody(body);
  const out: JsonRecord = { bytes };
  if (typeof body === "string") {
    out.sha256_16 = shortHash(body);
    try {
      out.payload = summarizePayload(JSON.parse(body));
    } catch {
      out.kind = "string_non_json";
    }
  } else if (body instanceof Uint8Array) {
    out.sha256_16 = shortHash(body);
    out.kind = "uint8array";
  } else if (body instanceof ArrayBuffer) {
    out.sha256_16 = shortHash(new Uint8Array(body));
    out.kind = "arraybuffer";
  } else if (body !== undefined && body !== null) {
    out.kind = Object.prototype.toString.call(body);
  }
  return out;
}

function summarizePayload(payload: unknown): JsonRecord {
  const p = payload as Record<string, unknown>;
  const input = Array.isArray(p.input) ? p.input : [];
  const tools = Array.isArray(p.tools) ? p.tools : [];
  return {
    model: typeof p.model === "string" ? p.model : undefined,
    stream: p.stream,
    store: p.store,
    service_tier: p.service_tier,
    prompt_cache_key: summarizeId(p.prompt_cache_key),
    previous_response_id: summarizeId(p.previous_response_id),
    instructions: summarizeText(p.instructions),
    reasoning: summarizeShallow(p.reasoning),
    text: summarizeShallow(p.text),
    input: summarizeInput(input),
    tools: summarizeTools(tools),
  };
}

function summarizeShallow(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof child === "string" ? child : typeof child === "number" || typeof child === "boolean" ? child : child === null ? null : Object.prototype.toString.call(child);
  }
  return out;
}

function summarizeInput(input: unknown[]): JsonRecord {
  const counts: Record<string, number> = {};
  let textChars = 0;
  let textBytes = 0;
  let imageCount = 0;
  let functionOutputCount = 0;
  let functionOutputBytes = 0;
  for (const item of input) {
    const type = typeof item === "object" && item ? String((item as Record<string, unknown>).type || "object") : typeof item;
    counts[type] = (counts[type] || 0) + 1;
    const metrics = collectTextMetrics(item);
    textChars += metrics.chars;
    textBytes += metrics.bytes;
    imageCount += metrics.images;
    functionOutputCount += metrics.functionOutputs;
    functionOutputBytes += metrics.functionOutputBytes;
  }
  return { count: input.length, counts, textChars, textBytes, imageCount, functionOutputCount, functionOutputBytes };
}

function collectTextMetrics(value: unknown): { chars: number; bytes: number; images: number; functionOutputs: number; functionOutputBytes: number } {
  if (typeof value === "string") return { chars: value.length, bytes: Buffer.byteLength(value, "utf8"), images: 0, functionOutputs: 0, functionOutputBytes: 0 };
  if (!value || typeof value !== "object") return { chars: 0, bytes: 0, images: 0, functionOutputs: 0, functionOutputBytes: 0 };
  if (Array.isArray(value)) {
    return value.reduce(
      (acc, child) => addMetrics(acc, collectTextMetrics(child)),
      { chars: 0, bytes: 0, images: 0, functionOutputs: 0, functionOutputBytes: 0 },
    );
  }
  const obj = value as Record<string, unknown>;
  let metrics = { chars: 0, bytes: 0, images: 0, functionOutputs: 0, functionOutputBytes: 0 };
  if (obj.type === "input_image" || obj.type === "image_url") metrics.images++;
  if (obj.type === "function_call_output" && typeof obj.output === "string") {
    metrics.functionOutputs++;
    metrics.functionOutputBytes += Buffer.byteLength(obj.output, "utf8");
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key === "image_url" || key === "data" || key === "url") {
      if (typeof child === "string" && child.startsWith("data:")) metrics.images++;
      continue;
    }
    metrics = addMetrics(metrics, collectTextMetrics(child));
  }
  return metrics;
}

function addMetrics(a: ReturnType<typeof collectTextMetrics>, b: ReturnType<typeof collectTextMetrics>): ReturnType<typeof collectTextMetrics> {
  return {
    chars: a.chars + b.chars,
    bytes: a.bytes + b.bytes,
    images: a.images + b.images,
    functionOutputs: a.functionOutputs + b.functionOutputs,
    functionOutputBytes: a.functionOutputBytes + b.functionOutputBytes,
  };
}

function summarizeTools(tools: unknown[]): JsonRecord {
  const names = tools
    .map((tool) => (typeof tool === "object" && tool ? (tool as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === "string")
    .slice(0, 100);
  return { count: tools.length, names };
}

function summarizeMessage(message: unknown): JsonRecord {
  const m = message as Record<string, unknown>;
  const content = Array.isArray(m.content) ? m.content : [];
  const usage = m.usage as Record<string, unknown> | undefined;
  return {
    role: m.role,
    stopReason: m.stopReason,
    errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
    api: m.api,
    provider: m.provider,
    model: m.model,
    responseId: summarizeId(m.responseId),
    content: summarizeContentBlocks(content),
    usage: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens: usage.totalTokens,
        }
      : undefined,
  };
}

function summarizeContentBlocks(blocks: unknown[]): JsonRecord {
  const counts: Record<string, number> = {};
  let textChars = 0;
  let thinkingChars = 0;
  let toolCalls = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "object";
    counts[type] = (counts[type] || 0) + 1;
    if (typeof b.text === "string") textChars += b.text.length;
    if (typeof b.thinking === "string") thinkingChars += b.thinking.length;
    if (type === "toolCall") toolCalls++;
  }
  return { count: blocks.length, counts, textChars, thinkingChars, toolCalls };
}

function summarizeEnv(): JsonRecord {
  const envNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const proxyEnv: JsonRecord = {};
  for (const name of envNames) {
    const value = process.env[name];
    if (!value) continue;
    proxyEnv[name] = summarizeProxyValue(value);
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    versions: {
      node: process.versions.node,
      uv: process.versions.uv,
      openssl: process.versions.openssl,
      undici: (process.versions as Record<string, string | undefined>).undici,
      v8: process.versions.v8,
    },
    os: {
      type: os.type(),
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : undefined,
      hostname_sha256_16: shortHash(os.hostname()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    proxyEnv,
    networkInterfaces: summarizeNetworkInterfaces(),
  };
}

function summarizeProxyValue(value: string): JsonRecord {
  try {
    const parsed = new URL(value);
    return {
      protocol: parsed.protocol,
      host: parsed.hostname,
      port: parsed.port || undefined,
      hasUsername: parsed.username.length > 0,
      hasPassword: parsed.password.length > 0,
    };
  } catch {
    return { present: true, chars: value.length, sha256_16: shortHash(value) };
  }
}

function summarizeNetworkInterfaces(): JsonRecord[] {
  const interfaces = os.networkInterfaces();
  const out: JsonRecord[] = [];
  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items || []) {
      out.push({
        name,
        family: item.family,
        internal: item.internal,
        cidr: item.cidr ? { prefix: item.cidr.split("/").at(1) } : undefined,
        address_sha256_16: shortHash(item.address),
        mac_sha256_16: shortHash(item.mac),
      });
    }
  }
  return out;
}

function readJsonIfExists(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function summarizeSettings(cwd: string): JsonRecord {
  const globalSettings = readJsonIfExists(join(os.homedir(), ".pi", "agent", "settings.json"));
  const projectSettings = readJsonIfExists(join(cwd, ".pi", "settings.json"));
  const pick = (settings: unknown): JsonRecord | undefined => {
    if (!settings || typeof settings !== "object") return undefined;
    const s = settings as Record<string, unknown>;
    const retry = s.retry as Record<string, unknown> | undefined;
    return {
      defaultProvider: s.defaultProvider,
      defaultModel: s.defaultModel,
      defaultThinkingLevel: s.defaultThinkingLevel,
      transport: s.transport,
      httpIdleTimeoutMs: s.httpIdleTimeoutMs,
      websocketConnectTimeoutMs: s.websocketConnectTimeoutMs,
      retry: retry
        ? {
            enabled: retry.enabled,
            maxRetries: retry.maxRetries,
            baseDelayMs: retry.baseDelayMs,
            provider: retry.provider,
          }
        : undefined,
      packagesCount: Array.isArray(s.packages) ? s.packages.length : undefined,
      extensionsCount: Array.isArray(s.extensions) ? s.extensions.length : undefined,
    };
  };
  return { global: pick(globalSettings), project: pick(projectSettings) };
}

function incrementCounter(state: ProbeState, event: string) {
  state.counters[event] = (state.counters[event] || 0) + 1;
}

function installGlobalPatches(state: ProbeState) {
  // Pi configures undici after extension load; undici.install() can replace
  // global fetch/WebSocket. Re-apply lazily before provider requests if that
  // happened, while avoiding stacked wrappers around our own patched functions.
  if (typeof globalThis.fetch === "function" && globalThis.fetch !== state.patchedFetch) {
    state.originalFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
    const patchedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const current = getState();
      if (!current.enabled || !isCodexUrl(input)) {
        return current.originalFetch!(input, init);
      }
      return instrumentedFetch(current, input, init);
    }) as typeof fetch;
    state.patchedFetch = patchedFetch;
    globalThis.fetch = patchedFetch;
    state.log?.("probe_patch_fetch_installed", {});
  }
  if (typeof globalThis.WebSocket === "function" && globalThis.WebSocket !== state.patchedWebSocket) {
    state.originalWebSocket = globalThis.WebSocket;
    const OriginalWebSocket = state.originalWebSocket;
    class ProbeWebSocket extends OriginalWebSocket {
      private __probeTarget = false;
      private __probeId = randomUUID();
      private __probeStart = performance.now();
      private __probeMessages = 0;
      private __probeBytes = 0;
      constructor(url: string | URL, protocols?: string | string[], options?: unknown) {
        // @ts-expect-error WebSocket constructor differs between runtimes.
        super(url, protocols as never, options as never);
        this.__probeTarget = isCodexUrl(url);
        if (!this.__probeTarget) return;
        const headers = typeof protocols === "object" && !Array.isArray(protocols) ? new Headers((protocols as { headers?: HeadersInit }).headers) : new Headers();
        logGlobal("codex_ws_construct", {
          wsId: this.__probeId,
          url: urlSummary(url),
          headers: summarizeRequestHeaders(headers),
        });
        this.addEventListener("open", () => logGlobal("codex_ws_open", { wsId: this.__probeId, elapsedMs: elapsedMs(this.__probeStart) }));
        this.addEventListener("error", (event) => logGlobal("codex_ws_error", { wsId: this.__probeId, elapsedMs: elapsedMs(this.__probeStart), error: summarizeWebSocketEvent(event) }));
        this.addEventListener("close", (event) => logGlobal("codex_ws_close", { wsId: this.__probeId, elapsedMs: elapsedMs(this.__probeStart), messages: this.__probeMessages, bytes: this.__probeBytes, close: summarizeWebSocketEvent(event) }));
        this.addEventListener("message", (event) => {
          this.__probeMessages++;
          const data = (event as MessageEvent).data;
          const text = typeof data === "string" ? data : undefined;
          const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : undefined;
          if (bytes) this.__probeBytes += bytes;
          if (this.__probeMessages === 1 || isTerminalWsEvent(text)) {
            logGlobal("codex_ws_message", {
              wsId: this.__probeId,
              elapsedMs: elapsedMs(this.__probeStart),
              ordinal: this.__probeMessages,
              bytes,
              event: summarizeWsMessage(text),
            });
          }
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (this.__probeTarget) {
          const text = typeof data === "string" ? data : undefined;
          logGlobal("codex_ws_send", {
            wsId: this.__probeId,
            elapsedMs: elapsedMs(this.__probeStart),
            bytes: typeof text === "string" ? Buffer.byteLength(text, "utf8") : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : undefined,
            payload: summarizeWsSend(text),
          });
        }
        return super.send(data);
      }
    }
    try {
      Object.defineProperty(ProbeWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
      Object.defineProperty(ProbeWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
      Object.defineProperty(ProbeWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
      Object.defineProperty(ProbeWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });
    } catch {
      // Non-fatal: some runtimes do not allow redefining WebSocket constants.
    }
    state.patchedWebSocket = ProbeWebSocket as typeof WebSocket;
    globalThis.WebSocket = state.patchedWebSocket;
    state.log?.("probe_patch_websocket_installed", {});
  }
}

function summarizeWebSocketEvent(event: Event): JsonRecord {
  const e = event as Event & { code?: number; reason?: string; wasClean?: boolean; message?: string; error?: unknown };
  return {
    type: e.type,
    code: e.code,
    reason: e.reason,
    wasClean: e.wasClean,
    message: e.message,
    error: e.error ? safeError(e.error) : undefined,
  };
}

function summarizeWsSend(text: string | undefined): JsonRecord | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { type: parsed.type, payload: summarizePayload(parsed) };
  } catch {
    return { text: summarizeText(text) };
  }
}

function summarizeWsMessage(text: string | undefined): JsonRecord | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { type: parsed.type, responseId: summarizeId((parsed.response as Record<string, unknown> | undefined)?.id) };
  } catch {
    return { text: summarizeText(text) };
  }
}

function isTerminalWsEvent(text: string | undefined): boolean {
  if (!text) return false;
  return /"type"\s*:\s*"(response\.(completed|failed|incomplete|done)|error)"/.test(text);
}

function logGlobal(event: string, data?: JsonRecord) {
  const state = getState();
  state.log?.(event, data);
}

async function instrumentedFetch(state: ProbeState, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchId = randomUUID();
  const start = performance.now();
  const requestHeaders = headersFromFetch(input, init);
  const method = init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
  state.log?.("codex_fetch_start", {
    fetchId,
    method,
    url: urlSummary(input),
    headers: summarizeRequestHeaders(requestHeaders),
    body: summarizeFetchBody(init?.body),
  });
  try {
    const response = await state.originalFetch!(input, init);
    const headersMs = elapsedMs(start);
    state.log?.("codex_fetch_headers", {
      fetchId,
      elapsedMs: headersMs,
      status: response.status,
      statusText: response.statusText,
      headers: summarizeResponseHeaders(response.headers),
    });
    if (!response.body) {
      state.log?.("codex_fetch_no_body", { fetchId, elapsedMs: elapsedMs(start), status: response.status });
      return response;
    }
    return wrapResponseBody(response, fetchId, start, state);
  } catch (error) {
    state.log?.("codex_fetch_error", { fetchId, elapsedMs: elapsedMs(start), error: safeError(error), aborted: init?.signal?.aborted, abortReason: summarizeAbortReason(init?.signal?.reason) });
    throw error;
  }
}

function wrapResponseBody(response: Response, fetchId: string, start: number, state: ProbeState): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let chunks = 0;
  let firstByteMs: number | undefined;
  let firstSseMs: number | undefined;
  let sseBuffer = "";
  const eventCounts: Record<string, number> = {};
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          state.log?.("codex_fetch_stream_done", { fetchId, elapsedMs: elapsedMs(start), chunks, bytes, firstByteMs, firstSseMs, eventCounts });
          controller.close();
          return;
        }
        chunks++;
        bytes += result.value.byteLength;
        if (firstByteMs === undefined) {
          firstByteMs = elapsedMs(start);
          state.log?.("codex_fetch_first_byte", { fetchId, elapsedMs: firstByteMs, chunkBytes: result.value.byteLength });
        }
        consumeSseText(decoder.decode(result.value, { stream: true }), (eventType, eventSummary) => {
          eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
          if (firstSseMs === undefined) {
            firstSseMs = elapsedMs(start);
            state.log?.("codex_fetch_first_sse_event", { fetchId, elapsedMs: firstSseMs, eventType, event: eventSummary });
          }
          if (/^(error|response\.(completed|failed|incomplete|done))$/.test(eventType)) {
            state.log?.("codex_fetch_terminal_sse_event", { fetchId, elapsedMs: elapsedMs(start), eventType, event: eventSummary });
          }
        });
        controller.enqueue(result.value);
      } catch (error) {
        state.log?.("codex_fetch_stream_error", { fetchId, elapsedMs: elapsedMs(start), chunks, bytes, firstByteMs, firstSseMs, error: safeError(error), eventCounts });
        controller.error(error);
      }
    },
    async cancel(reason) {
      state.log?.("codex_fetch_stream_cancel", { fetchId, elapsedMs: elapsedMs(start), chunks, bytes, firstByteMs, firstSseMs, reason: summarizeAbortReason(reason), eventCounts });
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  function consumeSseText(text: string, onEvent: (eventType: string, eventSummary: JsonRecord) => void) {
    sseBuffer += text;
    let idx = sseBuffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = sseBuffer.slice(0, idx);
      sseBuffer = sseBuffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      if (data && data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const type = typeof parsed.type === "string" ? parsed.type : "unknown";
          onEvent(type, {
            type,
            responseId: summarizeId((parsed.response as Record<string, unknown> | undefined)?.id),
            code: parsed.code,
            message: typeof parsed.message === "string" ? parsed.message : undefined,
          });
        } catch {
          onEvent("invalid_json", { data: summarizeText(data) });
        }
      }
      idx = sseBuffer.indexOf("\n\n");
    }
  }

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default function (pi: ExtensionAPI) {
  mkdirSync(LOG_DIR, { recursive: true });
  const state = getState();
  installGlobalPatches(state);

  const log = (event: string, data: JsonRecord = {}) => {
    if (!state.enabled && event !== "probe_disabled") return;
    incrementCounter(state, event);
    const record = {
      ts: nowIso(),
      event,
      pid: process.pid,
      ...data,
    };
    appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
  };
  state.log = log;

  function sessionInfo(ctx: { cwd: string; sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null; getBranch(): unknown[]; getEntries(): unknown[] } }): JsonRecord {
    const sessionId = ctx.sessionManager?.getSessionId();
    const sessionFile = ctx.sessionManager?.getSessionFile();
    return {
      cwd: ctx.cwd,
      sessionId: summarizeId(sessionId),
      sessionFile: sessionFile ? { basename: sessionFile.split(/[\\/]/).pop(), sha256_16: shortHash(sessionFile) } : undefined,
      leafId: summarizeId(ctx.sessionManager?.getLeafId() || undefined),
      branchEntries: ctx.sessionManager?.getBranch().length,
      totalEntries: ctx.sessionManager?.getEntries().length,
    };
  }

  function writeSummary(ctx?: { cwd: string; sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null; getBranch(): unknown[]; getEntries(): unknown[] } }) {
    const summary = {
      generatedAt: nowIso(),
      enabled: state.enabled,
      logDir: LOG_DIR,
      logFile: LOG_FILE,
      counters: state.counters,
      session: ctx ? sessionInfo(ctx) : undefined,
    };
    writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), "utf8");
  }

  pi.on("session_start", async (event, ctx) => {
    installGlobalPatches(state);
    log("session_start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile ? { basename: event.previousSessionFile.split(/[\\/]/).pop(), sha256_16: shortHash(event.previousSessionFile) } : undefined,
      session: sessionInfo(ctx),
      env: summarizeEnv(),
      settings: summarizeSettings(ctx.cwd),
      activeTools: pi.getActiveTools(),
    });
    writeSummary(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, state.enabled ? "codex debug:on" : "codex debug:off");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    log("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile ? { basename: event.targetSessionFile.split(/[\\/]/).pop(), sha256_16: shortHash(event.targetSessionFile) } : undefined, session: sessionInfo(ctx) });
    writeSummary(ctx);
  });

  pi.on("input", async (event, ctx) => {
    log("input", { source: event.source, text: summarizeText(event.text), imageCount: event.images?.length || 0, session: sessionInfo(ctx) });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    log("before_agent_start", {
      prompt: summarizeText(event.prompt),
      imageCount: event.images?.length || 0,
      contextUsage: ctx.getContextUsage?.(),
      systemPrompt: summarizeText(event.systemPrompt),
      selectedTools: event.systemPromptOptions?.selectedTools?.length,
      skills: event.systemPromptOptions?.skills?.length,
      session: sessionInfo(ctx),
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    log("agent_start", { model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined, thinkingLevel: pi.getThinkingLevel(), session: sessionInfo(ctx) });
  });

  pi.on("agent_end", async (event, ctx) => {
    log("agent_end", { messages: event.messages?.length, session: sessionInfo(ctx) });
    writeSummary(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    log("turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp, session: sessionInfo(ctx) });
  });

  pi.on("turn_end", async (event, ctx) => {
    log("turn_end", { turnIndex: event.turnIndex, message: summarizeMessage(event.message), toolResults: event.toolResults?.length, session: sessionInfo(ctx) });
  });

  pi.on("before_provider_request", async (event, ctx) => {
    installGlobalPatches(state);
    let bodyBytes: number | undefined;
    let payloadHash: string | undefined;
    try {
      const serialized = JSON.stringify(event.payload);
      bodyBytes = Buffer.byteLength(serialized, "utf8");
      payloadHash = shortHash(serialized);
    } catch {
      // ignore unserializable payloads
    }
    log("before_provider_request", {
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
      thinkingLevel: pi.getThinkingLevel(),
      bodyBytes,
      payloadHash,
      payload: summarizePayload(event.payload),
      session: sessionInfo(ctx),
    });
  });

  pi.on("after_provider_response", async (event, ctx) => {
    log("after_provider_response", { status: event.status, headers: event.headers, session: sessionInfo(ctx) });
  });

  pi.on("message_start", async (event, ctx) => {
    log("message_start", { message: summarizeMessage(event.message), session: sessionInfo(ctx) });
  });

  pi.on("message_update", async (event, ctx) => {
    const streamEvent = event.assistantMessageEvent as { type?: string } | undefined;
    if (streamEvent?.type === "start" || streamEvent?.type === "error" || streamEvent?.type === "done") {
      log("message_update", { assistantEventType: streamEvent.type, message: summarizeMessage(event.message), session: sessionInfo(ctx) });
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role === "assistant" || message.stopReason === "error" || message.errorMessage) {
      log("message_end", { message: summarizeMessage(event.message), session: sessionInfo(ctx) });
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    log("tool_execution_start", { toolCallId: summarizeId(event.toolCallId), toolName: event.toolName, argsBytes: Buffer.byteLength(JSON.stringify(event.args ?? {}), "utf8"), session: sessionInfo(ctx) });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    log("tool_execution_end", { toolCallId: summarizeId(event.toolCallId), toolName: event.toolName, isError: event.isError, resultBytes: Buffer.byteLength(JSON.stringify(event.result ?? {}), "utf8"), session: sessionInfo(ctx) });
  });

  pi.on("model_select", async (event, ctx) => {
    log("model_select", { source: event.source, previousModel: event.previousModel ? { provider: event.previousModel.provider, id: event.previousModel.id, api: event.previousModel.api } : undefined, model: { provider: event.model.provider, id: event.model.id, api: event.model.api }, session: sessionInfo(ctx) });
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    log("thinking_level_select", { level: event.level, previousLevel: event.previousLevel, session: sessionInfo(ctx) });
  });

  pi.registerCommand("codex-debug", {
    description: "Control and inspect Codex transport/session diagnostics",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "on") {
        state.enabled = true;
        log("probe_enabled", { session: sessionInfo(ctx) });
        ctx.ui.setStatus(EXTENSION_NAME, "codex debug:on");
        ctx.ui.notify(`Codex debug probe enabled. Log: ${LOG_FILE}`, "info");
        return;
      }
      if (command === "off") {
        log("probe_disabled", { session: sessionInfo(ctx) });
        state.enabled = false;
        ctx.ui.setStatus(EXTENSION_NAME, "codex debug:off");
        ctx.ui.notify("Codex debug probe disabled", "info");
        return;
      }
      if (command.startsWith("mark")) {
        const note = command.slice("mark".length).trim();
        log("user_marker", { note: note ? summarizeText(note) : undefined, session: sessionInfo(ctx) });
        ctx.ui.notify("Codex debug marker written", "info");
        return;
      }
      writeSummary(ctx);
      ctx.ui.notify(
        [
          `Codex debug probe: ${state.enabled ? "enabled" : "disabled"}`,
          `Log: ${LOG_FILE}`,
          `Summary: ${SUMMARY_FILE}`,
          `Session: ${JSON.stringify(sessionInfo(ctx).sessionId)}`,
          `Counters: ${JSON.stringify(state.counters)}`,
          "Commands: /codex-debug on | off | status | mark <note>",
        ].join("\n"),
        "info",
      );
    },
  });
}

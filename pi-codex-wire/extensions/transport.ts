import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import { Diagnostics, eventDiagnostics, object, allowanceHeaders, type JsonObject } from "./diagnostics.ts";
import type { Compression } from "./compression.ts";

const require = createRequire(import.meta.url);
const zlib = require("node:zlib") as {
  zstdCompressSync?: (data: string, options: unknown) => Buffer;
  constants: { ZSTD_c_compressionLevel?: number };
};
const encoder = new TextEncoder();
const terminal = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);

export interface Exchange {
  url: string;
  body: JsonObject;
  headers: Headers;
  signal?: AbortSignal;
  requestId: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
  normalizeEvent?: (event: JsonObject) => JsonObject;
  compression?: Compression;
}

export interface WireHooks {
  beginTurn(): void;
  shapeBody(body: JsonObject): JsonObject;
  headers(headers: Headers): Headers;
  observeHeaders(headers: Headers): void;
  observeEvent(event: JsonObject): void;
  websocketBody(body: JsonObject): JsonObject;
}

type Continuation = { body: JsonObject; responseId: string; output: unknown[]; requestId?: string; expectedReplayOutput?: unknown[] };

function stable(value: unknown): string {
  // Native Codex compares typed JSON values, not insertion order of object keys.
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function incrementalBody(body: JsonObject, previous?: Continuation): JsonObject {
  if (!previous) return body;
  const properties = (value: JsonObject) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["input", "previous_response_id", "client_metadata", "stream_options", "access_programs", "generate"].includes(key)));
  if (stable(properties(body)) !== stable(properties(previous.body))) return body;
  const input = Array.isArray(body.input) ? body.input : [];
  const baseline = [...(Array.isArray(previous.body.input) ? previous.body.input : []), ...(previous.expectedReplayOutput ?? previous.output)];
  if (input.length < baseline.length || stable(input.slice(0, baseline.length)) !== stable(baseline)) return body;
  return { ...body, previous_response_id: previous.responseId, input: input.slice(baseline.length) };
}

function proxyFor(url: string, env: NodeJS.ProcessEnv): string | undefined {
  const target = new URL(url);
  const excluded = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (excluded.some(host => host === "*" || target.host === host || target.hostname === host ||
    (host.startsWith(".") && target.hostname.endsWith(host)))) return;
  return env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
}

/** A transport adapter; Pi still serializes tools/messages and decodes model events. */
export class WireTransport {
  private socket?: WebSocket;
  private continuation?: Continuation;
  private fallback = false;
  private busy = false;
  private prewarmed = false;
  private activeCancel?: () => void;
  private binding?: string;
  private readonly diagnostics: Diagnostics;
  private readonly hooks: WireHooks;
  private readonly mode: "auto" | "sse";
  private readonly fetcher: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    diagnostics: Diagnostics, hooks: WireHooks, mode: "auto" | "sse",
    fetcher: typeof fetch = globalThis.fetch, env: NodeJS.ProcessEnv = process.env,
  ) { this.diagnostics = diagnostics; this.hooks = hooks; this.mode = mode; this.fetcher = fetcher; this.env = env; }

  beginTurn(): void { this.prewarmed = false; }

  setReplayOutput(requestId: string, output: unknown[]): void {
    if (this.continuation?.requestId !== requestId) return;
    // Unknown/lost response items must not be silently bypassed by a delta.
    if (output.length !== this.continuation.output.length || this.continuation.output.some(item =>
      !["reasoning", "message", "function_call", "custom_tool_call"].includes(String(object(item).type)))) {
      this.continuation = undefined; return;
    }
    this.continuation.expectedReplayOutput = output;
  }

  close(): void {
    this.activeCancel?.();
    this.activeCancel = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    this.continuation = undefined;
  }

  private recordHeaders(headers: Headers, status: number, requestId: string): void {
    if (status !== 101) this.hooks.observeHeaders(headers);
    this.diagnostics.write({ kind: "headers", requestId, status, allowance: allowanceHeaders(headers),
      turnStatePresent: headers.has("x-codex-turn-state") });
  }

  private async connect(exchange: Exchange): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    this.close();
    const url = exchange.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const headers = new Headers(exchange.headers);
    for (const key of ["accept", "content-type", "content-encoding", "x-codex-turn-state", "x-openai-internal-codex-responses-lite"]) headers.delete(key);
    headers.set("OpenAI-Beta", "responses_websockets=2026-02-06");
    const proxy = proxyFor(url, this.env);
    const socket = new WebSocket(url, {
      headers: Object.fromEntries(headers),
      handshakeTimeout: Math.min(exchange.timeoutMs, 15_000),
      ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    });
    // A socket can fail between exchanges; always retain an error listener.
    socket.on("error", () => {});
    socket.on("upgrade", response => {
      const result = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      this.recordHeaders(result, response.statusCode ?? 101, exchange.requestId);
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", opened); socket.off("error", failed); socket.off("close", closed);
        exchange.signal?.removeEventListener("abort", aborted);
        this.activeCancel = undefined;
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); socket.terminate(); reject(new Error("Codex WebSocket connection failed")); };
      const closed = () => { cleanup(); reject(new Error("Codex WebSocket closed during connection")); };
      const aborted = () => { cleanup(); socket.terminate(); reject(new DOMException("Request aborted", "AbortError")); };
      this.activeCancel = aborted;
      socket.once("open", opened); socket.once("error", failed); socket.once("close", closed);
      exchange.signal?.addEventListener("abort", aborted, { once: true });
      if (exchange.signal?.aborted) aborted();
    });
    this.socket = socket;
    return socket;
  }

  private websocketResponse(socket: WebSocket, exchange: Exchange, prewarm: boolean): Response {
    const fullBody = prewarm ? { ...exchange.body, generate: false } : exchange.body;
    const body = this.hooks.websocketBody(incrementalBody(fullBody, this.continuation));
    if (exchange.headers.get("x-openai-internal-codex-responses-lite") === "true") {
      object(body.client_metadata).ws_request_header_x_openai_internal_codex_responses_lite = "true";
    }
    this.diagnostics.request(body, { requestId: exchange.requestId, transport: "websocket" });
    let finished = false;
    let retriedMissingResponse = false;
    let sawOutput = false;
    let cancel = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("message", message); socket.off("error", error); socket.off("close", closed);
          exchange.signal?.removeEventListener("abort", aborted);
          this.activeCancel = undefined;
          this.busy = false;
        };
        const fail = (reason: Error) => {
          if (finished) return;
          finished = true; cleanup(); this.continuation = undefined;
          socket.terminate(); controller.error(reason);
        };
        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => fail(new Error("Codex WebSocket stream timed out")), exchange.timeoutMs);
        };
        const message = (data: WebSocket.RawData) => {
          if (finished) return;
          resetTimer();
          let event: JsonObject;
          try { event = object(JSON.parse(data.toString())); }
          catch { fail(new Error("Invalid Codex WebSocket event")); return; }
          const code = event.code ?? object(event.error).code;
          if (event.type === "error" && code === "previous_response_not_found" && !sawOutput && !retriedMissingResponse && body.previous_response_id) {
            retriedMissingResponse = true; this.continuation = undefined;
            const retryBody = this.hooks.websocketBody(fullBody);
            if (exchange.headers.get("x-openai-internal-codex-responses-lite") === "true") {
              object(retryBody.client_metadata).ws_request_header_x_openai_internal_codex_responses_lite = "true";
            }
            this.diagnostics.request(retryBody, { requestId: exchange.requestId, transport: "websocket", retry: "missing-continuation" });
            socket.send(JSON.stringify({ type: "response.create", ...retryBody }), sendError => {
              if (sendError) fail(new Error("Codex WebSocket retry failed"));
            });
            return;
          }
          if (String(event.type).startsWith("response.output")) sawOutput = true;
          this.hooks.observeEvent(event);
          const diagnostic = eventDiagnostics(event);
          if (diagnostic) this.diagnostics.write({ ...diagnostic, requestId: exchange.requestId, prewarm });
          if (prewarm && (event.type === "error" || event.type === "response.failed")) {
            fail(new Error("Codex WebSocket prewarm failed")); return;
          }
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(exchange.normalizeEvent?.(event) ?? event)}\n\n`)); }
          catch { fail(new Error("Unsupported Codex response tool namespace")); return; }
          if (terminal.has(String(event.type)) || event.type === "error") {
            const response = object(event.response);
            if (["response.completed", "response.done"].includes(String(event.type)) && typeof response.id === "string" && Array.isArray(response.output)) {
              this.continuation = { body: exchange.body, responseId: response.id, output: response.output, requestId: exchange.requestId };
            } else this.continuation = undefined;
            finished = true; cleanup(); controller.close();
          }
        };
        const error = () => fail(new Error("Codex WebSocket stream failed"));
        const closed = () => fail(new Error("Codex WebSocket closed before completion"));
        const aborted = () => fail(new DOMException("Request aborted", "AbortError"));
        cancel = () => fail(new DOMException("Request cancelled", "AbortError"));
        this.activeCancel = cancel;
        socket.on("message", message); socket.once("error", error); socket.once("close", closed);
        exchange.signal?.addEventListener("abort", aborted, { once: true });
        resetTimer();
        if (exchange.signal?.aborted) { aborted(); return; }
        socket.send(JSON.stringify({ type: "response.create", ...body }), sendError => {
          if (sendError) fail(new Error("Codex WebSocket send failed"));
        });
      },
      cancel: () => cancel(),
    });
    // Only the local decoder sees this SSE envelope. The network request above is native WS JSON.
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  async request(exchange: Exchange): Promise<Response> {
    exchange.signal?.throwIfAborted();
    if (this.busy) throw new Error("Concurrent requests require separate Codex wire sessions");
    const binding = createHash("sha256").update(JSON.stringify([exchange.url,
      exchange.headers.get("authorization"), exchange.headers.get("chatgpt-account-id")])).digest("hex");
    if (this.binding !== undefined && this.binding !== binding) {
      this.close(); this.fallback = false; this.prewarmed = false; this.hooks.beginTurn();
      // Never replay routing state supplied for another credential or endpoint.
      exchange.headers.delete("x-codex-turn-state");
      exchange.headers = this.hooks.headers(exchange.headers);
      exchange.body = this.hooks.shapeBody(exchange.body);
    }
    this.binding = binding;
    this.busy = true;
    if (this.mode === "auto" && !this.fallback) {
      let socket: WebSocket;
      try {
        socket = await this.connect(exchange);
      } catch (error) {
        this.busy = false;
        if (exchange.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        this.fallback = true;
        this.diagnostics.write({ kind: "fallback", requestId: exchange.requestId, phase: "connect", to: "sse" });
        return this.sse(exchange);
      }
      if (!this.prewarmed) {
        this.prewarmed = true;
        const warmup = this.websocketResponse(socket, { ...exchange, requestId: randomUUID() }, true);
        try {
          // Drain prewarm events without forwarding them as an assistant response.
          const reader = warmup.body!.getReader();
          try { while (!(await reader.read()).done) {} } finally { reader.releaseLock(); }
        } catch (error) {
          this.busy = false;
          if (exchange.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          this.close(); this.fallback = true;
          this.diagnostics.write({ kind: "fallback", requestId: exchange.requestId, phase: "prewarm", to: "sse" });
          return this.sse(exchange);
        }
        this.busy = true;
      }
      return this.websocketResponse(socket, exchange, false);
    }
    return this.sse(exchange);
  }

  private async sse(exchange: Exchange): Promise<Response> {
    this.busy = true;
    const headers = new Headers(exchange.headers);
    headers.set("content-type", "application/json"); headers.set("accept", "text/event-stream");
    headers.delete("content-encoding");
    let body: string | Uint8Array;
    try {
      const json = JSON.stringify(exchange.body);
      body = json;
      if (exchange.compression === "zstd") {
        const compressionKey = zlib.constants.ZSTD_c_compressionLevel;
        if (!zlib.zstdCompressSync || compressionKey === undefined) throw new Error("This Node runtime cannot provide the selected zstd compression");
        body = new Uint8Array(zlib.zstdCompressSync(json, { params: { [compressionKey]: 3 } }));
        headers.set("content-encoding", "zstd");
      }
    } catch (error) { this.busy = false; throw error; }
    const controller = new AbortController();
    const signal = exchange.signal ? AbortSignal.any([exchange.signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error("Codex SSE stream timed out")), exchange.timeoutMs);
    };
    resetTimer();
    this.activeCancel = () => controller.abort();
    this.diagnostics.request(exchange.body, { requestId: exchange.requestId, transport: "sse", compressed: typeof body !== "string" });
    let response: Response;
    try {
      response = await (exchange.fetcher ?? this.fetcher)(exchange.url, { method: "POST", headers, body: body as BodyInit, signal });
      this.recordHeaders(response.headers, response.status, exchange.requestId);
    } catch (error) { clearTimeout(timer); this.activeCancel = undefined; this.busy = false; throw error; }
    if (!response.ok || !response.body) { clearTimeout(timer); this.activeCancel = undefined; this.busy = false; return response; }
    // Observe only complete JSON events; forward original bytes unchanged to Pi's parser.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const release = () => { clearTimeout(timer); this.busy = false; this.activeCancel = undefined; reader.releaseLock(); };
    this.activeCancel = () => { controller.abort(); void reader.cancel().catch(() => {}); };
    const observed = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const next = await reader.read();
          resetTimer();
          if (next.done) { release(); controller.close(); return; }
          pending += decoder.decode(next.value, { stream: true });
          if (exchange.normalizeEvent) {
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) {
              const block = pending.slice(0, boundary.index);
              pending = pending.slice(boundary.index + boundary[0].length);
              const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
              if (!data || data === "[DONE]") { controller.enqueue(encoder.encode(`${block}\n\n`)); continue; }
              const event = object(JSON.parse(data));
              this.hooks.observeEvent(event);
              const diagnostic = eventDiagnostics(event);
              if (diagnostic) this.diagnostics.write({ ...diagnostic, requestId: exchange.requestId });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(exchange.normalizeEvent(event))}\n\n`));
            }
            if (pending.length > 50 * 1024 * 1024) throw new Error("Codex event exceeds the transport frame limit");
            return;
          }
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).trimEnd(); pending = pending.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const event = object(JSON.parse(line.slice(5)));
              this.hooks.observeEvent(event);
              const diagnostic = eventDiagnostics(event);
              if (diagnostic) this.diagnostics.write({ ...diagnostic, requestId: exchange.requestId });
            } catch { /* Pi's parser remains responsible for protocol errors. */ }
          }
          // This observer need not retain arbitrarily large event lines.
          if (pending.length > 8 * 1024 * 1024) pending = "";
          controller.enqueue(next.value);
        } catch (error) { release(); controller.error(error); }
      },
      cancel: async reason => { try { await reader.cancel(reason); } finally { release(); } },
    });
    return new Response(observed, { status: response.status, headers: response.headers });
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { object, type Diagnostics, type JsonObject } from "./diagnostics.ts";

const codes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_SSL_UNEXPECTED_EOF_WHILE_READING", "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "WS_ERR_UNEXPECTED_RSV_1", "WS_ERR_INVALID_UTF8", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
]);

export function networkErrorCodes(error: unknown): string[] {
  const result = new Set<string>();
  for (let depth = 0; error && depth < 4; depth++) {
    const value = object(error);
    if (typeof value.code === "string" && codes.has(value.code)) result.add(value.code);
    error = value.cause;
  }
  return [...result];
}

export function responseRequestIds(headers: Headers): JsonObject {
  return Object.fromEntries(["x-request-id", "x-openai-request-id", "cf-ray"].flatMap(key => {
    const value = headers.get(key);
    return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? [[key, value]] : [];
  }));
}

function socketDetails(socket: Socket): JsonObject {
  const tls = socket as TLSSocket;
  const protocol = tls.getProtocol?.();
  return {
    socketBytesRead: socket.bytesRead, socketBytesWritten: socket.bytesWritten,
    tlsProtocol: ["TLSv1.2", "TLSv1.3"].includes(protocol ?? "") ? protocol : undefined,
    alpnProtocol: ["h2", "http/1.1"].includes(String(tls.alpnProtocol)) ? tls.alpnProtocol : undefined,
  };
}

/** One observer per upgraded socket; no addresses, TLS keys, or application data. */
export function observeWebSocketNetwork(socket: Socket): () => JsonObject {
  let tcpEnded = false, tcpClosed = false, tcpHadError = false;
  let socketErrorCodes: string[] = [];
  socket.once("end", () => { tcpEnded = true; });
  socket.once("close", hadError => { tcpClosed = true; tcpHadError = hadError; });
  socket.once("error", error => { socketErrorCodes = networkErrorCodes(error); });
  return () => ({ ...socketDetails(socket), tcpEnded, tcpClosed, tcpHadError, socketErrorCodes });
}

const scope = new AsyncLocalStorage<HttpNetworkTrace>();
const stages = {
  "undici:request:create": "request-created",
  "undici:client:sendHeaders": "headers-ready",
  "undici:request:bodySent": "body-sent",
  "undici:request:headers": "response-headers",
  "undici:request:error": "request-error",
} as const;

/** Match Undici request objects at creation, then follow their identity across
 * pooled callbacks. Unrelated sessions and non-Undici fetchers remain unobserved. */
export class HttpNetworkTrace {
  private readonly requests = new WeakSet<object>();
  private readonly seen = new Set<string>();
  private readonly startedAt = performance.now();
  private readonly diagnostics: Diagnostics;
  private readonly ids: JsonObject;
  private readonly url: string;

  constructor(diagnostics: Diagnostics, ids: JsonObject, url: string) {
    this.diagnostics = diagnostics; this.ids = ids; this.url = url;
  }

  private write(stage: string, fields: JsonObject = {}): void {
    if (this.seen.has(stage)) return;
    this.seen.add(stage);
    try {
      this.diagnostics.write({ kind: "http-network", ...this.ids, stage,
        elapsedMs: Math.round(performance.now() - this.startedAt), ...fields });
    } catch { /* Observation must not affect the request. */ }
  }

  async run(fetchResponse: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
    const listeners = Object.entries(stages).map(([name, stage]) => {
      const target = channel(name);
      const listener = (message: unknown) => {
        try {
          const data = object(message);
          if (typeof data.request !== "object" || data.request === null) return;
          if (stage === "request-created" && scope.getStore() === this) {
            const expected = new URL(this.url);
            const request = object(data.request);
            if (request.method === "POST" && String(request.origin) === expected.origin &&
              request.path === `${expected.pathname}${expected.search}`) this.requests.add(data.request);
          }
          if (!this.requests.has(data.request)) return;
          this.write(stage, {
            ...(stage === "headers-ready" && data.socket ? socketDetails(data.socket as Socket) : {}),
            ...(stage === "response-headers" ? { status: object(data.response).statusCode } : {}),
            ...(stage === "request-error" ? { errorCodes: networkErrorCodes(data.error) } : {}),
          });
        } catch { /* Never expose raw diagnostic-channel messages or interrupt Undici. */ }
      };
      target.subscribe(listener);
      return () => target.unsubscribe(listener);
    });
    const cleanup = () => { for (const remove of listeners) remove(); };
    const aborted = () => { this.write("aborted"); cleanup(); };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      const response = await scope.run(this, fetchResponse);
      this.write("fetch-returned", { status: response.status });
      return response;
    } catch (error) {
      this.write("fetch-error", { errorCodes: networkErrorCodes(error), signalAborted: signal.aborted });
      throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
      cleanup();
    }
  }
}

const eventTypes = new Set([
  "response.created", "response.in_progress", "response.metadata",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.completed", "response.done", "response.incomplete", "response.failed",
  "codex.rate_limits", "error",
]);

export function diagnosticEventType(event: JsonObject): string {
  return typeof event.type === "string" && eventTypes.has(event.type) ? event.type : "other";
}

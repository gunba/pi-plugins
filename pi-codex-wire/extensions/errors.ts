import { object, type JsonObject } from "./diagnostics.ts";

export const CAPACITY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000];
const MAX_CAPACITY_WAIT_MS = 600_000;
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Read Retry-After from stream-error headers: milliseconds capped at ten minutes, or undefined for invalid advice. */
export function capacityRetryAfter(headers: unknown, now = Date.now()): number | undefined {
  let value: string | undefined;
  for (const [name, raw] of Object.entries(object(headers))) {
    if (name.toLowerCase() !== "retry-after" || !["string", "number"].includes(typeof raw)) continue;
    const text = String(raw);
    if (!/[^\t\x20-\x7e]/.test(text)) value = text.trim();
  }
  if (!value) return;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_CAPACITY_WAIT_MS);
  // HTTP's asctime form has no zone suffix but still denotes UTC.
  const shortYear = /^\w+, (\d{2}-\w{3}-)(\d{2})( \d{2}:\d{2}:\d{2} GMT)$/.exec(value);
  let date: Date;
  if (shortYear) {
    // RFC 850 dates use the matching year no more than fifty years in the future.
    const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    const suffix = Number(shortYear[2]);
    const year = Math.floor((cutoff.getUTCFullYear() - suffix) / 100) * 100 + suffix;
    date = new Date(`${shortYear[1]}${year}${shortYear[3]}`);
    if (date.getTime() > cutoff.getTime()) date.setUTCFullYear(year - 100);
  } else date = new Date(value.endsWith(" GMT") ? value : `${value} GMT`);
  if (!Number.isFinite(date.getTime())) return;
  const canonical = date.toUTCString();
  if (canonical.length !== 29) return;
  const rfc850 = `${weekdays[date.getUTCDay()]}, ${canonical.slice(5, 7)}-${canonical.slice(8, 11)}-${canonical.slice(14, 16)} ${canonical.slice(17)}`;
  const asctime = `${canonical.slice(0, 3)} ${canonical.slice(8, 11)} ${String(date.getUTCDate()).padStart(2, " ")} ${canonical.slice(17, 25)} ${canonical.slice(12, 16)}`;
  // Round-tripping rejects calendar rollover and non-HTTP date formats.
  if (value === canonical || value === rfc850 || value === asctime)
    return Math.min(Math.max(0, date.getTime() - now), MAX_CAPACITY_WAIT_MS);
}

/** Internal control flow: the failed attempt is closed before its replacement can start. */
export class CapacityWait extends Error {
  readonly delayMs: number;
  readonly advised: boolean;
  constructor(delayMs: number, advised: boolean) { super("Capacity wait"); this.delayMs = delayMs; this.advised = advised; }
}

/** One inference request's recovery budget; never shared with another request or tool follow-up. */
export class CapacityRecovery {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private sawOutput = false;
  private retries = 0;
  private scheduledMs = 0;
  private waitedMs = 0;

  private readonly record: (row: JsonObject) => void;
  private readonly delays: readonly number[];

  constructor(signal: AbortSignal | undefined, record: (row: JsonObject) => void,
    delays: readonly number[] = CAPACITY_BACKOFF_MS) {
    this.record = record; this.delays = delays;
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  abort(): void { this.controller.abort(); }

  /** Observe before forwarding to Pi. Throws CapacityWait only for replay-safe failures;
   * exhausted or output-bearing capacity failures become terminal, non-retryable events.
   */
  event(event: JsonObject): JsonObject {
    const response = object(event.response);
    if (/^response\.(output|content_part|reasoning|function_call|custom_tool)/.test(String(event.type)) ||
      response.output != null && (!Array.isArray(response.output) || response.output.length > 0)) this.sawOutput = true;
    const error = object(response.error);
    if (event.type !== "response.failed" || error.code !== "policy_capacity_unavailable") return event;
    if (!this.sawOutput && this.retries < this.delays.length && this.scheduledMs < MAX_CAPACITY_WAIT_MS) {
      const advised = capacityRetryAfter(error.headers);
      const delay = advised ?? this.delays[this.retries];
      // Never resend earlier than the capped server advice to fit the remaining budget.
      if (delay <= MAX_CAPACITY_WAIT_MS - this.scheduledMs) throw new CapacityWait(delay, advised !== undefined);
    }
    const reason = this.sawOutput ? "Output was already received; this attempt was not resent." : "Capacity recovery budget exhausted.";
    // Pi classifies retryability by text. Do not include raw overload wording or
    // bare second counts that its HTTP-status matcher could mistake for 429/503.
    const message = `Policy-restricted capacity is unavailable; waited ${Math.ceil(this.waitedMs / 1000)}s. ${reason}`;
    this.record({ kind: "capacity-stop", reason: this.sawOutput ? "output-received" : "budget-exhausted",
      retries: this.retries, waitedMs: this.waitedMs });
    return { ...event, response: { ...response, error: { ...error, message } } };
  }

  private async wait(wait: CapacityWait): Promise<void> {
    this.signal.throwIfAborted();
    this.retries++;
    this.scheduledMs += wait.delayMs;
    const started = performance.now();
    this.record({ kind: "capacity-wait", attempt: this.retries, delayMs: wait.delayMs,
      advised: wait.advised, waitedMs: this.waitedMs });
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { this.signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, wait.delayMs);
        const abort = () => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); reject(this.signal.reason); };
        this.signal.addEventListener("abort", abort, { once: true });
        if (this.signal.aborted) abort();
      });
    } finally {
      this.waitedMs += performance.now() - started;
      this.record({ kind: "capacity-wait-end", attempt: this.retries, waitedMs: this.waitedMs, aborted: this.signal.aborted });
    }
    this.signal.throwIfAborted();
  }

  /** Own the local SSE body and hide replay-safe capacity failures from Pi's decoder.
   * Resends must use this signal and the identical request; onFinish releases caller ownership.
   */
  wrap(response: Response, resend: () => Promise<Response>, onFinish: () => void): Response {
    if (!response.ok || !response.body) { onFinish(); return response; }
    let reader = response.body.getReader();
    let released = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (released) return;
      released = true;
      this.signal.removeEventListener("abort", abort);
      reader.releaseLock();
      onFinish();
    };
    const abort = () => {
      if (released) return;
      output.error(this.signal.reason);
      // The attempt receives this signal too. Let it record the abort source and
      // close itself instead of turning a caller abort into a stream cancellation.
      finish();
    };
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        output = controller;
        this.signal.addEventListener("abort", abort, { once: true });
        if (this.signal.aborted) abort();
      },
      pull: async controller => {
        try {
          while (!released) {
            try {
              const next = await reader.read();
              if (released) return;
              if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
              return;
            } catch (error) {
              if (!(error instanceof CapacityWait) || released) throw error;
              await this.wait(error);
              const retried = await resend();
              if (!retried.ok || !retried.body) {
                await retried.body?.cancel();
                throw new Error(`Codex capacity recovery received HTTP ${retried.status}`);
              }
              reader.releaseLock();
              reader = retried.body.getReader();
              if (released) { await reader.cancel(); reader.releaseLock(); return; }
            }
          }
        } catch (error) {
          if (!released) { controller.error(error); finish(); }
        }
      },
      cancel: async () => {
        const cancelled = reader.cancel();
        finish(); this.abort();
        await cancelled.catch(() => {});
      },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  }
}

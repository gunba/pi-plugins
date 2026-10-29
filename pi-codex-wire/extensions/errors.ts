import { object, type JsonObject } from "./diagnostics.ts";

const POLICY_CAPACITY_MESSAGE = "Policy-restricted capacity is unavailable. Please try again later.";
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hasRetryAdvice(headers: unknown): boolean {
  let value: string | undefined;
  for (const [name, raw] of Object.entries(object(headers))) {
    if (name.toLowerCase() !== "retry-after" || !["string", "number", "boolean"].includes(typeof raw)) continue;
    const text = String(raw);
    if (!/[^\t\x20-\x7e]/.test(text)) value = text.trim();
  }
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value));
  // HTTP's asctime form has no zone suffix but still denotes UTC.
  const date = new Date(value.endsWith(" GMT") ? value : `${value} GMT`);
  if (!Number.isFinite(date.getTime())) return false;
  const canonical = date.toUTCString();
  if (canonical.length !== 29) return false;
  const rfc850 = `${weekdays[date.getUTCDay()]}, ${canonical.slice(5, 7)}-${canonical.slice(8, 11)}-${canonical.slice(14, 16)} ${canonical.slice(17)}`;
  const asctime = `${canonical.slice(0, 3)} ${canonical.slice(8, 11)} ${String(date.getUTCDate()).padStart(2, " ")} ${canonical.slice(17, 25)} ${canonical.slice(12, 16)}`;
  // Round-tripping also rejects Date.parse's calendar rollover and non-HTTP date formats.
  return value === canonical || value === rfc850 || value === asctime;
}

/** Codex 0.166.0 retries policy-capacity stream failures only with valid Retry-After advice.
 * Pi classifies assistant errors by their text: raw overload wording must not enable an unadvised
 * retry or suggest changing models. Advised failures keep Pi's existing handling; this adapter
 * does not add a retry loop or reinterpret the caller's backoff. Other events are returned unchanged.
 */
export function normalizePolicyCapacityEvent(event: JsonObject): JsonObject {
  if (event.type !== "response.failed") return event;
  const response = object(event.response), error = object(response.error);
  if (error.code !== "policy_capacity_unavailable" || hasRetryAdvice(error.headers)) return event;
  return { ...event, response: { ...response, error: { ...error, message: POLICY_CAPACITY_MESSAGE } } };
}

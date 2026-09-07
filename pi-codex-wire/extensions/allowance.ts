import { allowanceHeaders, object, type JsonObject } from "./diagnostics.ts";

export const ALLOWANCE_EVENT = "pi-codex-wire:allowance";

/** Only subscription counters and plan labels cross the extension event bus. */
export function allowanceFromHeaders(headers: Headers): JsonObject {
  const result = allowanceHeaders(headers);
  for (const key of ["x-codex-plan-type", "x-codex-active-limit"]) {
    const value = headers.get(key);
    if (value && /^[a-z][a-z0-9_-]{0,63}$/i.test(value)) result[key] = value;
  }
  return result;
}

export function allowanceFromEvent(event: JsonObject): JsonObject {
  const headers = new Headers();
  const numeric = (key: string, value: unknown) => {
    if ((typeof value === "number" || typeof value === "string") && String(value).trim() && Number.isFinite(Number(value)))
      headers.set(key, String(Number(value)));
  };
  const label = (key: string, value: unknown) => {
    if (typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(value)) headers.set(key, value);
  };
  if (event.type === "codex.rate_limits") {
    const limits = object(event.rate_limits);
    for (const window of ["primary", "secondary"]) {
      const values = object(limits[window]);
      for (const field of ["used_percent", "window_minutes", "reset_at", "reset_after_seconds"]) {
        numeric(`x-codex-${window}-${field.replaceAll("_", "-")}`, values[field]);
      }
    }
    label("x-codex-plan-type", event.plan_type);
    const limit = event.active_limit ?? event.activeLimit ?? event.metered_limit_name ?? event.limit_name;
    label("x-codex-active-limit", limit);
  } else if (["error", "response.metadata", "codex.response.metadata"].includes(String(event.type))) {
    for (const [key, value] of Object.entries(object(event.headers))) {
      if (/^x-codex-(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/.test(key.toLowerCase()))
        numeric(key, value);
    }
  }
  return allowanceFromHeaders(headers);
}

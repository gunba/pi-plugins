import type { JsonObject } from "./diagnostics.ts";

/**
 * Field order of Codex 0.164.0's ResponsesApiRequest and ResponseCreateWsRequest (codex-api/src/common.rs). Serde writes
 * fields in declaration order, and routing fields come first because gateways may read a body incrementally, before
 * its input.
 */
const ORDER = ["type", "model", "stream", "service_tier", "previous_response_id", "input", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "store", "stream_options", "include", "prompt_cache_key", "text", "generate",
  "client_metadata", "access_programs"];

/** The body with its fields in native order; any field the native request lacks keeps its place after them. */
export function nativeOrder(body: JsonObject): JsonObject {
  const ordered: JsonObject = {};
  for (const key of ORDER) if (Object.hasOwn(body, key)) ordered[key] = body[key];
  for (const [key, value] of Object.entries(body)) if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  return ordered;
}

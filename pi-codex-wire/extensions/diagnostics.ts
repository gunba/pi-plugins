import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Profile = "pi" | "codex";
export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}

function numericFields(value: unknown, keys: string[]): JsonObject {
  const source = object(value);
  return Object.fromEntries(keys.filter(key => typeof source[key] === "number" && Number.isFinite(source[key]))
    .map(key => [key, source[key]]));
}

export function allowanceHeaders(headers: Headers): JsonObject {
  const result: JsonObject = {};
  for (const window of ["primary", "secondary"]) {
    for (const field of ["used-percent", "window-minutes", "reset-after-seconds", "reset-at"]) {
      const key = `x-codex-${window}-${field}`;
      const raw = headers.get(key);
      if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) result[key] = Number(raw);
    }
  }
  return result;
}

export function eventDiagnostics(value: unknown): JsonObject | undefined {
  const event = object(value);
  if (event.type === "codex.rate_limits") {
    const limits = object(event.rate_limits);
    return {
      kind: "allowance",
      primary: numericFields(limits.primary, ["used_percent", "window_minutes", "reset_at"]),
      secondary: numericFields(limits.secondary, ["used_percent", "window_minutes", "reset_at"]),
    };
  }
  if (!["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(event.type))) return;
  const response = object(event.response);
  const usage = object(response.usage);
  const tier = ["auto", "default", "flex", "priority", "scale"].includes(String(response.service_tier))
    ? response.service_tier : undefined;
  return {
    kind: "response",
    event: event.type,
    serviceTier: tier,
    usage: {
      ...numericFields(usage, ["input_tokens", "output_tokens", "total_tokens"]),
      ...numericFields(usage.input_tokens_details, ["cached_tokens"]),
      ...numericFields(usage.output_tokens_details, ["reasoning_tokens"]),
    },
  };
}

/** Construct records from an allowlist. Never pass raw headers, errors or bodies here. */
export class Diagnostics {
  private readonly key = randomBytes(32);
  private failed = false;
  readonly path: string;
  private readonly warn: () => void;
  constructor(path: string, warn: () => void = () => {}) { this.path = path; this.warn = warn; }

  write(record: JsonObject): void {
    if (this.failed) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    } catch {
      this.failed = true;
      this.warn();
    }
  }

  request(body: JsonObject, details: JsonObject): void {
    const encode = (value: unknown) => JSON.stringify(value ?? null);
    const digest = (value: unknown) => createHmac("sha256", this.key).update(encode(value)).digest("hex");
    const reasoning = object(body.reasoning);
    this.write({
      kind: "request", ...details,
      model: typeof body.model === "string" && /^[a-zA-Z0-9._-]+$/.test(body.model) ? body.model : undefined,
      effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(reasoning.effort)) ? reasoning.effort : undefined,
      serviceTier: ["auto", "default", "flex", "priority", "scale"].includes(String(body.service_tier)) ? body.service_tier : "omitted",
      inputItems: Array.isArray(body.input) ? body.input.length : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      bytes: Buffer.byteLength(encode(body)),
      instructionBytes: Buffer.byteLength(encode(body.instructions)),
      toolBytes: Buffer.byteLength(encode(body.tools)),
      inputDigest: digest(body.input), instructionsDigest: digest(body.instructions), toolsDigest: digest(body.tools),
      continuation: typeof body.previous_response_id === "string",
      prewarm: body.generate === false,
    });
  }
}

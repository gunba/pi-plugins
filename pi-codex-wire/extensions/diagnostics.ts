import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Profile = "pi" | "codex";
export type JsonObject = Record<string, unknown>;
export const DIAGNOSTIC_PART_BYTES = 2 * 1024 * 1024;
export const DIAGNOSTIC_PARTS = 4;

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
  const tier = ["auto", "default", "flex", "priority", "fast", "scale"].includes(String(response.service_tier))
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
  private closed = false;
  private initialized = false;
  private bytes = 0;
  private header = "";
  readonly path: string;
  private readonly warn: () => void;
  constructor(path: string, warn: () => void = () => {}) { this.path = path; this.warn = warn; }

  write(record: JsonObject): void {
    if (this.failed || this.closed) return;
    try {
      if (!this.initialized) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        writeFileSync(`${this.path}.owner`, JSON.stringify({ pid: process.pid, closed: false }), { flag: "wx", mode: 0o600 });
        try { writeFileSync(this.path, "", { flag: "wx", mode: 0o600 }); }
        catch (error) { rmSync(`${this.path}.owner`, { force: true }); throw error; }
        this.initialized = true;
      }
      let line = `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`;
      if (Buffer.byteLength(line) > DIAGNOSTIC_PART_BYTES / 2)
        line = `${JSON.stringify({ time: new Date().toISOString(), kind: "record-omitted", bytes: Buffer.byteLength(line) })}\n`;
      if (record.kind === "run" && !this.header) this.header = line;
      const length = Buffer.byteLength(line);
      if (this.bytes + length > DIAGNOSTIC_PART_BYTES) {
        rmSync(`${this.path}.${DIAGNOSTIC_PARTS - 1}`, { force: true });
        for (let part = DIAGNOSTIC_PARTS - 2; part >= 1; part--) {
          if (existsSync(`${this.path}.${part}`)) renameSync(`${this.path}.${part}`, `${this.path}.${part + 1}`);
        }
        renameSync(this.path, `${this.path}.1`);
        writeFileSync(this.path, this.header, { flag: "wx", mode: 0o600 });
        this.bytes = Buffer.byteLength(this.header);
      }
      appendFileSync(this.path, line);
      this.bytes += length;
    } catch {
      this.failed = true;
      this.warn();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.initialized) {
      try { writeFileSync(`${this.path}.owner`, JSON.stringify({ pid: process.pid, closed: true }), { mode: 0o600 }); }
      catch { /* An unsealed live owner is retained conservatively. */ }
    }
  }

  request(body: JsonObject, details: JsonObject): void {
    const encode = (value: unknown) => JSON.stringify(value ?? null);
    const digest = (value: unknown) => createHmac("sha256", this.key).update(encode(value)).digest("hex");
    const reasoning = object(body.reasoning);
    this.write({
      kind: "request", ...details,
      model: typeof body.model === "string" && /^[a-zA-Z0-9._-]+$/.test(body.model) ? body.model : undefined,
      effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "disabled"].includes(String(reasoning.effort)) ? reasoning.effort : undefined,
      serviceTier: ["auto", "default", "flex", "priority", "fast", "scale"].includes(String(body.service_tier)) ? body.service_tier : "omitted",
      inputItems: Array.isArray(body.input) ? body.input.length : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      streamRequested: body.stream === true,
      bytes: Buffer.byteLength(encode(body)),
      instructionBytes: Buffer.byteLength(encode(body.instructions)),
      toolBytes: Buffer.byteLength(encode(body.tools)),
      inputDigest: digest(body.input), instructionsDigest: digest(body.instructions), toolsDigest: digest(body.tools),
      continuation: typeof body.previous_response_id === "string",
      prewarm: body.generate === false,
    });
  }
}

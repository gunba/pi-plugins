import { object, type JsonObject } from "./diagnostics.ts";
import { createHash } from "node:crypto";
import type { Identity } from "./identity.ts";

const fields = ["slug", "use_responses_lite", "supports_reasoning_summaries", "supports_reasoning_summary_parameter",
  "default_reasoning_summary", "default_reasoning_level", "supported_reasoning_levels", "support_verbosity", "default_verbosity",
  "supports_parallel_tool_calls", "supports_image_detail_original", "service_tiers", "default_service_tier"];

/** Freeze native model capabilities for a comparison, not the model's instructions. */
export class Catalog {
  private readonly snapshots = new Map<string, JsonObject[]>();
  private readonly identity: Identity;
  constructor(identity: Identity) { this.identity = Object.freeze({ ...identity }); }

  async model(id: string, responsesUrl: string, original: Headers, signal?: AbortSignal,
    fetcher: typeof fetch = globalThis.fetch): Promise<JsonObject> {
    signal?.throwIfAborted();
    const url = new URL(responsesUrl);
    url.pathname = url.pathname.replace(/\/responses$/, "/models");
    url.search = `?client_version=${this.identity.version}`;
    const key = createHash("sha256").update(JSON.stringify([url.href,
      original.get("chatgpt-account-id"), original.get("authorization")])).digest("hex");
    let entries = this.snapshots.get(key);
    if (!entries) {
      const headers = new Headers();
      for (const name of ["authorization", "chatgpt-account-id"]) {
        const value = original.get(name); if (value) headers.set(name, value);
      }
      headers.set("originator", this.identity.originator); headers.set("user-agent", this.identity.userAgent);
      headers.set("version", this.identity.version);
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetcher(url, { headers, signal: requestSignal });
      if (!response.ok) throw new Error(`Codex model catalog unavailable (HTTP ${response.status}); no inference was sent`);
      const payload = object(await response.json());
      requestSignal.throwIfAborted();
      if (!Array.isArray(payload.models)) throw new Error("Invalid Codex model catalog; no inference was sent");
      const fetched = payload.models.map(value => {
        const model = object(value);
        return Object.fromEntries(fields.filter(key => key in model).map(key => [key, model[key]]));
      });
      // Concurrent requests have independent cancellation. First successful completion
      // freezes this credential/endpoint scope; another scope can never overwrite it.
      entries = this.snapshots.get(key) ?? fetched;
      this.snapshots.set(key, entries);
      if (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    const metadata = entries.find(model => model.slug === id);
    if (!metadata) throw new Error("Selected model is absent from the native Codex catalog; no inference was sent");
    return structuredClone(metadata);
  }
}

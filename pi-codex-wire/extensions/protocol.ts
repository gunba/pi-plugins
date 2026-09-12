import { randomUUID } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-ai";
import { object, type JsonObject, type Profile } from "./diagnostics.ts";
import type { Identity } from "./identity.ts";

/** State is scoped to one Pi session. A Codex turn spans all its tool round trips. */
export class Protocol {
  private turnState?: string;
  private compactionReason?: "manual" | "threshold" | "overflow";
  private turnId = randomUUID();
  private turnStarted = Date.now();
  readonly sessionId: string;
  private windowId: string;
  readonly profile: Profile;
  readonly threadId: string;
  readonly installationId: string;
  readonly identity: Identity;
  constructor(
    profile: Profile, threadId: string, installationId: string, identity: Identity, windowId = uuidv7(),
  ) { this.profile = profile; this.threadId = threadId; this.sessionId = threadId; this.installationId = installationId; this.identity = identity; this.windowId = windowId; }

  getWindowId(): string { return this.windowId; }
  rotateWindow(): void { this.windowId = uuidv7(); this.beginTurn(); }

  beginTurn(reason?: "manual" | "threshold" | "overflow"): void { this.turnState = undefined; this.turnId = randomUUID(); this.turnStarted = Date.now(); this.compactionReason = reason; }

  observeHeaders(headers: Headers): void {
    this.turnState ??= headers.get("x-codex-turn-state") ?? undefined;
  }

  private metadata(kind: "turn" | "prewarm" | "compaction"): JsonObject {
    return {
      installation_id: this.installationId, session_id: this.sessionId, thread_id: this.threadId,
      turn_id: this.turnId, window_id: this.windowId, request_kind: kind,
      thread_source: "user", sandbox: "none", turn_started_at_unix_ms: this.turnStarted,
      ...(kind === "compaction" && this.compactionReason === "manual" ? { compaction: {
        trigger: "manual", reason: "user_requested", implementation: "responses_compaction_v2",
        phase: "standalone_turn", strategy: "memento",
      } } : {}),
    };
  }

  shapeBody(value: unknown): JsonObject {
    const body = object(value);
    return { ...body, prompt_cache_key: this.sessionId, client_metadata: {
      ...object(body.client_metadata),
      "x-codex-installation-id": this.installationId,
      session_id: this.sessionId, thread_id: this.threadId, turn_id: this.turnId,
      "x-codex-window-id": this.windowId,
      "x-codex-turn-metadata": JSON.stringify(this.metadata(Array.isArray(body.input) && body.input.some(item => object(item).type === "compaction_trigger") ? "compaction" : "turn")),
    } };
  }

  headers(original: Headers): Headers {
    const headers = new Headers(original);
    if (this.profile === "codex") {
      headers.set("originator", this.identity.originator);
      headers.set("user-agent", this.identity.userAgent);
    }
    headers.delete("OpenAI-Beta");
    headers.set("session-id", this.sessionId);
    headers.set("thread-id", this.threadId);
    headers.set("x-client-request-id", this.threadId);
    headers.set("version", this.identity.version);
    headers.delete("x-codex-installation-id");
    headers.set("x-codex-window-id", this.windowId);
    headers.set("x-codex-turn-metadata", JSON.stringify(this.metadata("turn")));
    if (this.turnState) headers.set("x-codex-turn-state", this.turnState);
    else headers.delete("x-codex-turn-state");
    return headers;
  }

  compactHeaders(original: Headers, reason: "manual" | "threshold" | "overflow"): Headers {
    const headers = this.headers(original);
    headers.set("x-codex-turn-metadata", JSON.stringify({ ...this.metadata("compaction"),
      ...(reason === "manual" ? { compaction: {
        trigger: "manual", reason: "user_requested",
        implementation: "responses_compaction_v2", phase: "standalone_turn", strategy: "memento",
      } } : {}),
    }));
    return headers;
  }

  websocketBody(body: JsonObject): JsonObject {
    return { ...body, client_metadata: {
      ...object(body.client_metadata),
      "x-codex-turn-metadata": JSON.stringify(this.metadata(body.generate === false ? "prewarm" : Array.isArray(body.input) && body.input.some(item => object(item).type === "compaction_trigger") ? "compaction" : "turn")),
      "x-codex-ws-stream-request-start-ms": String(Date.now()),
      ...(this.turnState ? { "x-codex-turn-state": this.turnState } : {}),
    } };
  }

  observeEvent(event: JsonObject): void {
    if (event.type !== "response.metadata") return;
    for (const [key, value] of Object.entries(object(event.headers))) {
      if (key.toLowerCase() === "x-codex-turn-state" && typeof value === "string") this.turnState ??= value;
    }
  }
}

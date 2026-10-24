import { randomUUID } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-ai";
import { object, type JsonObject, type Profile } from "./diagnostics.ts";
import type { Identity } from "./identity.ts";
import type { Turn } from "./history.ts";

/** A git workspace as native turn metadata describes it (codex-rs core/src/turn_metadata.rs). */
export interface Workspace { associated_remote_urls?: Record<string, string>; latest_git_commit_hash?: string; has_changes?: boolean }

/** Experimental features the session advertises; native Codex always advertises remote compaction v2. */
const BETA_FEATURES = "remote_compaction_v2";

/** State is scoped to one Pi session. A Codex turn spans all its tool round trips. */
export class Protocol {
  private turnState?: string;
  private compactionReason?: "manual" | "threshold" | "overflow";
  private turnId: string = randomUUID();
  private turnStarted = Date.now();
  private request: { model?: string; effort?: string; workspaces?: Record<string, Workspace> } = {};
  readonly sessionId: string;
  /** The context window's own ID (native context_window_id); window_id is `<thread>:<number>`. */
  private contextWindowId: string;
  private windowNumber: number;
  readonly profile: Profile;
  readonly threadId: string;
  readonly installationId: string;
  readonly identity: Identity;
  /** How the thread's history began, in the turn metadata: "new", or "cold_resume" for a saved conversation reopened. */
  readonly historyInitialization: "new" | "cold_resume";
  constructor(
    profile: Profile, threadId: string, installationId: string, identity: Identity, windowId = uuidv7(),
    historyInitialization: "new" | "cold_resume" = "new", windowNumber = 0,
  ) {
    this.profile = profile; this.threadId = threadId; this.sessionId = threadId; this.installationId = installationId;
    this.identity = identity; this.contextWindowId = windowId; this.historyInitialization = historyInitialization;
    this.windowNumber = windowNumber;
  }

  getWindowId(): string { return this.contextWindowId; }
  getWindowNumber(): number { return this.windowNumber; }
  private get windowId(): string { return `${this.threadId}:${this.windowNumber}`; }
  rotateWindow(): void { this.contextWindowId = uuidv7(); this.windowNumber++; this.beginTurn(); }

  beginTurn(reason?: "manual" | "threshold" | "overflow"): void { this.turnState = undefined; this.turnId = randomUUID(); this.turnStarted = Date.now(); this.compactionReason = reason; }
  /** The turn the next request belongs to, as its items record it (history.ts). */
  setTurn(turn: Turn | undefined): void { if (turn) { this.turnId = turn.id; this.turnStarted = turn.started; } }
  /** The model, effort and git workspaces the next request's metadata reports. */
  setRequest(request: { model?: string; effort?: string; workspaces?: Record<string, Workspace> }): void { this.request = request; }

  observeHeaders(headers: Headers): void {
    const state = headers.get("x-codex-turn-state");
    if (state === null) return;
    this.turnState ??= state;
  }

  /** Native turn metadata, in its serialized field order (codex-rs core/src/responses_metadata.rs). */
  private metadata(kind: "turn" | "prewarm" | "compaction"): JsonObject {
    const inTurn = kind !== "prewarm";
    const workspaces = kind === "turn" && this.request.workspaces && Object.keys(this.request.workspaces).length ? this.request.workspaces : undefined;
    return {
      installation_id: this.installationId, session_id: this.sessionId, thread_id: this.threadId, agent_name: "/root",
      turn_id: inTurn ? this.turnId : "", window_id: this.windowId, window_number: this.windowNumber,
      context_window_id: this.contextWindowId, request_kind: kind, history_initialization: this.historyInitialization,
      ...(inTurn ? { root_turn_id: this.turnId } : {}),
      thread_source: "user", sandbox: "none", sandbox_mode: "danger-full-access", auto_review_enabled: false,
      node_repl_auto_review_required: true, node_repl_disabled: false,
      ...(workspaces ? { workspaces } : {}),
      ...(inTurn ? { turn_started_at_unix_ms: this.turnStarted } : {}),
      analytics_enabled: true,
      ...(kind === "compaction" && this.compactionReason === "manual" ? { compaction: {
        trigger: "manual", reason: "user_requested", implementation: "responses_compaction_v2",
        phase: "standalone_turn", strategy: "memento",
      } } : {}),
      ...(this.request.model ? { model: this.request.model } : {}),
      ...(this.request.effort ? { reasoning_effort: this.request.effort } : {}),
    };
  }

  private clientMetadata(kind: "turn" | "prewarm" | "compaction"): JsonObject {
    const inTurn = kind !== "prewarm";
    return {
      "x-codex-installation-id": this.installationId,
      session_id: this.sessionId, thread_id: this.threadId, turn_id: inTurn ? this.turnId : "",
      ...(inTurn ? { root_turn_id: this.turnId } : {}),
      "x-codex-window-id": this.windowId,
      mcp_attribution: JSON.stringify({ status: "none" }),
      "x-codex-turn-metadata": JSON.stringify(this.metadata(kind)),
    };
  }

  shapeBody(value: unknown): JsonObject {
    const body = object(value);
    const kind = Array.isArray(body.input) && body.input.some(item => object(item).type === "compaction_trigger") ? "compaction" : "turn";
    return { ...body, prompt_cache_key: this.sessionId, client_metadata: { ...object(body.client_metadata), ...this.clientMetadata(kind) } };
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
    headers.set("x-codex-beta-features", BETA_FEATURES);
    headers.delete("x-codex-installation-id");
    headers.set("x-codex-window-id", this.windowId);
    headers.set("x-codex-turn-metadata", JSON.stringify(this.metadata("turn")));
    if (this.turnState) headers.set("x-codex-turn-state", this.turnState);
    else headers.delete("x-codex-turn-state");
    return headers;
  }

  compactHeaders(original: Headers, reason: "manual" | "threshold" | "overflow"): Headers {
    const headers = this.headers(original);
    this.compactionReason = reason;
    headers.set("x-codex-turn-metadata", JSON.stringify(this.metadata("compaction")));
    return headers;
  }

  websocketBody(body: JsonObject): JsonObject {
    const kind = body.generate === false ? "prewarm" : Array.isArray(body.input) && body.input.some(item => object(item).type === "compaction_trigger") ? "compaction" : "turn";
    const metadata = { ...object(body.client_metadata), ...this.clientMetadata(kind) };
    if (kind === "prewarm") delete metadata.root_turn_id;
    return { ...body, client_metadata: {
      ...metadata,
      "x-codex-ws-stream-request-start-ms": String(Date.now()),
      ...(this.turnState ? { "x-codex-turn-state": this.turnState } : {}),
    } };
  }

  observeEvent(event: JsonObject): void {
    if (event.type !== "response.metadata") return;
    for (const [key, value] of Object.entries(object(event.headers))) {
      if (key.toLowerCase() === "x-codex-turn-state" && typeof value === "string") {
        this.turnState ??= value;
      }
    }
  }
}

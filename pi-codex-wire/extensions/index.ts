import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StreamOptions, SimpleStreamOptions, Model, Api, Context, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { responseReplay } from "./serializer.ts";
import { Diagnostics, object, type JsonObject, type Profile } from "./diagnostics.ts";
import { retainDiagnostics } from "./diagnostic-retention.ts";
import { Protocol } from "./protocol.ts";
import { CODEX_VERSION, codexIdentity, type Client } from "./identity.ts";
import { requestCompression, requestRoutingHint } from "./compression.ts";
import { WireTransport } from "./transport.ts";
import { ALLOWANCE_EVENT } from "./allowance.ts";
import codexUsage from "./usage.ts";
import { Catalog } from "./catalog.ts";
import { shapeModelBody, normalizeLiteEvent } from "./model-shape.ts";
import { readUserAgent, saveUserAgent, readClient, savedClient, saveClient, readPrewarm, savedPrewarm, savePrewarm,
  readFast, savedFast, saveFast, type FastMode } from "./settings.ts";
import { registerRequiredWire, requireCodexWire } from "./required.ts";
import requestTracing, { requestTrace } from "./request-trace.ts";
import nativeCompaction, { guardCheckpointContext, registerCompactor } from "./native-compaction.ts";
import { replayCheckpoints, createCheckpoint } from "./checkpoint.ts";
import { CHECKPOINT, SESSION_WINDOW_ENTRY } from "./checkpoint-state.ts";
import { compactBody, requestCompact } from "./compact.ts";
import { codexRequestAuth, compactInput } from "./compact-input.ts";
import { getPresentation, type UiDetails } from "../../pi-ui/index.ts";

type Options = StreamOptions | SimpleStreamOptions;
// Providers belong to the host runtime, which may differ from our serializer SDK.
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type WireSession = { protocol: Protocol; transport: WireTransport; turnKey?: string; beganTurn?: boolean; compactContext?: Context };

function installationId(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "installation-id");
  try { return readFileSync(file, "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const id = randomUUID();
  try { writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 }); return id; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(file, "utf8").trim();
    throw error;
  }
}

export default function codexWire(pi: ExtensionAPI): void {
  codexUsage(pi);
  requestTracing(pi);
  pi.registerFlag("codex-wire-client", { type: "string", description: "Codex client identity: cli or desktop (overrides saved client)" });
  pi.registerFlag("codex-wire-desktop-version", { type: "string", description: "Desktop application version for the app-server User-Agent suffix" });
  pi.registerFlag("codex-wire-transport", { type: "string", default: "auto", description: "Wire transport: auto (WebSocket with SSE fallback) or sse" });
  pi.registerFlag("codex-wire-compression", { type: "string", default: "on", description: "Native request-compression feature: on (Codex default) or off" });
  pi.registerFlag("codex-wire-prewarm", { type: "string", description: "Full-prompt WebSocket prewarming: on or off (default off; Wire remains mandatory)" });
  pi.registerFlag("codex-wire-user-agent", { type: "string", description: "Explicit User-Agent profile (optional on Windows and Linux)" });
  pi.registerFlag("codex-wire-originator", { type: "string", description: "Native originator override (default codex_cli_rs)" });
  let mode: "off" | "codex" = "off";
  let client: Client = "cli";
  let original: Provider | undefined;
  let transport: WireTransport | undefined;
  let protocol: Protocol | undefined;
  let diagnostics: Diagnostics | undefined;
  let beganTurn = false;
  let catalog: Catalog | undefined;
  let lastRequest = "not tested";
  const directory = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "codex-wire");
  const pending = new Map<AbortController, string>();
  let sessions = new Map<string, WireSession>();
  let lifetime: AbortController | undefined;
  let releaseRequiredWire: (() => void) | undefined;
  let prewarm = false;
  let fastMode: FastMode = "off";
  let lastFastCheck = "not checked";

  function showWireStatus(ctx: ExtensionContext): void {
    const remote = ctx.mode === "rpc" ? getPresentation(pi) : undefined;
    if (ctx.model?.api !== "openai-codex-responses") {
      ctx.ui.setStatus("codex-wire", undefined); remote?.publish("codex-wire", undefined); return;
    }
    ctx.ui.setStatus("codex-wire", `wire:${client}${fastMode !== "off" ? ` · fast:${fastMode}` : ""}`);
    if (!remote) return;
    const data: UiDetails = { summary: "Fast and Ultrafast request faster processing on eligible ChatGPT Codex models at higher credit use. Availability depends on the model and account; the backend can downgrade a request. Prewarming adds a full-prompt request; it is normally left off.",
      fields: [{ label: "Last eligibility check", value: lastFastCheck }, { label: "Wire", value: mode }],
      controls: remote.runCommand ? [
        { kind: "select", label: "Speed", value: fastMode, options: [{ value: "off", label: "Standard" }, { value: "on", label: "Fast" }, { value: "ultrafast", label: "Ultrafast" }],
          action: { id: "fast", label: "Change speed", interrupt: "resume" }, help: "Fast and Ultrafast use more credits. The selected model must advertise the requested tier." },
        { kind: "select", label: "Client identity", value: client, options: [{ value: "cli", label: "CLI" }, { value: "desktop", label: "Desktop" }],
          action: { id: "identity", label: "Change client identity", interrupt: "resume" } },
        { kind: "toggle", label: "Prewarm", value: prewarm, action: { id: "prewarm", label: "Change prewarming", interrupt: "resume" } },
      ] : [] };
    remote.publish("codex-wire", { kind: "details", surface: "settings", title: "Codex", data,
      badges: ctx.model?.api === "openai-codex-responses" ? [{
        label: "Speed", value: fastMode === "off" ? "Standard" : fastMode === "on" ? "Fast" : "Ultrafast", compact: true, control: "fast",
        description: "Saved preference for eligible ChatGPT Codex requests. The backend can downgrade priority processing.",
      }] : [],
      actions: remote.runCommand ? [{ id: "reconnect", label: "Reconnect transport", interrupt: "resume" }] : [] }, {
      fast: value => { if (value === "off" || value === "on" || value === "ultrafast") return remote.runCommand?.("fast", value); },
      identity: value => {
        if (value === "desktop" || value === "cli") return remote.runCommand?.("codex-wire", `client ${value}`);
      },
      prewarm: value => { if (typeof value === "boolean") return remote.runCommand?.("codex-wire", `prewarm ${value ? "on" : "off"}`); },
      reconnect: () => remote.runCommand?.("codex-wire", "reconnect"),
    });
  }

  function abortPending(threadId?: string): void {
    for (const [controller, owner] of pending) {
      if (threadId !== undefined && owner !== threadId) continue;
      controller.abort();
      pending.delete(controller);
    }
  }

  function stop(): void {
    diagnostics?.close(); diagnostics = undefined;
    releaseRequiredWire?.(); releaseRequiredWire = undefined;
    lifetime?.abort(); lifetime = undefined;
    abortPending();
    for (const session of sessions.values()) session.transport.close();
    sessions.clear();
    transport?.close(); transport = undefined; protocol = undefined; beganTurn = false;
    if (original) pi.registerProvider(original);
    original = undefined;
    mode = "off";
  }

  function activateUnchecked(ctx: ExtensionContext, selectedClient = readClient(pi.getFlag("codex-wire-client") ?? savedClient(directory)),
    selectedPrewarm = readPrewarm(pi.getFlag("codex-wire-prewarm") ?? savedPrewarm(directory))): void {
    const next = "codex";
    const selectedFast = savedFast(directory);
    const selectedTransport = pi.getFlag("codex-wire-transport") ?? "auto";
    if (selectedTransport !== "auto" && selectedTransport !== "sse") throw new Error("codex-wire-transport must be auto or sse");
    const compression = pi.getFlag("codex-wire-compression") ?? "on";
    if (compression !== "on" && compression !== "off") throw new Error("codex-wire-compression must be on or off");
    const identity = codexIdentity({
      client: selectedClient,
      desktopVersion: pi.getFlag("codex-wire-desktop-version") as string | undefined,
      userAgent: pi.getFlag("codex-wire-user-agent") as string | undefined ?? readUserAgent(directory, selectedClient),
      originator: pi.getFlag("codex-wire-originator") as string | undefined,
    });
    stop(); mode = next; client = selectedClient; prewarm = selectedPrewarm; fastMode = selectedFast;
    lastFastCheck = "not checked"; lastRequest = "not tested";
    const currentLifetime = lifetime = new AbortController();
    const currentSessions = sessions = new Map<string, WireSession>();
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (!provider) throw new Error("The openai-codex provider is unavailable");
    original = provider;
    diagnostics = new Diagnostics(join(directory, "logs", `${randomUUID()}.jsonl`),
      () => ctx.ui.notify("Codex wire diagnostics could not be written; this run cannot support an allowance comparison.", "warning"));
    diagnostics.write({ kind: "run", profile: mode, referenceVersion: CODEX_VERSION, transport: selectedTransport,
      compression, client, prewarm, rootSessionId: ctx.sessionManager.getSessionId() });
    // Housekeeping runs at activation, never inside a model request.
    void retainDiagnostics(join(directory, "logs")).catch(() => {
      if (!currentLifetime.signal.aborted) ctx.ui.notify("Codex Wire could not retire old diagnostics.", "warning");
    });
    if (identity) {
      catalog = new Catalog(identity);
      const windows = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "codex-wire-window");
      const lastWindow = windows.at(-1);
      const window = object(lastWindow?.type === "custom" ? lastWindow.data : undefined).id;
      protocol = new Protocol(mode as Profile, ctx.sessionManager.getSessionId(), installationId(directory), identity,
        typeof window === "string" ? window : undefined);
      if (!window) pi.appendEntry("codex-wire-window", { id: protocol.getWindowId() });
      transport = new WireTransport(diagnostics, protocol, selectedTransport, globalThis.fetch, process.env,
        headers => pi.events.emit(ALLOWANCE_EVENT, headers), selectedPrewarm);
      currentSessions.set(protocol.threadId, { protocol, transport });
    }
    const currentDiagnostics = diagnostics;
    const primaryProtocol = protocol;
    const primarySession = protocol ? currentSessions.get(protocol.threadId) : undefined;
    const fallbackWarnings = new Set<string>();
    const fastWarnings = new Set<string>();
    const primaryThreadId = ctx.sessionManager.getSessionId();

    function fastAvailable(metadata: JsonObject, modelId: string, tier: "priority" | "ultrafast"): boolean {
      const available = Array.isArray(metadata.service_tiers)
        && metadata.service_tiers.some(item => object(item).id === tier);
      const key = `${modelId}/${tier}`;
      if (!available && !fastWarnings.has(key)) {
        fastWarnings.add(key);
        ctx.ui.notify(`${tier === "ultrafast" ? "Ultrafast" : "Fast"} is not offered for ${modelId} in this Codex catalog; sending Standard instead.`, "warning");
      }
      return available;
    }

    function sessionFor(threadId: string): WireSession | undefined {
      if (!identity || !primaryProtocol) return;
      // Retired provider copies must remain aborted, not recreate orphan sockets.
      if (currentLifetime.signal.aborted) return primarySession;
      let session = currentSessions.get(threadId);
      if (!session) {
        const saved = ctx.sessionManager.getBranch().filter(entry =>
          entry.type === "custom" && entry.customType === SESSION_WINDOW_ENTRY
          && object(entry.data).threadId === threadId).at(-1);
        const window = object(saved?.type === "custom" ? saved.data : undefined).id;
        const childProtocol = new Protocol(next as Profile, threadId, installationId(directory), identity,
          typeof window === "string" ? window : undefined);
        session = {
          protocol: childProtocol,
          transport: new WireTransport(currentDiagnostics, childProtocol, selectedTransport as "auto" | "sse",
            // Inherited children can retain a different account. Their allowance is not the parent's.
            globalThis.fetch, process.env, undefined, selectedPrewarm),
        };
        if (!window) pi.appendEntry(SESSION_WINDOW_ENTRY, { threadId, id: childProtocol.getWindowId() });
      }
      currentSessions.delete(threadId);
      currentSessions.set(threadId, session);
      return session;
    }

    function trimIdleSessions(): void {
      const active = new Set(pending.values());
      const idle = [...currentSessions].filter(([id]) => id !== primaryProtocol?.threadId && !active.has(id));
      for (const [id, session] of idle.slice(0, Math.max(0, idle.length - 16))) {
        session.transport.close();
        currentSessions.delete(id);
      }
    }

    function wrapped(model: Model<Api>, context: TranscriptContext, options: Options | undefined, simple: boolean) {
      const threadId = options?.sessionId ?? primaryThreadId;
      guardCheckpointContext(context, model.provider, threadId);
      const call = (opts: Options) => simple ? provider!.streamSimple(model, context, opts as SimpleStreamOptions)
        : provider!.stream(model, context, opts);
      // Do not attach subscription credentials or Codex metadata to custom endpoints.
      const endpoint = new URL(model.baseUrl);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") {
        if (context.messages.some(message => Object.hasOwn(message, CHECKPOINT))) throw new Error("Codex checkpoint requires the original Codex endpoint.");
        return call(options ?? {});
      }
      const requestTier = fastMode !== "off" && model.api === "openai-codex-responses"
        && ctx.modelRegistry.isUsingOAuth(model)
        && !(options && "serviceTier" in options && options.serviceTier !== undefined)
        ? fastMode === "ultrafast" ? "ultrafast" : "priority" : undefined;
      const session = sessionFor(threadId);
      if (session) session.compactContext = undefined;
      const currentProtocol = session?.protocol;
      const currentTransport = session?.transport;
      const isPrimary = threadId === primaryThreadId;
      if (isPrimary && !currentLifetime.signal.aborted) lastRequest = "in progress";
      const controller = new AbortController();
      pending.set(controller, threadId);
      trimIdleSessions();
      const requestSignal = AbortSignal.any([currentLifetime.signal, controller.signal, ...(options?.signal ? [options.signal] : [])]);
      const requestId = randomUUID();
      const trace = requestTrace(primaryThreadId, threadId, context, options?.signal);
      currentDiagnostics.write({ kind: "invocation", requestId, ...trace });
      let body: JsonObject;
      let metadataForRequest: JsonObject | undefined;
      const opts: Options = {
        ...options,
        signal: requestSignal,
        onPayload: async (payload, requestedModel) => {
          const nextPayload = await options?.onPayload?.(payload, requestedModel);
          body = currentProtocol ? currentProtocol.shapeBody(nextPayload ?? payload) : object(nextPayload ?? payload);
          if (!currentTransport) currentDiagnostics.request(body, { requestId, transport: "provider-default" });
          return body;
        },
      };
      if (currentTransport && currentProtocol) {
        if (isPrimary) {
          if (!beganTurn) { currentProtocol.beginTurn(); beganTurn = true; }
        } else if (session) {
          // SDK children inherit the provider, not the parent's extension lifecycle hooks.
          const user = context.messages.filter(message => message.role === "user").at(-1);
          const turnKey = createHash("sha256").update(JSON.stringify(user ?? null)).digest("hex");
          if (!session.beganTurn || session.turnKey !== turnKey) currentProtocol.beginTurn();
          session.turnKey = turnKey; session.beganTurn = true;
        }
        // Reuse Pi's mature serializer and event decoder. This selects the decoder's local SSE
        // interface; WireTransport independently chooses the actual network transport.
        opts.transport = "sse";
        opts.fetch = async (url, init) => {
          // Pi's fetch deadline covers catalog lookup and transport setup, not just network headers.
          const fetchSignal = init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal;
          const headers = new Headers(init?.headers);
          const metadata = await catalog!.model(model.id, String(url), headers, fetchSignal, options?.fetch);
          metadataForRequest = metadata;
          fetchSignal.throwIfAborted();
          if (metadata.used_fallback_model_metadata === true && !fallbackWarnings.has(model.id)) {
            fallbackWarnings.add(model.id);
            ctx.ui.notify("Selected model is unlisted. Using native Codex fallback capabilities; the requested model is unchanged.", "warning");
          }
          const source = structuredClone(body);
          // Pi's built-in low verbosity is a provider default, not a user choice.
          if (!(options && "textVerbosity" in options)) delete object(source.text).verbosity;
          // Keep Pi's readable-summary default instead of replacing it with a catalog "none".
          // streamSimple may drop provider-specific options, so preserve an explicit caller choice here.
          if (options && "reasoningSummary" in options) {
            source.reasoning = { ...object(source.reasoning), summary: options.reasoningSummary };
          }
          // Pi's Codex streamSimple rebuilds its options and drops serviceTier.
          // Apply the opt-in to the serialized request, before catalog validation.
          if (requestTier && source.service_tier === undefined) source.service_tier = requestTier;
          const shaped = replayCheckpoints(shapeModelBody(source, metadata, currentProtocol.threadId), context,
            String(url));
          if (requestTier) {
            const available = fastAvailable(metadata, model.id, requestTier);
            lastFastCheck = shaped.service_tier === requestTier && available
              ? `${model.id}: ${requestTier} requested`
              : `${model.id}: Standard sent`;
          }
          const outgoing = currentProtocol.headers(headers);
          outgoing.delete("x-codex-routing-hint");
          const routingHint = requestRoutingHint(model.provider, String(url), headers, model.id, shaped.service_tier);
          if (routingHint) outgoing.set("x-codex-routing-hint", routingHint);
          if (metadata.use_responses_lite === true) outgoing.set("x-openai-internal-codex-responses-lite", "true");
          currentDiagnostics.write({ kind: "capabilities", requestId, lite: metadata.use_responses_lite === true,
            verbositySupported: metadata.support_verbosity === true, nativeFallback: metadata.used_fallback_model_metadata === true });
          return currentTransport.request({
            url: String(url), body: shaped, headers: outgoing,
            signal: fetchSignal, fetcher: options?.fetch,
            compression: requestCompression(compression === "on", model.provider, String(url), headers),
            normalizeEvent: metadata.use_responses_lite === true ? normalizeLiteEvent : undefined,
            requestId, timeoutMs: options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 300_000,
            trace,
            onFallback: () => ctx.ui.notify(
              "Codex Wire is using HTTPS temporarily. WebSocket will be retried automatically on a later request.", "info"),
          });
        };
      } else {
        opts.onResponse = async (response, requestedModel) => {
          currentDiagnostics.write({ kind: "stock-response", requestId, status: response.status });
          await options?.onResponse?.(response, requestedModel);
        };
      }
      const result = call(opts);
      void result.result().then(message => {
        pending.delete(controller);
        if (isPrimary && diagnostics === currentDiagnostics && mode !== "off") {
          lastRequest = ["error", "aborted"].includes(message.stopReason) ? message.stopReason : `succeeded (${message.stopReason})`;
        }
        if (currentTransport && metadataForRequest && !["error", "aborted"].includes(message.stopReason)) {
          try {
            const replay = responseReplay(model, context, message);
            if (metadataForRequest.use_responses_lite === true) {
              const shaped = shapeModelBody({ model: model.id, input: replay, tools: [] }, metadataForRequest, currentProtocol!.threadId);
              currentTransport.setReplayOutput(requestId, (shaped.input as unknown[]).slice(1));
            } else currentTransport.setReplayOutput(requestId, replay);
          } catch {
            currentTransport.close();
            currentDiagnostics.write({ kind: "continuation-unavailable", requestId });
          }
        }
        currentDiagnostics.write({ kind: "usage", requestId, stopReason: message.stopReason,
          input: message.usage.input, cached: message.usage.cacheRead, output: message.usage.output,
          reasoning: message.usage.reasoning ?? 0 });
        trimIdleSessions();
      }).catch(() => {
        pending.delete(controller);
        if (isPrimary && diagnostics === currentDiagnostics && mode !== "off") lastRequest = "error";
        currentDiagnostics.write({ kind: "usage-unavailable", requestId });
        trimIdleSessions();
      });
      return result;
    }

    const registeredProvider: Provider = { ...provider,
      stream: (model, context, options) => wrapped(model, context, options, false),
      streamSimple: (model, context, options) => wrapped(model, context, options, true),
    };
    pi.registerProvider(registeredProvider);
    registerCompactor(registeredProvider, async operation => {
      const owner = operation.ctx.sessionManager.getSessionId();
      if ([...pending.values()].includes(owner)) throw new Error("Wait for this session's active request before compacting.");
      const session = sessionFor(owner);
      if (!session || currentLifetime.signal.aborted) throw new Error("Codex Wire is unavailable for compaction.");
      const controller = new AbortController();
      pending.set(controller, owner);
      const signal = AbortSignal.any([operation.signal, currentLifetime.signal, controller.signal]);
      try {
        signal.throwIfAborted();
        const selected = operation.ctx.model;
        if (!selected || selected.provider !== "openai-codex") throw new Error("Select a Codex model for compaction.");
        const auth = await operation.ctx.modelRegistry.getApiKeyAndHeaders(selected);
        signal.throwIfAborted();
        if (!auth.ok) throw new Error("Cannot resolve Codex compaction authentication.");
        const model = auth.baseUrl ? { ...selected, baseUrl: auth.baseUrl } : selected;
        const { url, headers } = codexRequestAuth(model.baseUrl, auth.apiKey, model.headers, auth.headers);
        const metadata = await catalog!.model(model.id, url, headers, signal);
        signal.throwIfAborted();
        if (session.compactContext !== operation.context) {
          session.transport.close(); session.protocol.beginTurn(operation.reason); session.compactContext = operation.context;
        }
        const source = compactInput(model, operation.context, operation.thinking);
        const tier = fastMode === "ultrafast" ? "ultrafast" : "priority";
        if (fastMode !== "off" && operation.ctx.modelRegistry.isUsingOAuth(selected) && fastAvailable(metadata, model.id, tier)) {
          source.service_tier = tier;
        }
        if (metadata.default_reasoning_summary !== undefined) {
          source.reasoning = { ...object(source.reasoning), summary: metadata.default_reasoning_summary };
        }
        const body = replayCheckpoints(shapeModelBody(session.protocol.shapeBody(compactBody(source)), metadata, owner), operation.context, url);
        const outgoing = session.protocol.compactHeaders(headers, operation.reason);
        outgoing.delete("x-codex-routing-hint");
        const routingHint = requestRoutingHint(model.provider, url, headers, model.id, body.service_tier);
        if (routingHint) outgoing.set("x-codex-routing-hint", routingHint);
        if (metadata.use_responses_lite === true) outgoing.set("x-openai-internal-codex-responses-lite", "true");
        const result = await requestCompact({ url, body, headers: outgoing, signal, requestId: randomUUID(),
          compression: requestCompression(compression === "on", model.provider, url, headers),
          timeoutMs: operation.timeoutMs, trace: requestTrace(primaryThreadId, owner, operation.context, operation.signal) },
          currentDiagnostics, session.transport);
        signal.throwIfAborted();
        return createCheckpoint(result.output, result.usage);
      } finally { pending.delete(controller); trimIdleSessions(); }
    });
    // models.json recomposes effective providers without replacing their native registration.
    releaseRequiredWire = registerRequiredWire(primaryThreadId, () =>
      !currentLifetime.signal.aborted && !!primaryProtocol && !!primarySession
      && ctx.modelRegistry.getRegisteredNativeProvider("openai-codex") === registeredProvider);
    showWireStatus(ctx);
    if (ctx.model?.provider === "openai-codex") ctx.ui.notify(`Codex wire ${mode}; diagnostics: ${currentDiagnostics.path}`, "info");
  }

  function activate(ctx: ExtensionContext, selectedClient?: Client, selectedPrewarm?: boolean): void {
    const previousLifetime = lifetime;
    try { activateUnchecked(ctx, selectedClient, selectedPrewarm); }
    catch (error) {
      // Invalid settings rejected before teardown must not disrupt a valid
      // running Wire registration. Fail closed once replacement has started.
      if (previousLifetime && lifetime === previousLifetime && !previousLifetime.signal.aborted) {
        let intact = false;
        try { requireCodexWire(ctx.sessionManager.getSessionId()); intact = true; } catch { /* Block below. */ }
        if (intact) throw error;
      }
      stop();
      const base = ctx.modelRegistry.getProvider("openai-codex");
      if (base) {
        original = base;
        const fail = (): never => { throw new Error("Codex Wire activation failed. Correct the startup error and reload before sending requests."); };
        pi.registerProvider({ ...base, stream: fail, streamSimple: fail });
      }
      ctx.ui.setStatus("codex-wire", ctx.model?.provider === "openai-codex" ? "wire:error" : undefined);
      throw error;
    }
  }
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex") { activate(ctx); return; }
    stop(); showWireStatus(ctx);
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (!provider) return;
    original = provider;
    let live = true;
    const ensure = () => {
      if (!live) throw Error("This deferred Codex provider has retired.");
      activate(ctx);
      return ctx.modelRegistry.getProvider("openai-codex")!;
    };
    pi.registerProvider({ ...provider,
      stream: (model, context, options) => ensure().stream(model, context, options),
      streamSimple: (model, context, options) => ensure().streamSimple(model, context, options),
    });
    const release = registerRequiredWire(ctx.sessionManager.getSessionId(), () => {
      ensure(); requireCodexWire(ctx.sessionManager.getSessionId()); return true;
    });
    releaseRequiredWire = () => { live = false; release(); };
  });
  pi.on("before_provider_headers", (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex") requireCodexWire(ctx.sessionManager.getSessionId());
  });
  pi.on("before_agent_start", () => {
    protocol?.beginTurn(); beganTurn = true;
  });
  pi.on("agent_settled", (_event, ctx) => { beganTurn = false; showWireStatus(ctx); });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex" && mode === "off") requireCodexWire(ctx.sessionManager.getSessionId());
    abortPending(ctx.sessionManager.getSessionId()); transport?.close(); beganTurn = false; showWireStatus(ctx);
  });
  const newWindow = () => {
    if (!protocol) return;
    abortPending(protocol.threadId); transport?.close(); protocol.rotateWindow(); beganTurn = false;
    pi.appendEntry("codex-wire-window", { id: protocol.getWindowId() });
    diagnostics?.write({ kind: "context-window-replaced" });
  };
  pi.on("session_compact", newWindow);
  pi.on("session_tree", newWindow);
  pi.on("session_shutdown", () => { stop(); });
  pi.registerCommand("fast", {
    description: "ChatGPT Codex speed (higher credit use): on, off, ultrafast, or status",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action || action === "status") {
        ctx.ui.notify(`Codex speed: ${fastMode} (saved)\nLast check: ${lastFastCheck}\nOnly supported ChatGPT Codex models use it; the backend can downgrade a request.`, "info");
        return;
      }
      if (!ctx.isIdle() || pending.size > 0) {
        ctx.ui.notify("Wait for all Codex requests to finish before changing Fast mode.", "warning");
        return;
      }
      try {
        const selected = readFast(action);
        saveFast(directory, selected);
        fastMode = selected;
        lastFastCheck = "not checked";
        for (const session of sessions.values()) session.transport.close();
        transport?.close();
        showWireStatus(ctx);
        ctx.ui.notify(selected !== "off"
          ? `Codex ${selected === "ultrafast" ? "Ultrafast" : "Fast"} saved. Eligible ChatGPT requests ask for ${selected === "ultrafast" ? "ultrafast" : "priority"} processing at higher credit use.`
          : "Codex Standard saved. New requests use the normal tier.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Cannot change Fast mode", "error");
      }
    },
  });
  pi.registerCommand("codex-wire", {
    description: "Always-on Codex wire: status, reconnect, prewarm <on|off>, client <cli|desktop>, user-agent <profile>, or mark <used-percent> <reset-id>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || parts[0] === "status") {
        ctx.ui.notify(`Codex wire: ${mode === "off" ? "unavailable" : mode} (always enabled)\nClient: ${client}\nPrewarm: ${prewarm ? "on" : "off"}\nLast request: ${lastRequest}${diagnostics ? `\n${diagnostics.path}` : ""}`, "info"); return;
      }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for Pi to finish before changing or marking a comparison run.", "warning"); return; }
      if (parts[0] === "prewarm") {
        try {
          if (parts.length !== 2) throw new Error("Use /codex-wire prewarm <on|off>");
          const enabled = readPrewarm(parts[1]);
          activate(ctx, client, enabled);
          savePrewarm(directory, enabled);
          ctx.ui.notify(`Codex Wire prewarming ${enabled ? "on" : "off"}; saved. Wire remains enabled.`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot set prewarming", "error"); }
        return;
      }
      if (parts[0] === "client") {
        try {
          if (parts.length !== 2) throw new Error("Use /codex-wire client <cli|desktop>");
          const selected = readClient(parts[1]);
          activate(ctx, selected);
          saveClient(directory, selected);
          ctx.ui.notify(`Codex wire client: ${selected}; saved for future sessions.`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot select Codex client", "error"); }
        return;
      }
      if (parts[0] === "user-agent") {
        try {
          const userAgent = args.trim().slice("user-agent".length).trim();
          codexIdentity({ client, desktopVersion: pi.getFlag("codex-wire-desktop-version") as string | undefined,
            userAgent, originator: pi.getFlag("codex-wire-originator") as string | undefined });
          saveUserAgent(directory, userAgent, client);
          ctx.ui.notify("Saved Codex wire User-Agent. Applies on the next activation, resume or reload.", "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot save Codex wire User-Agent", "error"); }
        return;
      }
      if (parts[0] === "mark") {
        const used = Number(parts[1]);
        if (parts.length !== 3 || !Number.isFinite(used) || used < 0 || used > 100 || !/^[a-zA-Z0-9:_-]{1,64}$/.test(parts[2])) {
          ctx.ui.notify("Use /codex-wire mark <used-percent 0..100> <reset-id>; use the same reset-id throughout one allowance window.", "error"); return;
        }
        if (!diagnostics || mode === "off") { ctx.ui.notify("Enable a comparison mode first.", "error"); return; }
        diagnostics.write({ kind: "allowance-mark", usedPercent: used, resetId: parts[2] });
        ctx.ui.notify("Recorded allowance snapshot. No model request was made.", "info"); return;
      }
      if (parts.length !== 1 || parts[0] !== "reconnect") {
        ctx.ui.notify("Codex Wire is always enabled. Use status, reconnect, prewarm, client, user-agent, or mark.", "error"); return;
      }
      try { activate(ctx, client); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot activate Codex wire", "error"); }
    },
  });
  nativeCompaction(pi);
}

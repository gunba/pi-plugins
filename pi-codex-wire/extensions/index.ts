import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StreamOptions, SimpleStreamOptions, Model, Api, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages, createGrammarToolInputProperties } from "./serializer.ts";
import { Diagnostics, object, type JsonObject, type Profile } from "./diagnostics.ts";
import { Protocol } from "./protocol.ts";
import { CODEX_VERSION, codexIdentity } from "./identity.ts";
import { requestCompression, requestRoutingHint } from "./compression.ts";
import { WireTransport } from "./transport.ts";
import { ALLOWANCE_EVENT } from "./allowance.ts";
import { Catalog } from "./catalog.ts";
import { shapeModelBody, normalizeLiteEvent } from "./model-shape.ts";
import { readDefaultMode, readMode, saveDefaultMode, readUserAgent, saveUserAgent, type Mode } from "./settings.ts";

type Options = StreamOptions | SimpleStreamOptions;
// Providers belong to the host runtime, which may differ from our serializer SDK.
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type WireSession = { protocol: Protocol; transport: WireTransport; turnKey?: string; beganTurn?: boolean };

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
  pi.registerFlag("codex-wire", { type: "string", description: "Codex wire mode: off, stock, pi, codex (overrides saved default)" });
  pi.registerFlag("codex-wire-transport", { type: "string", default: "auto", description: "Wire transport: auto (WebSocket with SSE fallback) or sse" });
  pi.registerFlag("codex-wire-compression", { type: "string", default: "on", description: "Native request-compression feature: on (Codex default) or off" });
  pi.registerFlag("codex-wire-user-agent", { type: "string", description: "Exact native User-Agent profile; required outside Windows" });
  pi.registerFlag("codex-wire-originator", { type: "string", description: "Native originator override (default codex_cli_rs)" });
  let mode: Mode = "off";
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

  function abortPending(threadId?: string): void {
    for (const [controller, owner] of pending) {
      if (threadId !== undefined && owner !== threadId) continue;
      controller.abort();
      pending.delete(controller);
    }
  }

  function stop(): void {
    lifetime?.abort(); lifetime = undefined;
    abortPending();
    for (const session of sessions.values()) session.transport.close();
    sessions.clear();
    transport?.close(); transport = undefined; protocol = undefined; beganTurn = false;
    if (original) pi.registerProvider(original);
    original = undefined;
  }

  function activate(next: Mode, ctx: ExtensionContext): void {
    if (next === "off") { stop(); mode = "off"; lastRequest = "not tested"; ctx.ui.setStatus("codex-wire", undefined); return; }
    const selectedTransport = pi.getFlag("codex-wire-transport") ?? "auto";
    if (selectedTransport !== "auto" && selectedTransport !== "sse") throw new Error("codex-wire-transport must be auto or sse");
    const compression = pi.getFlag("codex-wire-compression") ?? "on";
    if (compression !== "on" && compression !== "off") throw new Error("codex-wire-compression must be on or off");
    const identity = next === "stock" ? undefined : codexIdentity({
      userAgent: pi.getFlag("codex-wire-user-agent") as string | undefined ?? readUserAgent(directory),
      originator: pi.getFlag("codex-wire-originator") as string | undefined,
    });
    stop(); mode = next; lastRequest = "not tested";
    const currentLifetime = lifetime = new AbortController();
    const currentSessions = sessions = new Map<string, WireSession>();
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (!provider) throw new Error("The openai-codex provider is unavailable");
    original = provider;
    diagnostics = new Diagnostics(join(directory, "logs", `${randomUUID()}.jsonl`),
      () => ctx.ui.notify("Codex wire diagnostics could not be written; this run cannot support an allowance comparison.", "warning"));
    diagnostics.write({ kind: "run", profile: mode, referenceVersion: CODEX_VERSION, transport: selectedTransport,
      compression: mode === "stock" ? "provider-default" : compression });
    if (identity) {
      catalog ??= new Catalog(identity);
      const windows = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "codex-wire-window");
      const lastWindow = windows.at(-1);
      const window = object(lastWindow?.type === "custom" ? lastWindow.data : undefined).id;
      protocol = new Protocol(mode as Profile, ctx.sessionManager.getSessionId(), installationId(directory), identity, typeof window === "string" ? window : undefined);
      if (!window) pi.appendEntry("codex-wire-window", { id: protocol.getWindowId() });
      transport = new WireTransport(diagnostics, protocol, selectedTransport, globalThis.fetch, process.env,
        headers => pi.events.emit(ALLOWANCE_EVENT, headers));
      currentSessions.set(protocol.threadId, { protocol, transport });
    }
    const currentDiagnostics = diagnostics;
    const primaryProtocol = protocol;
    const primarySession = protocol ? currentSessions.get(protocol.threadId) : undefined;
    const fallbackWarnings = new Set<string>();
    const primaryThreadId = ctx.sessionManager.getSessionId();

    function sessionFor(threadId: string): WireSession | undefined {
      if (!identity || !primaryProtocol) return;
      // Retired provider copies must remain aborted, not recreate orphan sockets.
      if (currentLifetime.signal.aborted) return primarySession;
      let session = currentSessions.get(threadId);
      if (!session) {
        const saved = ctx.sessionManager.getBranch().filter(entry =>
          entry.type === "custom" && entry.customType === "codex-wire-session-window"
          && object(entry.data).threadId === threadId).at(-1);
        const window = object(saved?.type === "custom" ? saved.data : undefined).id;
        const childProtocol = new Protocol(next as Profile, threadId, installationId(directory), identity,
          typeof window === "string" ? window : undefined);
        session = {
          protocol: childProtocol,
          transport: new WireTransport(currentDiagnostics, childProtocol, selectedTransport as "auto" | "sse",
            globalThis.fetch, process.env, headers => pi.events.emit(ALLOWANCE_EVENT, headers)),
        };
        if (!window) pi.appendEntry("codex-wire-session-window", { threadId, id: childProtocol.getWindowId() });
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

    function wrapped(model: Model<Api>, context: Context, options: Options | undefined, simple: boolean) {
      const call = (opts: Options) => simple ? provider!.streamSimple(model, context, opts as SimpleStreamOptions)
        : provider!.stream(model, context, opts);
      // Do not attach subscription credentials or Codex metadata to custom endpoints.
      const endpoint = new URL(model.baseUrl);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") return call(options ?? {});
      const threadId = options?.sessionId ?? primaryThreadId;
      const session = sessionFor(threadId);
      const currentProtocol = session?.protocol;
      const currentTransport = session?.transport;
      const isPrimary = threadId === primaryThreadId;
      if (isPrimary && !currentLifetime.signal.aborted) lastRequest = "in progress";
      const controller = new AbortController();
      pending.set(controller, threadId);
      trimIdleSessions();
      const requestSignal = AbortSignal.any([currentLifetime.signal, controller.signal, ...(options?.signal ? [options.signal] : [])]);
      const requestId = randomUUID();
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
          const headers = new Headers(init?.headers);
          const metadata = await catalog!.model(model.id, String(url), headers, requestSignal, options?.fetch);
          metadataForRequest = metadata;
          requestSignal.throwIfAborted();
          if (metadata.used_fallback_model_metadata === true && !fallbackWarnings.has(model.id)) {
            fallbackWarnings.add(model.id);
            ctx.ui.notify("Selected model is unlisted. Using native Codex fallback capabilities; the requested model is unchanged.", "warning");
          }
          const source = structuredClone(body);
          // Pi's built-in low verbosity is a provider default, not a user choice.
          if (!(options && "textVerbosity" in options)) delete object(source.text).verbosity;
          if (!(options && "reasoningSummary" in options) && metadata.default_reasoning_summary !== undefined) {
            object(source.reasoning).summary = metadata.default_reasoning_summary;
          }
          const shaped = shapeModelBody(source, metadata, currentProtocol.threadId);
          const outgoing = currentProtocol.headers(headers);
          outgoing.delete("x-codex-routing-hint");
          const routingHint = requestRoutingHint(model.provider, String(url), headers, model.id, shaped.service_tier);
          if (routingHint) outgoing.set("x-codex-routing-hint", routingHint);
          if (metadata.use_responses_lite === true) outgoing.set("x-openai-internal-codex-responses-lite", "true");
          currentDiagnostics.write({ kind: "capabilities", requestId, lite: metadata.use_responses_lite === true,
            verbositySupported: metadata.support_verbosity === true, nativeFallback: metadata.used_fallback_model_metadata === true });
          return currentTransport.request({
            url: String(url), body: shaped, headers: outgoing,
            signal: requestSignal, fetcher: options?.fetch,
            compression: requestCompression(compression === "on", model.provider, String(url), headers),
            normalizeEvent: metadata.use_responses_lite === true ? normalizeLiteEvent : undefined,
            requestId, timeoutMs: options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 300_000,
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
            const replay = convertResponsesMessages(model, { messages: [message] }, new Set(["openai", "openai-codex", "opencode"]), {
              includeSystemPrompt: false,
              grammarToolInputProperties: createGrammarToolInputProperties(context.tools,
                model.compat && "supportsOpenAIGrammarTools" in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false),
            }).filter(item => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
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

    pi.registerProvider({ ...provider,
      stream: (model, context, options) => wrapped(model, context, options, false),
      streamSimple: (model, context, options) => wrapped(model, context, options, true),
    });
    ctx.ui.setStatus("codex-wire", `wire:${mode}`);
    ctx.ui.notify(`Codex wire ${mode}; diagnostics: ${currentDiagnostics.path}`, "info");
  }

  pi.on("session_start", (_event, ctx) => activate(readMode(pi.getFlag("codex-wire") ?? readDefaultMode(directory)), ctx));
  pi.on("before_agent_start", () => {
    protocol?.beginTurn(); beganTurn = true;
  });
  pi.on("agent_settled", () => { beganTurn = false; });
  pi.on("model_select", (_event, ctx) => { abortPending(ctx.sessionManager.getSessionId()); transport?.close(); beganTurn = false; });
  const newWindow = (_event: unknown, ctx: ExtensionContext) => {
    if (!protocol) return;
    abortPending(protocol.threadId); transport?.close(); protocol.rotateWindow(); beganTurn = false;
    pi.appendEntry("codex-wire-window", { id: protocol.getWindowId() });
    diagnostics?.write({ kind: "context-window-replaced" });
  };
  pi.on("session_compact", newWindow);
  pi.on("session_tree", newWindow);
  pi.on("session_shutdown", () => { stop(); });
  pi.registerCommand("codex-wire", {
    description: "Codex wire mode, default <off/stock/pi/codex>, user-agent <profile>, status, or mark <used-percent> <reset-id>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || parts[0] === "status") {
        ctx.ui.notify(`Codex wire: ${mode}\nSaved default: ${readDefaultMode(directory)}\nLast request: ${lastRequest}${diagnostics ? `\n${diagnostics.path}` : ""}`, "info"); return;
      }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for Pi to finish before changing or marking a comparison run.", "warning"); return; }
      if (parts[0] === "user-agent") {
        try {
          const userAgent = args.trim().slice("user-agent".length).trim();
          codexIdentity({ userAgent, originator: pi.getFlag("codex-wire-originator") as string | undefined });
          saveUserAgent(directory, userAgent);
          ctx.ui.notify("Saved Codex wire User-Agent. Applies on the next activation, resume or reload.", "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot save Codex wire User-Agent", "error"); }
        return;
      }
      if (parts[0] === "default") {
        try {
          if (parts.length !== 2) throw new Error("Use /codex-wire default <off|stock|pi|codex>");
          saveDefaultMode(directory, parts[1]);
          ctx.ui.notify(`Saved Codex wire default: ${parts[1]}. Applies to new, resumed and reloaded sessions; the current mode is unchanged.`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot save Codex wire default", "error"); }
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
      try { activate(readMode(parts[0]), ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Cannot activate Codex wire", "error"); }
    },
  });
}

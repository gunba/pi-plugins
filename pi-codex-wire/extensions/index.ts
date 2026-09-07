import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider, StreamOptions, SimpleStreamOptions, Model, Api, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { Diagnostics, object, type JsonObject, type Profile } from "./diagnostics.ts";
import { Protocol } from "./protocol.ts";
import { CODEX_VERSION, codexIdentity } from "./identity.ts";
import { requestCompression } from "./compression.ts";
import { WireTransport } from "./transport.ts";
import { Catalog } from "./catalog.ts";
import { shapeModelBody, normalizeLiteEvent } from "./model-shape.ts";

type Mode = "off" | "stock" | Profile;
type Options = StreamOptions | SimpleStreamOptions;

export function readMode(value: unknown): Mode {
  if (["off", "stock", "pi", "codex"].includes(String(value))) return value as Mode;
  throw new Error("codex-wire must be off, stock, pi or codex");
}

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
  pi.registerFlag("codex-wire", { type: "string", default: "off", description: "Codex wire experiment: off, stock, pi, codex" });
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
  const pending = new Set<AbortController>();

  function abortPending(): void {
    for (const controller of pending) controller.abort();
    pending.clear();
  }

  function stop(): void {
    abortPending();
    transport?.close(); transport = undefined; protocol = undefined; beganTurn = false;
    if (original) pi.registerProvider(original);
    original = undefined;
  }

  function activate(next: Mode, ctx: ExtensionContext): void {
    if (next === "off") { stop(); mode = "off"; ctx.ui.setStatus("codex-wire", undefined); return; }
    const selectedTransport = pi.getFlag("codex-wire-transport") ?? "auto";
    if (selectedTransport !== "auto" && selectedTransport !== "sse") throw new Error("codex-wire-transport must be auto or sse");
    const compression = pi.getFlag("codex-wire-compression") ?? "on";
    if (compression !== "on" && compression !== "off") throw new Error("codex-wire-compression must be on or off");
    const identity = next === "stock" ? undefined : codexIdentity({
      userAgent: pi.getFlag("codex-wire-user-agent") as string | undefined,
      originator: pi.getFlag("codex-wire-originator") as string | undefined,
    });
    stop(); mode = next;
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (!provider) throw new Error("The openai-codex provider is unavailable");
    original = provider;
    const directory = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "codex-wire");
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
      transport = new WireTransport(diagnostics, protocol, selectedTransport);
    }
    const currentDiagnostics = diagnostics;
    const currentProtocol = protocol;
    const currentTransport = transport;

    function wrapped(model: Model<Api>, context: Context, options: Options | undefined, simple: boolean) {
      const call = (opts: Options) => simple ? provider!.streamSimple(model, context, opts as SimpleStreamOptions)
        : provider!.stream(model, context, opts);
      // Do not attach subscription credentials or Codex metadata to custom endpoints.
      const endpoint = new URL(model.baseUrl);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") return call(options ?? {});
      const controller = new AbortController();
      pending.add(controller);
      const requestSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
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
        if (!beganTurn) { currentProtocol.beginTurn(); currentTransport.beginTurn(); beganTurn = true; }
        // Reuse Pi's mature serializer and event decoder. This selects the decoder's local SSE
        // interface; WireTransport independently chooses the actual network transport.
        opts.transport = "sse";
        opts.fetch = async (url, init) => {
          const headers = new Headers(init?.headers);
          const metadata = await catalog!.model(model.id, String(url), headers, requestSignal, options?.fetch);
          metadataForRequest = metadata;
          requestSignal.throwIfAborted();
          const source = structuredClone(body);
          // Pi's built-in low verbosity is a provider default, not a user choice.
          if (!(options && "textVerbosity" in options)) delete object(source.text).verbosity;
          if (!(options && "reasoningSummary" in options) && metadata.default_reasoning_summary !== undefined) {
            object(source.reasoning).summary = metadata.default_reasoning_summary;
          }
          const shaped = shapeModelBody(source, metadata);
          const outgoing = currentProtocol.headers(headers);
          if (metadata.use_responses_lite === true) outgoing.set("x-openai-internal-codex-responses-lite", "true");
          currentDiagnostics.write({ kind: "capabilities", requestId, lite: metadata.use_responses_lite === true,
            verbositySupported: metadata.support_verbosity === true });
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
        if (currentTransport && metadataForRequest && !["error", "aborted"].includes(message.stopReason)) {
          try {
            const replay = convertResponsesMessages(model, { messages: [message] }, new Set(["openai", "openai-codex", "opencode"]), {
              includeSystemPrompt: false,
              grammarToolInputProperties: createGrammarToolInputProperties(context.tools,
                model.compat && "supportsOpenAIGrammarTools" in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false),
            }).filter(item => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
            if (metadataForRequest.use_responses_lite === true) {
              const shaped = shapeModelBody({ model: model.id, input: replay, tools: [] }, metadataForRequest);
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
      }).catch(() => { pending.delete(controller); currentDiagnostics.write({ kind: "usage-unavailable", requestId }); });
      return result;
    }

    pi.registerProvider({ ...provider,
      stream: (model, context, options) => wrapped(model, context, options, false),
      streamSimple: (model, context, options) => wrapped(model, context, options, true),
    });
    ctx.ui.setStatus("codex-wire", `wire:${mode}`);
    ctx.ui.notify(`Codex wire ${mode}; diagnostics: ${currentDiagnostics.path}`, "info");
  }

  pi.on("session_start", (_event, ctx) => activate(readMode(pi.getFlag("codex-wire") ?? "off"), ctx));
  pi.on("before_agent_start", () => {
    protocol?.beginTurn(); transport?.beginTurn(); beganTurn = true;
  });
  pi.on("agent_settled", () => { beganTurn = false; });
  pi.on("model_select", () => { abortPending(); transport?.close(); beganTurn = false; });
  const newWindow = (_event: unknown, ctx: ExtensionContext) => {
    if (!protocol) return;
    abortPending(); transport?.close(); protocol.rotateWindow(); beganTurn = false;
    pi.appendEntry("codex-wire-window", { id: protocol.getWindowId() });
    diagnostics?.write({ kind: "context-window-replaced" });
  };
  pi.on("session_compact", newWindow);
  pi.on("session_tree", newWindow);
  pi.on("session_shutdown", () => { stop(); });
  pi.registerCommand("codex-wire", {
    description: "Codex wire mode (off/stock/pi/codex), status, or mark <used-percent> <reset-id>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || parts[0] === "status") {
        ctx.ui.notify(`Codex wire: ${mode}${diagnostics ? `\n${diagnostics.path}` : ""}`, "info"); return;
      }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for Pi to finish before changing or marking a comparison run.", "warning"); return; }
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

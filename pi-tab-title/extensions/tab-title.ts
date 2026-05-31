import { createHash } from "node:crypto";
import path from "node:path";
import { completeSimple, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;
type TitleState = "fresh" | "thinking" | "ready" | "error";
type TitleSource = "model" | "fallback" | "manual";

type StoredTitle = {
  version: 1;
  title: string;
  source: TitleSource;
  promptHash: string;
  generatedAt: number;
  model?: string;
};

type GeneratedTitle = {
  title: string;
  source: TitleSource;
  model?: Model<Api>;
};

const EXTENSION_NAME = "pi-tab-title";
const STORED_TITLE_TYPE = "pi-tab-title";
const TITLE_MIN_CHARS = 20;
const TITLE_MAX_CHARS = 30;
const PROMPT_MAX_CHARS = 2_000;
const TITLE_MODEL_TIMEOUT_MS = 6_000;
const TITLE_MAX_TOKENS = 48;
// Keep the animation inside the Braille block: those glyphs share a stable
// advance in terminal tab fonts, so the title does not shift while pulsing.
const THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TABBY_TITLE_OSC = "\x1b]30;";
const OSC_TERMINATOR = "\x07";
const STATE_INDICATORS: Record<Exclude<TitleState, "thinking">, string> = {
  fresh: "○",
  ready: "✓",
  error: "✗",
};

const TITLE_SYSTEM_PROMPT = [
  "You name terminal tabs for coding-agent sessions.",
  "Return one short plain-text title only: no quotes, no markdown, no emoji, no explanation.",
  `Aim for ${TITLE_MIN_CHARS}-${TITLE_MAX_CHARS} visible characters, usually 3-5 words.`,
  "Name the user's actual task, not the app, unless the app is the task.",
].join("\n");

const PROVIDER_PREFERRED_MODELS: Record<string, string[]> = {
  "openai-codex": ["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.1-codex-mini", "gpt-5-nano", "gpt-5-mini"],
  openai: ["gpt-5.4-nano", "gpt-5.1-codex-mini", "gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini", "gpt-5-mini"],
  "azure-openai-responses": ["gpt-5.4-nano", "gpt-5.1-codex-mini", "gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini", "gpt-5-mini"],
  anthropic: ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-latest", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"],
  google: ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-3-flash-preview", "gemini-2.5-flash"],
  "google-vertex": ["gemini-2.5-flash-lite", "gemini-2.5-flash-lite-preview-09-2025", "gemini-3-flash-preview", "gemini-2.0-flash-lite", "gemini-1.5-flash-8b"],
  "github-copilot": ["claude-haiku-4.5", "gemini-3-flash-preview", "gpt-5-mini", "gpt-4o", "grok-code-fast-1"],
};

const SHORT_KEYWORDS = new Set(["ai", "ci", "db", "llm", "mcp", "osc", "pi", "qa", "rd", "ui", "ux"]);

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "and",
  "another",
  "around",
  "based",
  "because",
  "before",
  "between",
  "but",
  "can",
  "could",
  "each",
  "from",
  "get",
  "have",
  "here",
  "into",
  "just",
  "like",
  "make",
  "need",
  "needs",
  "not",
  "now",
  "our",
  "out",
  "over",
  "please",
  "should",
  "simply",
  "some",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "through",
  "using",
  "want",
  "we",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "work",
  "would",
  "you",
]);

export default function (pi: ExtensionAPI) {
  let state: TitleState = "fresh";
  let generatedTitle: string | undefined;
  let hasSeenUserMessage = false;
  let historicalFirstPrompt: string | undefined;
  let hadErrorThisRun = false;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;

  function currentBaseTitle(): string {
    const base = sanitizeTitle(pi.getSessionName() || generatedTitle || fallbackTitleFromCwd(process.cwd())) || "pi";
    return truncateTitle(base, TITLE_MAX_CHARS);
  }

  function renderTitle(ctx: ExtensionContext, indicator?: string): void {
    if (!ctx.hasUI) return;
    const marker = indicator ?? (state === "thinking" ? THINKING_FRAMES[frameIndex % THINKING_FRAMES.length] : STATE_INDICATORS[state]);
    setTerminalTitle(ctx, `${marker} ${currentBaseTitle()}`);
  }

  function stopAnimation(): void {
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
    frameIndex = 0;
  }

  function enterThinking(ctx: ExtensionContext): void {
    state = "thinking";
    stopAnimation();
    renderTitle(ctx, THINKING_FRAMES[frameIndex % THINKING_FRAMES.length]);
    if (!ctx.hasUI) return;
    animationTimer = setInterval(() => {
      frameIndex += 1;
      renderTitle(ctx, THINKING_FRAMES[frameIndex % THINKING_FRAMES.length]);
    }, 180);
    animationTimer.unref?.();
  }

  function enterStatic(ctx: ExtensionContext, nextState: Exclude<TitleState, "thinking">): void {
    state = nextState;
    stopAnimation();
    renderTitle(ctx);
  }

  async function ensureNamedFromPrompt(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    if (pi.getSessionName() || generatedTitle) return;

    const prompt = (historicalFirstPrompt || event.prompt || "").trim();
    if (!prompt) return;

    const result = await generateTitle(ctx, prompt);
    generatedTitle = result.title;

    try {
      pi.setSessionName(result.title);
    } catch {
      // Tab titles still work if session metadata cannot be written.
    }

    try {
      pi.appendEntry<StoredTitle>(STORED_TITLE_TYPE, {
        version: 1,
        title: result.title,
        source: result.source,
        promptHash: shortHash(prompt),
        generatedAt: Date.now(),
        model: result.model ? `${result.model.provider}/${result.model.id}` : undefined,
      });
    } catch {
      // Persisting the title is best-effort; the current tab can still be named.
    }

    renderTitle(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const storedTitle = findLatestStoredTitle(branch);
    if (storedTitle) generatedTitle = storedTitle;

    historicalFirstPrompt = findFirstUserPrompt(branch);
    hasSeenUserMessage = Boolean(historicalFirstPrompt);
    hadErrorThisRun = false;
    enterStatic(ctx, hasSeenUserMessage ? "ready" : "fresh");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    hadErrorThisRun = false;
    enterThinking(ctx);

    if (!hasSeenUserMessage) {
      hasSeenUserMessage = true;
      historicalFirstPrompt = event.prompt;
    }

    await ensureNamedFromPrompt(event, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    hadErrorThisRun = false;
    enterThinking(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!event.isError) return;
    hadErrorThisRun = true;
    enterStatic(ctx, "error");
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as AnyRecord;
    if (message.role !== "assistant") return;
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
      hadErrorThisRun = true;
      enterStatic(ctx, "error");
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status < 400) return;
    hadErrorThisRun = true;
    enterStatic(ctx, "error");
  });

  pi.on("agent_end", async (_event, ctx) => {
    enterStatic(ctx, hadErrorThisRun ? "error" : "ready");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopAnimation();
  });

  pi.registerCommand("tab-title", {
    description: "Set the Pi-managed terminal tab title base while keeping state indicators",
    handler: async (args, ctx) => {
      const title = normalizeGeneratedTitle(args.trim());
      if (!title) {
        ctx.ui.notify("Usage: /tab-title <short title>", "error");
        return;
      }

      generatedTitle = title;
      try {
        pi.setSessionName(title);
      } catch {
        // The visible tab title still updates even if session metadata is unavailable.
      }
      try {
        pi.appendEntry<StoredTitle>(STORED_TITLE_TYPE, {
          version: 1,
          title,
          source: "manual",
          promptHash: "manual",
          generatedAt: Date.now(),
        });
      } catch {
        // Best-effort persistence only.
      }
      renderTitle(ctx);
    },
  });
}

function setTerminalTitle(ctx: ExtensionContext, title: string): void {
  const safeTitle = sanitizeOscTitle(title);
  ctx.ui.setTitle(safeTitle);

  // Tabby keeps a separate custom-tab-title channel. After the user renames a
  // tab in Tabby's UI, OSC 0 updates can remain hidden behind that custom title.
  // OSC 30 updates the same tab-title channel, so state prefixes stay visible.
  if (isTabbyTerminal() && process.stdout.isTTY) process.stdout.write(`${TABBY_TITLE_OSC}${safeTitle}${OSC_TERMINATOR}`);
}

function isTabbyTerminal(): boolean {
  return process.env.TERM_PROGRAM === "Tabby" || Boolean(process.env.TABBY_CONFIG_DIRECTORY);
}

async function generateTitle(ctx: ExtensionContext, prompt: string): Promise<GeneratedTitle> {
  const fallback = fallbackTitleFromPrompt(prompt, ctx.cwd);
  const model = selectNamingModel(ctx);
  if (!model) return { title: fallback, source: "fallback" };

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return { title: fallback, source: "fallback" };

    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: prompt.slice(0, PROMPT_MAX_CHARS) }],
      timestamp: Date.now(),
    };

    const reasoning = preferredReasoning(model);
    const response = await completeSimple(
      model,
      { systemPrompt: TITLE_SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0,
        signal: withTimeout(ctx.signal, TITLE_MODEL_TIMEOUT_MS),
        ...(reasoning ? { reasoning } : {}),
      },
    );

    const title = normalizeGeneratedTitle(assistantText(response));
    if (!title) return { title: fallback, source: "fallback" };
    return { title, source: "model", model };
  } catch {
    return { title: fallback, source: "fallback" };
  }
}

function selectNamingModel(ctx: ExtensionContext): Model<Api> | undefined {
  const current = ctx.model as Model<Api> | undefined;
  if (!current) return undefined;

  const byKey = new Map<string, Model<Api>>();
  const add = (model: Model<Api> | undefined) => {
    if (!model) return;
    if (model.provider !== current.provider) return;
    if (!model.input.includes("text")) return;
    byKey.set(`${model.provider}/${model.id}`, model);
  };

  add(current);
  for (const model of ctx.modelRegistry.getAvailable() as Model<Api>[]) add(model);

  const candidates = [...byKey.values()];
  candidates.sort((left, right) => scoreModel(left, current) - scoreModel(right, current));
  return candidates[0];
}

function scoreModel(model: Model<Api>, current: Model<Api>): number {
  const preferred = PROVIDER_PREFERRED_MODELS[model.provider]?.indexOf(model.id) ?? -1;
  if (preferred >= 0) return -10_000 + preferred;

  const label = `${model.id} ${model.name}`.toLowerCase();
  const cost = (model.cost.input || 0) + (model.cost.output || 0) * 2 + (model.cost.cacheWrite || 0) * 0.25;
  let score = cost * 10;

  if (/nano|micro|flash-lite|haiku|lite|mini|small|spark|fast|gemma/.test(label)) score -= 40;
  if (/pro|opus|max|deep|research|large/.test(label)) score += 80;
  if (/sonnet/.test(label)) score += 30;
  if (model.id === current.id) score += 5;
  return score;
}

function preferredReasoning(model: Model<Api>): ThinkingLevel | undefined {
  try {
    const supported = getSupportedThinkingLevels(model);
    if (/codex/i.test(`${model.provider}/${model.id}`) && supported.includes("xhigh")) return "xhigh";
    if (supported.includes("minimal")) return "minimal";
    if (supported.includes("low")) return "low";
  } catch {
    // Older or custom model records can omit thinking metadata.
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as AnyRecord).text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`${EXTENSION_NAME} title generation timed out`)), timeoutMs);
  timer.unref?.();

  const signals = [timeoutController.signal, parent].filter((signal): signal is AbortSignal => Boolean(signal));
  if (signals.length === 1) return signals[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function findLatestStoredTitle(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as AnyRecord;
    if (entry.type !== "custom" || entry.customType !== STORED_TITLE_TYPE) continue;
    const title = normalizeGeneratedTitle(entry.data?.title);
    if (title) return title;
  }
  return undefined;
}

function findFirstUserPrompt(entries: SessionEntry[]): string | undefined {
  for (const entry of entries as AnyRecord[]) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = textFromContent(entry.message.content).trim();
    if (text) return text;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function normalizeGeneratedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = sanitizeTitle(value)
    .replace(/^title\s*[:\-–—]\s*/i, "")
    .split(/\s*(?:\n|\r|\||—|–)\s*/)
    .find((line) => line.trim())
    ?.trim();

  if (!firstLine) return undefined;
  const unquoted = firstLine
    .replace(/^[-*•\s]+/, "")
    .replace(/^["'`“”‘’]+/, "")
    .replace(/["'`“”‘’]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (unquoted.length < 3) return undefined;
  return truncateTitle(unquoted, TITLE_MAX_CHARS);
}

function sanitizeTitle(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\x00-\x1f\x7f\x9b]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeOscTitle(value: string): string {
  return sanitizeTitle(value).replace(/[\x07\x1b]/g, " ");
}

function truncateTitle(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;

  const hard = chars.slice(0, maxChars).join("").trim();
  const soft = hard.replace(/[\s,;:/+&-]+[^\s,;:/+&-]*$/, "").trim();
  if ([...soft].length >= TITLE_MIN_CHARS - 4) return soft;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("").trim()}…`;
}

function fallbackTitleFromPrompt(prompt: string, cwd: string): string {
  const tokens = Array.from(prompt.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#._-]*/g), (match) => match[0])
    .map((token) => token.replace(/^[_-]+|[_-]+$/g, ""))
    .filter((token) => token && !STOP_WORDS.has(token) && (token.length >= 3 || SHORT_KEYWORDS.has(token)));

  const selected: string[] = [];
  for (const token of tokens) {
    if (selected.includes(token)) continue;
    selected.push(token);
    const title = titleCase(selected).join(" ");
    if ([...title].length >= TITLE_MIN_CHARS || selected.length >= 5) break;
  }

  let candidate = titleCase(selected).join(" ") || fallbackTitleFromCwd(cwd);
  if ([...candidate].length < TITLE_MIN_CHARS - 4) {
    const cwdTitle = fallbackTitleFromCwd(cwd);
    if (!candidate.toLowerCase().includes(cwdTitle.toLowerCase())) candidate = `${candidate} ${cwdTitle}`.trim();
  }
  return normalizeGeneratedTitle(candidate) || fallbackTitleFromCwd(cwd);
}

function fallbackTitleFromCwd(cwd: string): string {
  const base = path.basename(cwd) || "pi session";
  return normalizeGeneratedTitle(base.replace(/[-_]+/g, " ")) || "pi session";
}

function titleCase(tokens: string[]): string[] {
  return tokens.map((token) => {
    if (/^(api|ai|ci|cli|db|ui|ux|llm|mcp|osc|pi|rd|r&d)$/i.test(token)) return token.toUpperCase().replace(/^PI$/, "Pi");
    return token
      .split(/([._+-])/)
      .map((part) => (/^[a-z]/.test(part) ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
      .join("");
  });
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

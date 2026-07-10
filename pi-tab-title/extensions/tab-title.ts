import { createHash } from "node:crypto";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, ToolResultMessage } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type UnknownRecord = Record<string, unknown>;
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
  "You write terminal tab titles for coding-agent sessions.",
  "Summarize what the user wants done in concrete verb/noun terms.",
  "Always produce the best possible title from the prompt, even if vague or non-coding; never ask for more information or say you need it.",
  "Ignore disclaimers, greetings, and meta-comments; name the useful request.",
  "Never judge whether the request is a coding task, and never start with phrases like 'This isn't' or 'Not a coding task'.",
  "Return one short plain-text title only: no quotes, no markdown, no emoji, no explanation.",
  `Aim for ${TITLE_MIN_CHARS}-${TITLE_MAX_CHARS} visible characters, usually 3-5 words.`,
  "Examples:",
  "User: There's a plugin which renames tabs based on the first message from the user. What is the prompt for this plugin?",
  "Title: Inspect Tab Title Prompt",
  "User: Can we give it some one shot examples?",
  "Title: Improve Tab Title Prompt",
  "User: This isn't a coding task, but help me write a birthday toast.",
  "Title: Write Birthday Toast",
  "User: Run the failing auth tests and fix the timeout.",
  "Title: Fix Auth Test Timeout",
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
const FALLBACK_FILE_BLOCK_PATTERN = /<file\b[^>]*>[\s\S]*?<\/file>/gi;
const FALLBACK_ID_PREAMBLE_PATTERN = /^\s*(?:id|session\s+id|leaf\s+id)\s*:\s*[a-z0-9][a-z0-9-]{11,}\s*(?:[-–—]\s*)?/gim;
const FALLBACK_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const FALLBACK_PATH_PATTERN = /(?<![a-z0-9._:-])(?:file:\/\/)?(?:~(?=\/)|\/|[a-z]:[\\/]|\.{1,2}[\\/])(?:[^\s"'`<>()[\]{}|]+[\\/])*[^\s"'`<>()[\]{}|]*/gi;
const FALLBACK_RELATIVE_FILE_PATH_PATTERN = /(?<![a-z0-9._:-])(?:[a-z0-9][a-z0-9._+-]*[\\/])+[a-z0-9][a-z0-9._+-]*\.[a-z0-9]{1,12}(?![a-z0-9._:-])/gi;
const FALLBACK_RELATIVE_HANDOFF_PATH_PATTERN = /(?<![A-Za-z0-9._:-])(?:[A-Za-z0-9][A-Za-z0-9._+-]*[\\/]){2,}[A-Z][A-Z0-9_-]{2,}(?![A-Za-z0-9._:-])/g;
const FALLBACK_FILE_PREAMBLE_PATTERN = /\b(?:continue\s+from|attached\s+file|session\s+id|leaf\s+id|file|session|path|source|id)\s*:\s*/gi;

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
  let generatedTitleSource: TitleSource | undefined;
  let generatedTitlePromptHash: string | undefined;
  let titleGenerationRun = 0;
  let hasSeenUserMessage = false;
  let hasTurnError = false;
  let historicalFirstPrompt: string | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;

  function currentBaseTitle(ctx: ExtensionContext): string {
    const base = sanitizeTitle(pi.getSessionName() || generatedTitle || fallbackTitleFromCwd(ctx.cwd)) || "pi";
    return truncateTitle(base, TITLE_MAX_CHARS);
  }

  function renderTitle(ctx: ExtensionContext, indicator?: string): void {
    if (!ctx.hasUI) return;
    const marker = indicator ?? (state === "thinking" ? THINKING_FRAMES[frameIndex % THINKING_FRAMES.length] : STATE_INDICATORS[state]);
    setTerminalTitle(ctx, `${marker} ${currentBaseTitle(ctx)}`);
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

  function markTurnError(ctx: ExtensionContext): void {
    hasTurnError = true;
    enterStatic(ctx, "error");
  }

  function persistTitle(title: string, source: TitleSource, promptHash: string, model?: Model<Api>): void {
    try {
      pi.setSessionName(title);
    } catch {
      // Tab titles still work if session metadata cannot be written.
    }

    try {
      pi.appendEntry<StoredTitle>(STORED_TITLE_TYPE, {
        version: 1,
        title,
        source,
        promptHash,
        generatedAt: Date.now(),
        model: model ? formatModelName(model) : undefined,
      });
    } catch {
      // Persisting the title is best-effort; the current tab can still be named.
    }
  }

  function ensureNamedFromPrompt(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (pi.getSessionName() || generatedTitle) return;

    const prompt = (historicalFirstPrompt || event.prompt || "").trim();
    if (!prompt) return;

    const promptHash = shortHash(prompt);
    const fallback = fallbackTitleFromPrompt(prompt, ctx.cwd);
    generatedTitle = fallback;
    generatedTitleSource = "fallback";
    generatedTitlePromptHash = promptHash;
    persistTitle(fallback, "fallback", promptHash);
    renderTitle(ctx);

    startBackgroundTitleGeneration(ctx, prompt, promptHash);
  }

  function startBackgroundTitleGeneration(ctx: ExtensionContext, prompt: string, promptHash: string): void {
    const runId = ++titleGenerationRun;
    void (async () => {
      const result = await generateTitle(ctx, prompt);
      if (runId !== titleGenerationRun || generatedTitlePromptHash !== promptHash || generatedTitleSource !== "fallback") return;
      if (result.source !== "model") return;

      generatedTitle = result.title;
      generatedTitleSource = result.source;
      persistTitle(result.title, result.source, promptHash, result.model);
      renderTitle(ctx);
    })().catch(() => {
      // The fallback title is already visible and persisted.
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    titleGenerationRun += 1;

    const branch = ctx.sessionManager.getBranch();
    const storedTitle = findLatestStoredTitle(branch);
    generatedTitle = storedTitle?.title;
    generatedTitleSource = storedTitle?.source;
    generatedTitlePromptHash = storedTitle?.promptHash;

    historicalFirstPrompt = findFirstUserPrompt(branch);
    hasSeenUserMessage = Boolean(historicalFirstPrompt);
    hasTurnError = latestBranchHadError(branch);
    enterStatic(ctx, hasTurnError ? "error" : hasSeenUserMessage ? "ready" : "fresh");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    hasTurnError = false;
    enterThinking(ctx);

    if (!hasSeenUserMessage) {
      hasSeenUserMessage = true;
      historicalFirstPrompt = event.prompt;
    }

    ensureNamedFromPrompt(event, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    hasTurnError = false;
    enterThinking(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.isError) markTurnError(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (isErrorMessage(event.message)) markTurnError(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    hasTurnError = latestAssistantFailed(event.messages);
    enterStatic(ctx, hasTurnError ? "error" : "ready");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    titleGenerationRun += 1;
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

      titleGenerationRun += 1;
      generatedTitle = title;
      generatedTitleSource = "manual";
      generatedTitlePromptHash = undefined;
      persistTitle(title, "manual", "manual");
      renderTitle(ctx);
    },
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isTextContent(part: unknown): part is { type: "text"; text: string } {
  return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function isUserMessage(message: unknown): message is { role: "user"; content: unknown } {
  return isRecord(message) && message.role === "user";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant";
}

function isAssistantErrorMessage(message: unknown): boolean {
  if (!isAssistantMessage(message)) return false;
  return message.stopReason === "error" || message.stopReason === "aborted" || (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0);
}

function isToolResultMessage(message: unknown): message is ToolResultMessage<unknown> {
  return isRecord(message) && message.role === "toolResult" && typeof message.isError === "boolean";
}

function isToolErrorMessage(message: unknown): boolean {
  return isToolResultMessage(message) && message.isError;
}

function isErrorMessage(message: unknown): boolean {
  return isAssistantErrorMessage(message) || isToolErrorMessage(message);
}

function latestAssistantFailed(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message)) return isAssistantErrorMessage(message);
  }
  return false;
}

function latestBranchHadError(entries: readonly SessionEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (isAssistantMessage(entry.message)) return isAssistantErrorMessage(entry.message);
    if (isUserMessage(entry.message)) return false;
  }
  return false;
}

function formatModelName(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
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
        timeoutMs: TITLE_MODEL_TIMEOUT_MS,
        maxRetries: 0,
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
  const current = ctx.model;
  if (!current) return undefined;

  const byKey = new Map<string, Model<Api>>();
  const add = (model: Model<Api> | undefined) => {
    if (!model) return;
    if (model.provider !== current.provider) return;
    if (!model.input.includes("text")) return;
    byKey.set(`${model.provider}/${model.id}`, model);
  };

  add(current);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);

  const candidates = [...byKey.values()].filter(isCheapNamingModel);
  candidates.sort((left, right) => scoreModel(left, current) - scoreModel(right, current));
  return candidates[0];
}

function preferredModelIndex(model: Model<Api>): number {
  return PROVIDER_PREFERRED_MODELS[model.provider]?.indexOf(model.id) ?? -1;
}

function modelBlendedCost(model: Model<Api>): number {
  return (model.cost.input || 0) + (model.cost.output || 0) * 2 + (model.cost.cacheWrite || 0) * 0.25;
}

function isCheapNamingModel(model: Model<Api>): boolean {
  if (preferredModelIndex(model) >= 0) return true;

  const label = `${model.id} ${model.name}`.toLowerCase();
  if (/nano|micro|flash|haiku|lite|mini|small|spark|fast|gemma/.test(label)) return true;
  return modelBlendedCost(model) <= 3;
}

function scoreModel(model: Model<Api>, current: Model<Api>): number {
  const preferred = preferredModelIndex(model);
  if (preferred >= 0) return -10_000 + preferred;

  const label = `${model.id} ${model.name}`.toLowerCase();
  let score = modelBlendedCost(model) * 10;

  if (/nano|micro|flash|haiku|lite|mini|small|spark|fast|gemma/.test(label)) score -= 40;
  if (/pro|opus|max|deep|research|large/.test(label)) score += 80;
  if (/sonnet/.test(label)) score += 30;
  if (model.id === current.id) score += 5;
  return score;
}

function preferredReasoning(model: Model<Api>): ThinkingLevel | undefined {
  try {
    const supported = getSupportedThinkingLevels(model);
    if (supported.includes("minimal")) return "minimal";
  } catch {
    // Older or custom model records can omit thinking metadata.
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter(isTextContent)
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

function findLatestStoredTitle(entries: readonly SessionEntry[]): StoredTitle | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== STORED_TITLE_TYPE) continue;
    const storedTitle = parseStoredTitle(entry.data);
    if (storedTitle) return storedTitle;
  }
  return undefined;
}

function parseStoredTitle(value: unknown): StoredTitle | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;

  const title = normalizeGeneratedTitle(value.title);
  const source = parseTitleSource(value.source);
  const promptHash = typeof value.promptHash === "string" ? value.promptHash : undefined;
  const generatedAt = typeof value.generatedAt === "number" ? value.generatedAt : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;

  if (!title || !source || !promptHash || generatedAt === undefined) return undefined;
  return { version: 1, title, source, promptHash, generatedAt, model };
}

function parseTitleSource(value: unknown): TitleSource | undefined {
  if (value === "model" || value === "fallback" || value === "manual") return value;
  return undefined;
}

function findFirstUserPrompt(entries: readonly SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !isUserMessage(entry.message)) continue;
    const text = textFromContent(entry.message.content).trim();
    if (text) return text;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isTextContent).map((part) => part.text).join("\n");
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
  const promptText = fallbackPromptText(prompt);
  const tokens = Array.from(promptText.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#._-]*/g), (match) => match[0])
    .map((token) => token.replace(/^[_-]+|[_-]+$/g, ""))
    .filter((token) => token && !STOP_WORDS.has(token) && (token.length >= 3 || SHORT_KEYWORDS.has(token)));

  const selected: string[] = [];
  for (const token of tokens) {
    if (selected.includes(token)) continue;
    selected.push(token);
    const title = titleCase(selected).join(" ");
    if ([...title].length >= TITLE_MIN_CHARS || selected.length >= 5) break;
  }

  const candidate = titleCase(selected).join(" ");
  return (candidate ? normalizeGeneratedTitle(candidate) : undefined) || (promptText ? fallbackTitleFromCwd(cwd) : "pi session");
}

function fallbackPromptText(prompt: string): string {
  return stripLeadingFallbackPreamble(
    prompt
      .replace(FALLBACK_FILE_BLOCK_PATTERN, " ")
      .replace(FALLBACK_ID_PREAMBLE_PATTERN, " ")
      .replace(FALLBACK_UUID_PATTERN, " ")
      .replace(FALLBACK_PATH_PATTERN, " ")
      .replace(FALLBACK_RELATIVE_FILE_PATH_PATTERN, " ")
      .replace(FALLBACK_RELATIVE_HANDOFF_PATH_PATTERN, " ")
      .replace(FALLBACK_FILE_PREAMBLE_PATTERN, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingFallbackPreamble(value: string): string {
  let text = value;
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(/^\s*(?:continue\s+from|attached\s+file|session\s+id|leaf\s+id|file|session|path|source|id)\b\s*:?[\s-]*/i, "");
    if (next === text) return text;
    text = next;
  }
  return text;
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

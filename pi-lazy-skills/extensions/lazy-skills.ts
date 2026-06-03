import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "pi-lazy-skills-advice";
const DISABLE_ENV = "PI_LAZY_SKILLS";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const MAX_SKILLS_PER_TURN = 5;
const MAX_DESCRIPTION_CHARS = 600;
const SELECTOR_MAX_TOKENS = 256;
// Below this estimated selector-prefix size, prompt caching cannot engage (OpenAI and
// Anthropic floors are ~1024 tokens) and hiding skills saves little context, so we fall
// back to Pi's default skill prompt instead of running the selector at all.
// Override with PI_LAZY_SKILLS_MIN_TOKENS.
const MIN_PREFIX_TOKENS = 1024;
const MIN_PREFIX_TOKENS_ENV = "PI_LAZY_SKILLS_MIN_TOKENS";
const CHARS_PER_TOKEN = 4;

const LAZY_SKILLS_PROMPT_NOTE = `Agent Skills are available lazily. A separate pre-turn selector may add a custom message titled "Skills that may be related to the user request". When such a message appears and a listed skill matches the task, use the read tool to load that skill's file. Resolve relative references against the skill directory (parent of SKILL.md / dirname of the path). Explicit /skill:name invocation still works.`;

const SELECTOR_SYSTEM_PROMPT = `You are pi-lazy-skills' skill selector.

You are given a fixed skill catalog below. Each user message contains the main agent's request and a list of already-advised skills to exclude.

Choose only skills from the catalog that are likely to be useful for the main agent's next turn.

Rules:
- Return ONLY a JSON array of skill names, e.g. ["skill-a", "skill-b"].
- Use exact skill names from the catalog.
- Choose at most ${MAX_SKILLS_PER_TURN} skills.
- Prefer high precision. Return [] when no skill clearly helps.
- Never return a skill listed in the user message's "Already advised" exclude list.
- Do not explain your choices.`;

type AnyRecord = Record<string, any>;

type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
};

function isDisabled(value: string | undefined): boolean {
  return /^(0|false|off|no|disabled)$/i.test((value ?? "").trim());
}

function isSubagentChild(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId?.() ?? "__ephemeral__";
}

function compactText(value: string, maxChars = MAX_DESCRIPTION_CHARS): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as AnyRecord).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractSkills(options: BuildSystemPromptOptions | undefined): SkillInfo[] {
  const skills = ((options?.skills ?? []) as SkillInfo[]).filter((skill) => !skill.disableModelInvocation);
  const byName = new Map<string, SkillInfo>();
  for (const skill of skills) {
    if (!skill.name || !skill.filePath) continue;
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description ?? "",
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function replaceSkillsPromptSection(systemPrompt: string): string | undefined {
  const openTag = "<available_skills>";
  const closeTag = "</available_skills>";
  const sectionMarker = "\n\nThe following skills provide specialized instructions for specific tasks.";

  const open = systemPrompt.indexOf(openTag);
  const close = open >= 0 ? systemPrompt.indexOf(closeTag, open) : -1;
  const marker = open >= 0 ? systemPrompt.lastIndexOf(sectionMarker, open) : -1;
  if (open < 0 || close < 0 || marker < 0) return undefined;

  const end = close + closeTag.length;
  const before = systemPrompt.slice(0, marker).replace(/[ \t]+$/g, "");
  const after = systemPrompt.slice(end).replace(/^\s*\n?/, "");
  return `${before}\n\n${LAZY_SKILLS_PROMPT_NOTE}${after ? `\n\n${after}` : ""}`;
}

function adviceContent(skills: SkillInfo[]): string {
  const lines = [
    "Skills that may be related to the user request:",
    "Use read to load a listed skill file only if it matches the task.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name} — ${compactText(skill.description)}`);
    lines.push(`  location: ${skill.filePath}`);
  }
  return lines.join("\n");
}

function imageAttachmentMetadata(images: readonly ImageContent[] | undefined): string {
  if (!images?.length) return "";

  const countsByMime = new Map<string, number>();
  let approximateBytes = 0;
  for (const image of images) {
    const mimeType = compactText(image.mimeType || "image/unknown", 80);
    countsByMime.set(mimeType, (countsByMime.get(mimeType) ?? 0) + 1);
    approximateBytes += Math.floor(((image.data?.length ?? 0) * 3) / 4);
  }

  const mimeSummary = [...countsByMime.entries()]
    .map(([mimeType, count]) => `${mimeType}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
  const kb = Math.max(1, Math.round(approximateBytes / 1024));
  return `\n\nUser attachments:\n- images: ${images.length}\n- mime types: ${mimeSummary || "unknown"}\n- approximate total image bytes: ${kb} KiB`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function minPrefixTokens(): number {
  const raw = process.env[MIN_PREFIX_TOKENS_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MIN_PREFIX_TOKENS;
}

// The catalog is the cached prefix: byte-identical every turn (sorted upstream, no per-turn
// flags, no timestamps) so OpenAI block-hashing and Anthropic cache_control both reuse it.
function buildSelectorCatalog(skills: SkillInfo[]): string {
  const lines = skills.map(
    (skill) => `- name: ${skill.name}\n  description: ${compactText(skill.description)}\n  location: ${skill.filePath}`,
  );
  return `Skill catalog (fixed for this session):\n${lines.join("\n")}`;
}

function buildSelectorSystemPrompt(skills: SkillInfo[]): string {
  return `${SELECTOR_SYSTEM_PROMPT}\n\n${buildSelectorCatalog(skills)}`;
}

// Only the variable tail lives here: the request and the exclude list. Keeping it after the
// catalog (which sits in the system prompt) preserves the stable cacheable prefix.
function selectorUserMessage(
  prompt: string,
  alreadyAdvised: Set<string>,
  images: readonly ImageContent[] | undefined,
): Message {
  const excluded = [...alreadyAdvised].sort();
  const excludeLine = excluded.length ? excluded.join(", ") : "(none)";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `User request:\n${prompt.trim() || "(empty)"}${imageAttachmentMetadata(images)}\n\nAlready advised (do not return these): ${excludeLine}`,
      },
    ],
    timestamp: Date.now(),
  };
}

function stripJsonFence(text: string): string {
  const stripped = text.trim();
  const fenced = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? stripped).trim();
}

function parseSelectorNames(text: string): string[] | undefined {
  const jsonText = stripJsonFence(text);
  if (!jsonText) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;
  const names: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return undefined;
    names.push(item);
  }
  return names;
}

function latestAdvisedFromBranch(ctx: ExtensionContext): Set<string> {
  const advised = new Set<string>();
  const entries = (ctx.sessionManager.getBranch?.() ?? []) as AnyRecord[];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      advised.clear();
      continue;
    }
    if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) continue;
    const names = entry.details?.skillNames;
    if (Array.isArray(names)) {
      for (const name of names) if (typeof name === "string") advised.add(name);
    }
  }
  return advised;
}

async function selectRelevantSkills(
  ctx: ExtensionContext,
  prompt: string,
  skills: SkillInfo[],
  alreadyAdvised: Set<string>,
  images: readonly ImageContent[] | undefined,
): Promise<string[] | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  if (skills.length === 0) return [];

  const candidates = skills.filter((skill) => !alreadyAdvised.has(skill.name));
  if (candidates.length === 0) return [];

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const response = await completeSimple(
    model,
    {
      systemPrompt: buildSelectorSystemPrompt(skills),
      messages: [selectorUserMessage(prompt, alreadyAdvised, images)],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: SELECTOR_MAX_TOKENS,
      // Do not set timeoutMs here: Codex WebSocket treats it as a stream-idle timeout,
      // so short selector budgets can fail while the model is legitimately thinking.
      maxRetries: 0,
      sessionId: ctx.sessionManager.getSessionId?.(),
      // "short" (5-min ephemeral) caches the stable catalog prefix across this session's
      // selector calls. Not "long": 1h Anthropic cache writes cost 2x base input tokens.
      cacheRetention: "short",
      signal: ctx.signal,
    },
  );

  if (response.stopReason === "length") return undefined;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `skill selector ended with ${response.stopReason}`);
  }

  const selectorNames = parseSelectorNames(assistantText(response));
  if (selectorNames === undefined) return undefined;

  const byLower = new Map(candidates.map((skill) => [skill.name.toLowerCase(), skill.name]));
  const selected: string[] = [];
  for (const raw of selectorNames) {
    const name = byLower.get(raw.trim().toLowerCase());
    if (!name || selected.includes(name)) continue;
    selected.push(name);
    if (selected.length >= MAX_SKILLS_PER_TURN) break;
  }
  return selected;
}

export default function lazySkills(pi: ExtensionAPI): void {
  if (isSubagentChild() || isDisabled(process.env[DISABLE_ENV])) return;

  const warnedReplacementFailure = new Set<string>();

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = extractSkills(event.systemPromptOptions);
    if (skills.length === 0) return;

    // Below the cache floor the selector prefix cannot be cached and hiding skills saves
    // little context; fall back to Pi's default skill prompt (all skills in the main prompt).
    if (estimateTokens(buildSelectorSystemPrompt(skills)) < minPrefixTokens()) return;

    const key = sessionKey(ctx);
    // Recompute from the active branch every turn so /tree navigation and compaction cannot leave stale advice state.
    const advised = latestAdvisedFromBranch(ctx);

    const systemPrompt = replaceSkillsPromptSection(event.systemPrompt);
    if (systemPrompt === undefined) {
      if (ctx.hasUI && !warnedReplacementFailure.has(key)) {
        warnedReplacementFailure.add(key);
        ctx.ui.notify("pi-lazy-skills could not find Pi's skill prompt section; using the default skill prompt.", "warning");
      }
      return; // Fail open: keep Pi's normal skill prompt intact.
    }

    try {
      const selectedNames = await selectRelevantSkills(ctx, event.prompt, skills, advised, event.images);
      if (selectedNames === undefined) return; // Fail open: keep Pi's normal skill prompt for this turn.

      const freshNames = selectedNames.filter((name) => !advised.has(name));
      if (freshNames.length === 0) return { systemPrompt };

      const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
      const selectedSkills = freshNames.map((name) => skillByName.get(name)).filter((skill): skill is SkillInfo => !!skill);
      for (const skill of selectedSkills) advised.add(skill.name);

      return {
        systemPrompt,
        message: {
          customType: CUSTOM_TYPE,
          content: adviceContent(selectedSkills),
          display: true,
          details: {
            skillNames: selectedSkills.map((skill) => skill.name),
            selector: "pi-lazy-skills",
            at: Date.now(),
          },
        },
      };
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-lazy-skills selector failed; using default skill prompt: ${message}`, "warning");
      }
      return; // Fail open.
    }
  });
}

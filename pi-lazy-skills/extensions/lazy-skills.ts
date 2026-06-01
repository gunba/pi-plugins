import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "pi-lazy-skills-advice";
const DISABLE_ENV = "PI_LAZY_SKILLS";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const MAX_SKILLS_PER_TURN = 5;
const MAX_DESCRIPTION_CHARS = 600;
const SELECTOR_MAX_TOKENS = 256;

const LAZY_SKILLS_PROMPT_NOTE = `Agent Skills are available lazily. A separate pre-turn selector may add a custom message titled "Skills that may be related to the user request". When such a message appears and a listed skill matches the task, use the read tool to load that skill's file. Resolve relative references against the skill directory (parent of SKILL.md / dirname of the path). Explicit /skill:name invocation still works.`;

const SELECTOR_SYSTEM_PROMPT = `You are pi-lazy-skills' skill selector.

Given a user request and a list of Agent Skills, choose only skills that are likely to be useful for the main agent's next turn.

Rules:
- Return ONLY a JSON array of skill names, e.g. ["skill-a", "skill-b"].
- Use exact skill names from the provided list.
- Choose at most ${MAX_SKILLS_PER_TURN} skills.
- Prefer high precision. Return [] when no skill clearly helps.
- Do not include skills marked already advised or skills not in the list.
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

function selectorUserMessage(
  prompt: string,
  skills: SkillInfo[],
  alreadyAdvised: Set<string>,
  images: readonly ImageContent[] | undefined,
): Message {
  const skillLines = skills.map((skill) => {
    const advised = alreadyAdvised.has(skill.name) ? " already_advised=true" : "";
    return `- name: ${skill.name}${advised}\n  description: ${compactText(skill.description)}\n  location: ${skill.filePath}`;
  });

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `User request:\n${prompt.trim() || "(empty)"}${imageAttachmentMetadata(images)}\n\nAvailable skills:\n${skillLines.join("\n")}`,
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
      systemPrompt: SELECTOR_SYSTEM_PROMPT,
      messages: [selectorUserMessage(prompt, skills, alreadyAdvised, images)],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: SELECTOR_MAX_TOKENS,
      // Do not set timeoutMs here: Codex WebSocket treats it as a stream-idle timeout,
      // so short selector budgets can fail while the model is legitimately thinking.
      maxRetries: 0,
      sessionId: ctx.sessionManager.getSessionId?.(),
      cacheRetention: "none",
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

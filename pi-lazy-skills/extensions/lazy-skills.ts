import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
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

function replaceSkillsPromptSection(systemPrompt: string): string {
  const openTag = "<available_skills>";
  const closeTag = "</available_skills>";
  const open = systemPrompt.indexOf(openTag);
  if (open < 0) return systemPrompt;

  const close = systemPrompt.indexOf(closeTag, open);
  if (close < 0) return systemPrompt;

  const sectionMarker = "\n\nThe following skills provide specialized instructions for specific tasks.";
  const marker = systemPrompt.lastIndexOf(sectionMarker, open);
  const start = marker >= 0 ? marker : open;
  const end = close + closeTag.length;
  const before = systemPrompt.slice(0, start).replace(/[ \t]+$/g, "");
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

function selectorUserMessage(prompt: string, skills: SkillInfo[], alreadyAdvised: Set<string>): Message {
  const skillLines = skills.map((skill) => {
    const advised = alreadyAdvised.has(skill.name) ? " already_advised=true" : "";
    return `- name: ${skill.name}${advised}\n  description: ${compactText(skill.description)}\n  location: ${skill.filePath}`;
  });

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `User request:\n${prompt.trim() || "(empty)"}\n\nAvailable skills:\n${skillLines.join("\n")}`,
      },
    ],
    timestamp: Date.now(),
  };
}

function parseSelectorNames(text: string): string[] {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  const jsonText = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    if (parsed && typeof parsed === "object") {
      const maybe = (parsed as AnyRecord).skills ?? (parsed as AnyRecord).skillNames;
      if (Array.isArray(maybe)) return maybe.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Fall through to a conservative line parser for malformed but obvious output.
  }
  return stripped
    .split(/[\n,]/)
    .map((line) => line.replace(/^[-*\s"']+|["'\s]+$/g, ""))
    .filter(Boolean);
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
): Promise<string[] | undefined> {
  const model = ctx.model;
  if (!model || skills.length === 0) return [];

  const candidates = skills.filter((skill) => !alreadyAdvised.has(skill.name));
  if (candidates.length === 0) return [];

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const response = await completeSimple(
    model,
    {
      systemPrompt: SELECTOR_SYSTEM_PROMPT,
      messages: [selectorUserMessage(prompt, skills, alreadyAdvised)],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: SELECTOR_MAX_TOKENS,
      sessionId: ctx.sessionManager.getSessionId?.(),
      cacheRetention: "none",
      signal: ctx.signal,
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `skill selector ended with ${response.stopReason}`);
  }

  const byLower = new Map(candidates.map((skill) => [skill.name.toLowerCase(), skill.name]));
  const selected: string[] = [];
  for (const raw of parseSelectorNames(assistantText(response))) {
    const name = byLower.get(raw.toLowerCase()) ?? (byLower.has(raw) ? raw : undefined);
    if (!name || selected.includes(name)) continue;
    selected.push(name);
    if (selected.length >= MAX_SKILLS_PER_TURN) break;
  }
  return selected;
}

export default function lazySkills(pi: ExtensionAPI): void {
  if (isSubagentChild() || isDisabled(process.env[DISABLE_ENV])) return;

  const advisedBySession = new Map<string, Set<string>>();

  pi.on("session_start", async (_event, ctx) => {
    advisedBySession.set(sessionKey(ctx), latestAdvisedFromBranch(ctx));
  });

  pi.on("session_compact", async (_event, ctx) => {
    advisedBySession.set(sessionKey(ctx), new Set());
  });

  pi.on("context", async (event) => {
    // Keep advice visible to the model; no filtering needed. This hook exists so
    // future changes cannot accidentally hide the conversation-backed tracking.
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = extractSkills(event.systemPromptOptions);
    if (skills.length === 0) return;

    let advised = advisedBySession.get(sessionKey(ctx));
    if (!advised) {
      advised = latestAdvisedFromBranch(ctx);
      advisedBySession.set(sessionKey(ctx), advised);
    }

    try {
      const selectedNames = await selectRelevantSkills(ctx, event.prompt, skills, advised);
      if (selectedNames === undefined) return; // Fail open: keep Pi's normal skill prompt for this turn.

      const systemPrompt = replaceSkillsPromptSection(event.systemPrompt);
      const freshNames = selectedNames.filter((name) => !advised!.has(name));
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

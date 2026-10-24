import { object, type JsonObject } from "./diagnostics.ts";

/** Keep the native introduction, not the rest of Codex's harness-specific policy. */
export function nativeCodexIntro(model: JsonObject): string {
  const messages = object(model.model_messages);
  for (const source of [messages.instructions_template, model.base_instructions]) {
    if (typeof source !== "string") continue;
    const intro = source.trim().split(/\r?\n\s*\r?\n/, 1)[0];
    if (/^You are Codex\b/.test(intro) && intro.length <= 2_000 && !intro.includes("{{")) return intro;
  }
  return "You are Codex.";
}

export function prependCodexIntro(instructions: unknown, metadata: JsonObject): string {
  if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
    throw new TypeError("instructions must be a string");
  }
  const intro = typeof metadata.codex_intro === "string" ? metadata.codex_intro : "You are Codex.";
  const text = instructions ?? "";
  if (text === intro || text.startsWith(`${intro}\n`)) return text;
  return text ? `${intro}\n\n${text}` : intro;
}

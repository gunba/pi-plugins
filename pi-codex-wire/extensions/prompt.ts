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

/** Fold Pi's leading inline prompt into Wire's base-instructions prefix. Mutates a caller-owned body;
 * shapeModelBody moves these instructions into input, so they never become a top-level wire field. */
export function prependCodexInstructions(body: JsonObject, metadata: JsonObject): void {
  let instructions = body.instructions;
  if (instructions == null && Array.isArray(body.input)) {
    let index = 0;
    while (object(body.input[index]).type === "additional_tools") index++;
    const initial = object(body.input[index]);
    if (initial.type === undefined && initial.id === undefined &&
      (initial.role === "developer" || initial.role === "system") && typeof initial.content === "string") {
      instructions = initial.content;
      body.input.splice(index, 1);
    }
  }
  body.instructions = prependCodexIntro(instructions, metadata);
}

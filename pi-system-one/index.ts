import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type, type ClassifierAnswer, type JsonObject, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL = "typesafe/jev-latest";
const PARALLEL = 8;

const question = Type.Union([
  Type.Object({ type: Type.Literal("choice"), instructions: Type.String(), criteria: Type.Record(Type.String(), Type.String(), { description: "Each option and what it means." }) }),
  Type.Object({ type: Type.Literal("bool"), instructions: Type.String(), criteria: Type.Object({ true: Type.String(), false: Type.String() }) }),
  Type.Object({ type: Type.Literal("score"), instructions: Type.String(), criteria: Type.Array(Type.String(), { minItems: 2, maxItems: 10, description: "Levels, lowest first." }) }),
]);

const parameters = Type.Object({
  questions: Type.Record(Type.String(), question, { description: "Questions by ID. Each item is asked all of them in one call." }),
  items: Type.Optional(Type.Array(Type.Unknown(), { description: "Items to judge. Objects are sent as they are; other values as { value }." })),
  input: Type.Optional(Type.String({ description: "JSONL file with one item per line, instead of items." })),
  output: Type.Optional(Type.String({ description: "JSONL file for results with input: one { item, answers } or { item, error } per line, in input order." })),
  model: Type.Optional(Type.String({ description: `Classifier as provider/id. Default ${DEFAULT_MODEL}.` })),
}, { additionalProperties: false });

type Outcome = { answers: Record<string, ClassifierAnswer> } | { error: string };

function summarize(outcomes: Outcome[]) {
  const totals: Record<string, { counts?: Record<string, number>; yes?: number; sum: number; n: number }> = {};
  for (const outcome of outcomes) {
    if (!("answers" in outcome)) continue;
    for (const [id, answer] of Object.entries(outcome.answers)) {
      const total = totals[id] ??= { sum: 0, n: 0 };
      total.n++;
      if (answer.type === "choice") (total.counts ??= {})[answer.choice] = (total.counts[answer.choice] ?? 0) + 1;
      else if (answer.type === "bool") { total.sum += answer.probability; total.yes = (total.yes ?? 0) + (answer.probability >= 0.5 ? 1 : 0); }
      else total.sum += answer.score;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([id, { counts, yes, sum, n }]) => [id,
    counts ? { counts } : yes !== undefined ? { yesAtHalf: yes, meanProbability: Number((sum / n).toFixed(4)) } : { meanScore: Number((sum / n).toFixed(4)) }]));
}

export default function systemOne(pi: ExtensionAPI) {
  pi.registerTool({
    name: "classify", label: "System One", exposure: "codemode",
    description: "Ask a System One classifier model the same typed questions about many items and get probabilities back: choice (pick one option), bool (yes or no) or score (a level on a scale). It generates no text, so thousands of items cost cents and take minutes. Use it when a task needs one judgement repeated over many items, such as flagging complaints in conversations, checking which sessions met a skill's goal, filtering or routing records, or counting how often something happens. Don't use it to write, explain or rewrite, for a few items you can judge yourself, or to sort items into many fine-grained categories, where it is unreliable. Describe what every option means. Before trusting a cutoff, compare the probabilities with a few dozen items you judged yourself; the best cutoff is often not 0.5. Items are sent to the model's provider, so leave out credentials. Pass items directly, or an input JSONL file and an output file for large runs. Single items with images: models.classify.",
    parameters,
    outputSchema: Type.Record(Type.String(), Type.Unknown()),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!params.items === !params.input) throw new Error("Give either items or input.");
      if (params.input && !params.output) throw new Error("Give an output file with input.");
      const name = params.model ?? DEFAULT_MODEL, slash = name.indexOf("/");
      const model = ctx.modelRegistry.getModelOfType("classifier", name.slice(0, slash), name.slice(slash + 1));
      if (!model) throw new Error(`Unknown classifier ${name}.`);
      const available = await ctx.modelRegistry.getAvailableOfType("classifier");
      if (!available.some(m => m.provider === model.provider && m.id === model.id))
        throw new Error(`${name} has no credentials (/login ${model.provider}). Classifiers with credentials: ${available.map(m => `${m.provider}/${m.id}`).join(", ") || "none"}.`);

      const items: unknown[] = params.items ?? (await readFile(resolve(ctx.cwd, params.input!), "utf8"))
        .split("\n").filter(line => line.trim()).map((line, index) => {
          try { return JSON.parse(line); } catch { throw new Error(`Line ${index + 1} of ${params.input} is not JSON.`); }
        });
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const outcomes: Outcome[] = new Array(items.length);
      let next = 0, done = 0, reported = Date.now();
      await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
        while (next < items.length) {
          const index = next++, item = items[index];
          const state = (item && typeof item === "object" && !Array.isArray(item) ? item : { value: item }) as JsonObject;
          const result = await ctx.modelRegistry.classify(model, { state, questions: params.questions }, { signal });
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += result.usage?.[key] ?? 0;
          usage.cost.total += result.usage?.cost.total ?? 0;
          outcomes[index] = result.stopReason === "stop" ? { answers: result.answers } : { error: result.errorMessage ?? result.stopReason };
          done++;
          if (Date.now() - reported > 1000) {
            reported = Date.now();
            onUpdate?.({ content: [{ type: "text", text: `Classified ${done} of ${items.length}` }], details: undefined });
          }
        }
      }));

      const errors = outcomes.filter(outcome => "error" in outcome) as { error: string }[];
      const report = {
        model: `${model.provider}/${model.id}`, items: items.length, errors: errors.length,
        ...(errors.length ? { firstError: errors[0].error } : {}),
        summary: summarize(outcomes), cost: Number(usage.cost.total.toFixed(6)),
      };
      let structured: Record<string, unknown>;
      if (params.input) {
        const output = resolve(ctx.cwd, params.output!);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, outcomes.map((outcome, index) => JSON.stringify({ item: items[index], ...outcome })).join("\n") + "\n");
        structured = { ...report, output };
      } else structured = { ...report, results: outcomes };
      return {
        content: [{ type: "text", text: JSON.stringify(structured) }], details: report, structuredContent: structured as JsonObject, usage,
        ...(errors.length === items.length && items.length ? { isError: true } : {}),
      };
    },
  });
}

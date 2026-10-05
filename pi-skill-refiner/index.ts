import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSkill, resolveSkill, retrieve, type SkillSource } from "./sources.ts";
import { refine, type ClusterResult } from "./refine.ts";

const directory = dirname(fileURLToPath(import.meta.url));

export function clustering(input: unknown, signal?: AbortSignal, pythonPath?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath || process.env.PI_SKILL_REFINER_PYTHON || (process.platform === "win32" ? "python" : "python3"), [join(directory, "cluster.py")], {
      stdio: ["pipe", "pipe", "pipe"], signal, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) { child.kill(); reject(new Error("Clustering output exceeded 32 MiB")); }
      else output.push(data);
    });
    child.stderr.on("data", (data: Buffer) => { if (errors.reduce((sum, chunk) => sum + chunk.length, 0) < 64 * 1024) errors.push(data); });
    child.on("error", reject);
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
    child.on("close", code => {
      if (code !== 0) reject(new Error(`Embedding/clustering unavailable: ${Buffer.concat(errors).toString().trim() || `exit ${code}`}. See pi-skill-refiner/README.md.`));
      else { try { resolve(JSON.parse(Buffer.concat(output).toString())); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const parameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4000, description: "Natural-language request naming the skill and the behavior to improve." }),
  mode: Type.Optional(Type.Union([Type.Literal("refine"), Type.Literal("preview"), Type.Literal("preflight")], { description: "Default refine. Preview retrieves locally without model calls. Preflight checks dependencies without reading histories." })),
  pythonPath: Type.Optional(Type.String({ description: "Python interpreter file for this run, such as the private environment prepared by the skill. Overrides PI_SKILL_REFINER_PYTHON and PATH without changing the Pi process environment." })),
  skillPath: Type.Optional(Type.String({ description: "Target SKILL.md, including one in a private skills repository. Otherwise resolve from loaded skills." })),
  sessionRoot: Type.Optional(Type.String({ description: "Saved-session directory. Defaults to this workspace's native session directory; no individual file selection required." })),
  allWorkspaces: Type.Optional(Type.Boolean({ description: "Explicitly widen retrieval to every workspace under sessionRoot (default native sessions root)." })),
  runRoot: Type.Optional(Type.String({ description: "Private working-data directory outside Git. Defaults to ~/.pi/agent/skill-refiner-runs." })),
  maxTraces: Type.Optional(Type.Integer({ minimum: 2, maximum: 120, default: 40 })),
  maxCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 120 })),
  maxSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 7200, default: 1200 })),
  maxPromptChars: Type.Optional(Type.Integer({ minimum: 20000, maximum: 300000, default: 100000 })),
});

export default function skillRefiner(pi: ExtensionAPI) {
  let skills: SkillSource[] = [];
  pi.on("before_agent_start", event => { skills = event.systemPromptOptions.skills ?? []; });
  pi.registerCommand("skill-refine", {
    description: "Improve a skill from relevant saved Pi sessions; propose a revision for review",
    handler: async (query, ctx) => {
      if (!query.trim()) { ctx.ui.notify("Usage: /skill-refine improve <skill> at <behavior>", "info"); return; }
      skills = ctx.getSystemPromptOptions().skills ?? [];
      pi.sendUserMessage(`Read the skill-refine instructions at ${JSON.stringify(join(directory, "skills", "skill-refine", "SKILL.md"))}, prepare the local runtime as needed, then use the skill_refine tool for this improvement request. Resolve the target and retrieve relevant saved sessions automatically within the current workspace. Produce a candidate for review, not an installed change. Request: ${JSON.stringify(query)}`);
    },
  });
  pi.registerTool({
    name: "skill_refine", label: "Skill Refiner", exposure: "codemode",
    description: "Refine an existing skill from relevant saved Pi sessions after an explicit improvement request. Resolves the target from loaded skills, retrieves bounded local branch evidence, extracts observed outcomes, and runs SkillRefiner's summary/embedding/clustering/proposal/evidence-gate/merge pipeline. Uses the current Pi model and thinking. Uses DeepInfra Qwen3 embeddings via DEEPINFRA_API_KEY and pinned local Python clustering dependencies; summaries are sent to DeepInfra. Writes only private review artifacts, never installs or edits skills. No session data is read on extension load.",
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const mode = params.mode ?? "refine";
      const pythonPath = params.pythonPath ? resolve(ctx.cwd, params.pythonPath) : undefined;
      const model = ctx.model;
      if (mode !== "preview" && !model) throw new Error("Select a Pi chat model first");
      if (mode !== "preview") {
        const checked = await clustering({ preflight: true }, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]), pythonPath);
        if (mode === "preflight") return { content: [{ type: "text", text: JSON.stringify({ ready: true, clustering: checked, model: model!.id }) }], details: checked };
      }
      const selected = params.skillPath ? undefined : resolveSkill(params.query, skills);
      const source = await readSkill(params.skillPath ? resolve(ctx.cwd, params.skillPath) : selected!.filePath);
      const retrieval = await retrieve({
        root: params.sessionRoot ? resolve(ctx.cwd, params.sessionRoot) : (params.allWorkspaces ? join(getAgentDir(), "sessions") : ctx.sessionManager.getSessionDir()),
        cwd: params.allWorkspaces ? undefined : ctx.cwd,
        query: params.query, skill: selected ?? source.source, limit: params.maxTraces ?? 40,
        excludePath: ctx.sessionManager.getSessionFile(), signal,
      });
      if (mode === "preview") {
        const preview = { skill: source.source, sourceHash: source.sha256, scanned: retrieval.scanned, bytes: retrieval.bytes,
          traces: retrieval.traces.map(({ entries, ...trace }) => ({ ...trace, entryCount: entries.length })), skipped: retrieval.skipped };
        return { content: [{ type: "text", text: JSON.stringify(preview, null, 2) }], details: preview };
      }
      if (!retrieval.traces.length) return { content: [{ type: "text", text: "No relevant saved evidence in this scope. No refinement calls made. Use preview to inspect retrieval or specify a broader sessionRoot/allWorkspaces scope." }], details: { scanned: retrieval.scanned, skipped: retrieval.skipped } };
      const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const result = await refine({
        query: params.query, sourcePath: source.source.filePath, sourceText: source.content, retrieval,
        runRoot: params.runRoot ? resolve(ctx.cwd, params.runRoot) : process.env.PI_SKILL_REFINER_RUNS ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "skill-refiner-runs"),
        model: { provider: model!.provider, id: model!.id, thinking }, maxCalls: params.maxCalls ?? 120,
        maxSeconds: params.maxSeconds ?? 1200, maxPromptChars: params.maxPromptChars ?? 100000, signal,
        progress: stage => onUpdate?.({ content: [{ type: "text", text: `Skill Refiner: ${stage}` }], details: { stage } }),
        complete: async (system, data, operationSignal) => {
          const response = await ctx.modelRegistry.streamSimple(model!, { messages: [
            { role: "system", content: system, timestamp: Date.now() },
            { role: "user", content: JSON.stringify(data), timestamp: Date.now() },
          ] }, { reasoning: thinking === "off" ? undefined : thinking, maxTokens: 8192, maxRetries: 0, cacheRetention: "none", signal: AbortSignal.any([operationSignal, AbortSignal.timeout(180_000)]) }).result();
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += response.usage[key];
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += response.usage.cost[key];
          return { text: response.content.filter(block => block.type === "text").map(block => block.text).join("\n"), usage: response.usage, model: `${response.provider}/${response.model}`,
            ...(response.stopReason !== "stop" ? { error: `Refinement model stopped: ${response.stopReason}: ${response.errorMessage ?? ""}` } : {}) };
        },
        cluster: async (summaries, _runDir, operationSignal) => await clustering({ summaries }, operationSignal, pythonPath) as ClusterResult,
      });
      const failure = result.status === "failed" || result.status === "cancelled";
      return { content: [{ type: "text", text: `${result.status}: ${result.runDir}\n${result.calls} model calls; ${result.accepted} accepted cluster proposals. Read result.json and any candidate.diff before review. No skill was installed; task improvement has not been measured.` }], details: result, usage, ...(failure ? { isError: true } : {}) };
    },
  });
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Standalone scripts do not inherit Pi's extension module mapping.
const importPackage = (name) => import(process.env.PI_GEPA_MODULE_ROOT
  ? pathToFileURL(join(resolve(process.env.PI_GEPA_MODULE_ROOT), "node_modules", name, "dist", "index.js")).href
  : name);
const { ModelRuntime, readStoredCredential } = await importPackage("@earendil-works/pi-coding-agent");
const { InMemoryModelsStore } = await importPackage("@earendil-works/pi-ai");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const authPath = join(agentDir, "auth.json");

// Read current native credentials; never refresh, persist, log in or log out.
// A running Pi may refresh its own token; subsequent reads see that update.
const credentials = {
  async read(providerId) { return readStoredCredential(providerId, authPath); },
  async list() {
    let data;
    try { data = JSON.parse(await readFile(authPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  },
  async modify() { throw new Error("Native credentials need refreshing. Resume an authenticated Pi session before retrying."); },
  async delete() { throw new Error("Credential changes are not supported."); },
};
const runtime = await ModelRuntime.create({
  credentials,
  modelsStore: new InMemoryModelsStore(),
  refreshOnCreate: false,
  allowModelNetwork: false,
});

function contextFor(prompt, model) {
  const source = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  if (!Array.isArray(source) || source.length === 0) throw new Error("Prompt must be text or a nonempty text-message array.");
  const system = [];
  const messages = source.map((message) => {
    if (typeof message.content !== "string") throw new Error("Only text messages are supported by this bridge.");
    if (message.role === "system") { system.push(message.content); return null; }
    if (message.role === "user") return { role: "user", content: message.content, timestamp: Date.now() };
    if (message.role === "assistant") return {
      role: "assistant", content: [{ type: "text", text: message.content }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    throw new Error(`Unsupported message role: ${message.role}`);
  }).filter(Boolean);
  if (!messages.length) throw new Error("A prompt needs at least one conversation message.");
  return { systemPrompt: system.join("\n\n"), messages };
}

async function handle(request) {
  if (request.op === "list") return (await runtime.getAvailable()).map((model) => ({
    provider: model.provider, model: model.id,
  }));
  const selected = request.model;
  if (!selected?.provider || !selected?.id) throw new Error("Specify model.provider and model.id; no automatic provider fallback is used.");
  const model = runtime.getModel(selected.provider, selected.id);
  if (!model) throw new Error(`Unknown native model: ${selected.provider}/${selected.id}. Extension-only providers are not loaded.`);
  const credential = await credentials.read(model.provider);
  if (credential?.type === "oauth" && Date.now() + 300_000 >= credential.expires) {
    throw new Error(`Native ${model.provider} credentials need refreshing in Pi before this run.`);
  }
  if (!await runtime.checkAuth(model.provider)) throw new Error(`No usable native authentication for ${model.provider}.`);
  if (request.op === "check") return {
    provider: model.provider, model: model.id, authentication: credential?.type ?? "ambient/config",
    reasoning: model.reasoning, maxTokens: model.maxTokens,
  };
  if (request.op !== "complete") throw new Error(`Unknown operation: ${request.op}`);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");
  if (!Number.isSafeInteger(selected.maxTokens) || selected.maxTokens <= 0) throw new Error("model.maxTokens must be a positive integer.");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(selected.thinking)) throw new Error("Specify model.thinking explicitly.");
  const started = Date.now();
  const response = await runtime.completeSimple(model, contextFor(request.prompt, model), {
    reasoning: selected.thinking,
    maxTokens: selected.maxTokens,
    signal: AbortSignal.timeout(request.timeoutMs),
    timeoutMs: request.timeoutMs,
    maxRetries: 0,
    transport: "sse",
  });
  if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Model stopped with ${response.stopReason}.`);
  if (response.content.some((part) => part.type === "toolCall")) throw new Error("A text-only evaluation returned a tool call.");
  const output = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (!output.trim()) throw new Error("Model returned no completion text.");
  return {
    text: output, usage: response.usage, provider: response.provider, model: response.model,
    responseModel: response.responseModel, providerThinkingLevel: response.providerThinkingLevel,
    requestedThinking: selected.thinking, elapsedMs: Date.now() - started,
    authentication: credential?.type ?? "ambient/config",
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
for await (const line of lines) {
  const task = (async () => {
    let request;
    try {
      request = JSON.parse(line);
      const result = await handle(request);
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request?.id, error: error.message }) + "\n");
    }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
}
await Promise.allSettled(pending);

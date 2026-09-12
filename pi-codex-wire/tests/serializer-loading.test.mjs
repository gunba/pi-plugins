import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi reload upgrades a cached native serializer and preserves compaction retry errors", async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-wire-serializer-reload-"));
	const priorFetch = globalThis.fetch;
	globalThis.fetch = async () => assert.fail("loader fixture must not make network requests");
	t.after(() => {
		globalThis.fetch = priorFetch;
		assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "pi-wire-serializer-reload-")));
		rmSync(directory, { recursive: true, force: true });
	});
	const extensions = new URL("../extensions/", import.meta.url);
	symlinkSync(fileURLToPath(new URL("../../node_modules/", extensions)), join(directory, "node_modules"), "junction");
	writeFileSync(join(directory, "package.json"), '{"type":"module"}');
	// The pre-0.20 bridge stays in Node's native cache even after Pi reloads TS.
	const bridge = join(directory, "serializer.mjs");
	writeFileSync(bridge, `export { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
export { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";`);
	writeFileSync(join(directory, "serializer.ts"), `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const { convertResponsesMessages, createGrammarToolInputProperties } = require("./serializer.mjs");`);
	const entry = join(directory, "probe.ts");
	writeFileSync(entry, `import * as serializer from "./serializer.ts";
export default function(pi) { pi.registerCommand("probe", { description: "Fixture", handler: async () =>
Object.fromEntries(Object.entries(serializer).map(([name, value]) => [name, typeof value])) }); }`);
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	const run = async () => {
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		return result.extensions[0].commands.get("probe").handler("", {});
	};
	assert.deepEqual(await run(), { convertResponsesMessages: "function", createGrammarToolInputProperties: "function" });
	const require = createRequire(import.meta.url);
	const cached = require(bridge);
	// Replace only temporary extension files, as a package update would.
	for (const name of ["serializer.ts", "native-import.mjs", "compact-input.ts"]) {
		copyFileSync(new URL(name, extensions), join(directory, name));
	}
	rmSync(bridge);
	const retryPath = fileURLToPath(new URL("native-compaction.ts", extensions)).replaceAll("\\", "/");
	writeFileSync(entry, `import assert from "node:assert/strict";
import * as serializer from "./serializer.ts";
import { compactInput } from "./compact-input.ts";
import { retryCompaction } from ${JSON.stringify(retryPath)};
export default function(pi) { pi.registerCommand("probe", { description: "Fixture", handler: async () => {
const model = { id: "gpt-6-astra", api: "openai-codex-responses", provider: "openai-codex", reasoning: true,
  input: ["text"], contextWindow: 272000, maxTokens: 128000, thinkingLevelMap: { xhigh: "xhigh" } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const body = compactInput(model, { systemPrompt: "Fixture instructions", tools: [{ name: "lookup", description: "Fixture", parameters: { type: "object", properties: {} } }],
  messages: [{ role: "user", content: "Fixture request", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_fixture", name: "lookup", arguments: {} }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "Fixture result" }], isError: false, timestamp: 3 }] }, "xhigh");
assert.equal(body.tools[0].name, "lookup");
assert.equal(body.input.find(item => item.type === "function_call").call_id, body.input.find(item => item.type === "function_call_output").call_id);
assert.equal(body.reasoning.effort, "xhigh");
let attempts = 0, retries = 0;
const settings = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
const result = await retryCompaction(async () => { if (++attempts === 1) throw new Error("503"); return "OK"; }, settings, new AbortController().signal, () => retries++);
assert.equal(result, "OK"); assert.equal(attempts, 2); assert.equal(retries, 1);
const original = new Error("invalid compaction response");
await assert.rejects(retryCompaction(async () => { throw original; }, settings, new AbortController().signal,
  () => assert.fail("nonretryable failure must not retry")), error => error === original);
const controller = new AbortController(), cancelled = new Error("Fixture cancellation");
await assert.rejects(retryCompaction(async () => { controller.abort(cancelled); throw new Error("503"); }, settings, controller.signal,
  () => assert.fail("cancellation must not retry")), error => error === cancelled);
return { types: Object.fromEntries(Object.entries(serializer).map(([name, value]) => [name, typeof value])), result };
} }); }`);
	for (let reload = 0; reload < 2; reload++) {
		const result = await run();
		assert.deepEqual(result, { types: { convertResponsesMessages: "function", convertResponsesTools: "function",
			createGrammarToolInputProperties: "function", splitDeferredTools: "function" }, result: "OK" });
		assert.equal(cached.convertResponsesTools, undefined, "the old cached module was not modified or patched");
	}
});

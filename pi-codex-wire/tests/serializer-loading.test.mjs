import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("native serializers use the host SDK when extension peers are absent", t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-wire-host-sdk-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const source = join(directory, "source"), host = join(directory, "host");
	const sdk = join(host, "node_modules", "@earendil-works", "pi-coding-agent");
	const ai = join(sdk, "node_modules", "@earendil-works", "pi-ai");
	mkdirSync(join(source, "node_modules"), { recursive: true });
	mkdirSync(join(sdk, "node_modules", "@earendil-works"), { recursive: true });
	writeFileSync(join(source, "package.json"), '{"type":"module"}');
	writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./index.js" } } }));
	writeFileSync(join(sdk, "index.js"), "export {};\n");
	symlinkSync(resolve("node_modules/jiti"), join(source, "node_modules", "jiti"), "junction");
	symlinkSync(resolve(findPackageJSON("@earendil-works/pi-ai", import.meta.url), ".."), ai, "junction");
	for (const name of ["serializer.ts", "native-import.mjs"]) copyFileSync(new URL(`../extensions/${name}`, import.meta.url), join(source, name));
	assert.equal(existsSync(join(source, "node_modules", "@earendil-works")), false);
	const entry = join(host, "probe.mjs");
	writeFileSync(entry, `import assert from "node:assert/strict";
import * as serializer from "../source/serializer.ts";
for (const value of Object.values(serializer)) assert.equal(typeof value, "function");
console.log("host serializers loaded");`);
	const launcher = join(directory, "launcher.mjs");
	symlinkSync(entry, launcher, "file");
	for (const executable of [entry, launcher]) {
		const result = spawnSync(process.execPath, [executable], { encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /host serializers loaded/);
	}
});

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
			createGrammarToolInputProperties: "function", normalizeContext: "function", getCurrentSystemPrompt: "function",
			getDeclaredTools: "function", resolveTranscriptTools: "function", responseReplay: "function" }, result: "OK" });
		assert.equal(cached.convertResponsesTools, undefined, "the old cached module was not modified or patched");
	}
});

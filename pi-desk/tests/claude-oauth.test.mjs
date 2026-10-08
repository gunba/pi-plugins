import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AccountBinding, accountSelection } from "../src/host/account-binding.ts";
import { inheritProviderRuntime } from "../../pi-subagents/extensions/subagents.ts";
import { bindChildProvider } from "../../pi-subagents/extensions/pi-sdk-driver.ts";
import nativeCompaction from "../../pi-codex-wire/extensions/native-compaction.ts";

function response(toolName, model) {
	const events = [{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model,
		content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }];
	if (toolName) events.push(
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: toolName, input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":"fixture"}' } });
	else events.push(
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Completed fixture work." } });
	events.push({ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: toolName ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
		{ type: "message_stop" });
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } });
}

test("packaged Claude OAuth shaping survives tool turns, child account inheritance and native compaction", async () => {
	const root = mkdtempSync(join(tmpdir(), "desk-claude-oauth-")), profiles = join(root, "profiles");
	const ids = [randomUUID(), randomUUID()], requests = [], sessions = [];
	const oldFetch = globalThis.fetch, oldDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let toolExecutions = 0;
	globalThis.fetch = async (url, init) => {
		assert.equal(new URL(String(url)).origin, "https://api.anthropic.com");
		assert.equal(new URL(String(url)).pathname, "/v1/messages");
		const body = JSON.parse(init.body), headers = new Headers(init.headers);
		requests.push({ body, headers });
		return response(requests.length === 1 ? body.tools.find(tool => tool.name === "Read")?.name : undefined, body.model);
	};
	try {
		writeFileSync(join(root, "auth.json"), "{}\n");
		for (const id of ids) {
			mkdirSync(join(profiles, id), { recursive: true });
			writeFileSync(join(profiles, id, "account.json"), JSON.stringify({ id, provider: "anthropic", name: "Fixture" }));
			writeFileSync(join(profiles, id, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: `sk-ant-oat01-fixture-${id}`,
				refresh: "fixture", expires: Date.now() + 3600000 } }));
		}
		const settings = SettingsManager.inMemory({ packages: [fileURLToPath(new URL("../..", import.meta.url))],
			cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 10 }, retry: { enabled: false } });
		const resources = await new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager: settings }).resolve(() => "error");
		const extension = resources.extensions.find(item => item.path.replaceAll("\\", "/").endsWith("/@gotgenes/pi-anthropic-auth/src/index.ts"));
		assert.ok(extension?.enabled, "the published package manifest must expose the maintained plugin");
		const binding = new AccountBinding(root, profiles, { anthropic: ids[0] }), runtime = await binding.runtime();
		const model = runtime.getModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model);
		const parentManager = SessionManager.create(root, join(root, "sessions"));
		async function open(modelRuntime, manager) {
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
				additionalExtensionPaths: manager === parentManager ? [extension.path] : [], noSkills: true, noPromptTemplates: true,
				noThemes: true, noContextFiles: true, extensionFactories: [{ name: "native-compaction", factory: nativeCompaction }] });
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime,
				model: modelRuntime.getModel(model.provider, model.id), sessionManager: manager, settingsManager: settings,
				resourceLoader: loader, thinkingLevel: "off", tools: ["read"], customTools: [{ name: "read", label: "Fixture",
					description: "Synthetic fixture", parameters: Type.Object({ value: Type.String() }), execute: async (_id, args) => {
						assert.equal(args.value, "fixture"); toolExecutions++;
						return { content: [{ type: "text", text: "Fixture tool result" }] };
					} }] });
			sessions.push(session);
			await session.bindExtensions({ mode: "print", onError: error => { throw Error(error.error); } });
			return session;
		}
		const parent = await open(runtime, parentManager);
		await parent.prompt("Run read once, then report completion.");
		assert.equal(parent.messages.at(-1).stopReason, "stop");
		assert.equal(toolExecutions, 1);
		assert.equal(requests.length, 2);
		const [first, second] = requests;
		assert.equal(first.headers.get("x-app"), "cli");
		assert.match(first.headers.get("user-agent"), /^claude-cli\//);
		assert.match(first.headers.get("anthropic-beta"), /oauth-2025-04-20/);
		assert.match(first.headers.get("anthropic-beta"), /claude-code-20250219/);
		assert.match(first.body.system[0].text, /^x-anthropic-billing-header:/);
		assert.ok(!JSON.stringify(first.body.system).includes("operating inside pi, a coding agent harness"));
		assert.ok(first.body.tools.some(tool => tool.name === "Read"));
		assert.deepEqual(first.body.tools, second.body.tools);
		assert.deepEqual(first.body.system, second.body.system);
		assert.ok(first.body.tools.at(-1).cache_control);
		assert.ok(first.body.system.some(block => block.cache_control));
		assert.ok(first.body.messages.at(-1).content.at(-1).cache_control);
		assert.ok(second.body.messages.at(-1).content.at(-1).cache_control);
		const stripCache = value => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
		assert.deepEqual(stripCache(second.body.messages.slice(0, first.body.messages.length)), stripCache(first.body.messages));
		assert.equal(first.headers.get("originator"), null);
		assert.ok(second.body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result")));

		const childManager = SessionManager.create(root, join(root, "sessions"));
		const child = await binding.capability().create(childManager, new AbortController().signal);
		await inheritProviderRuntime(parent.extensionRunner.createContext(), { provider: model.provider, id: model.id },
			child.runtime, undefined, new AbortController().signal, true);
		child.runtime.registerNativeProvider(bindChildProvider(child.runtime.getRegisteredNativeProvider("anthropic"), childManager.getSessionId()));
		binding.select({ anthropic: ids[1] });
		const childSession = await open(child.runtime, childManager);
		await childSession.prompt("Report fixture status.");
		assert.equal(requests.at(-1).headers.get("authorization"), `Bearer sk-ant-oat01-fixture-${ids[0]}`);
		assert.deepEqual(accountSelection(childManager), { anthropic: ids[0] });
		const resumed = await binding.capability().create(childManager, new AbortController().signal);
		assert.equal((await resumed.runtime.getAuth("anthropic")).auth.apiKey, `sk-ant-oat01-fixture-${ids[0]}`);
		const fresh = await binding.capability().create(SessionManager.inMemory(root), new AbortController().signal);
		assert.equal((await fresh.runtime.getAuth("anthropic")).auth.apiKey, `sk-ant-oat01-fixture-${ids[1]}`);

		const before = readFileSync(parentManager.getSessionFile());
		await parent.prompt("Additional fixture context. " + "x".repeat(500));
		const compact = await parent.compact();
		assert.equal(compact.summary, "Completed fixture work.");
		assert.equal(parent.model.provider, "anthropic");
		assert.ok(readFileSync(parentManager.getSessionFile()).subarray(0, before.length).equals(before));
		assert.equal(readFileSync(join(root, "auth.json"), "utf8"), "{}\n");
		assert.equal(requests.length, 5);
		assert.ok(requests.every(request => request.body.system.filter(block => block.text.startsWith("x-anthropic-billing-header:")).length === 1),
			"root, child without its own plugin load, and compaction each need one OAuth compatibility block");
	} finally {
		for (const session of sessions) {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		globalThis.fetch = oldFetch;
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		rmSync(root, { recursive: true, force: true });
	}
});

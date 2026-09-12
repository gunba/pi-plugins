import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";
import wire from "../extensions/index.ts";
import { identity } from "./fixtures.mjs";
import { CHECKPOINT, CHECKPOINT_CAPTION, checkpointBinding, checkpointMessages, projectCheckpoints, replayCheckpoints, assertCheckpointContext } from "../extensions/checkpoint.ts";
import { compactInput } from "../extensions/compact-input.ts";
import nativeCompaction, { retryCompaction } from "../extensions/native-compaction.ts";
import { copyCompletedParentTurns } from "../../pi-subagents/extensions/subagent-runtime.ts";
import { bindChildProvider } from "../../pi-subagents/extensions/pi-sdk-driver.ts";
import sessionMemory from "../../pi-session-memory/extensions/session-memory.ts";

const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.x`;
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const modelData = { id: "gpt-6-astra", name: "Fixture", api: "openai-codex-responses", reasoning: true,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	input: ["text"], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const output = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retained native request" }] },
	{ type: "compaction", id: "cmp_fixture", encrypted_content: "fixture-opaque-checkpoint", internal_chat_message_metadata_passthrough: { fixture: true } }];
const user = content => ({ role: "user", content, timestamp: 1 });
const assistant = content => ({ role: "assistant", content: [{ type: "text", text: content }], usage,
	api: modelData.api, provider: "openai-codex", model: modelData.id, stopReason: "stop", timestamp: 2 });

function compactStream(items = [output[1]], usage) {
	const events = items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item }));
	events.push({ type: "response.completed", response: { id: "resp_compaction", status: "completed", output: [], ...(usage ? { usage } : {}) } });
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function harness(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-compact-"));
	const priorEnv = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = directory; process.env.PI_OFFLINE = "1";
	const priorFetch = globalThis.fetch;
	const calls = [];
	let compactResponse = () => compactStream();
	globalThis.fetch = async (url, init) => {
		assert.ok(String(url).startsWith("https://chatgpt.com/backend-api/codex/"), "unexpected request");
		if (String(url).includes("/models?")) return Response.json({ models: [{ slug: modelData.id, use_responses_lite: true,
			support_verbosity: true, default_verbosity: "low", default_reasoning_summary: "none" }] });
		const call = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers), signal: init.signal };
		calls.push(call);
		if (call.body.input.at(-1)?.type === "compaction_trigger") return compactResponse(call);
		assert.ok(call.url.endsWith("/responses"));
		const item = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Fixture response.", annotations: [] }] };
		return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 40000, keepRecentTokens: 300 },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, httpIdleTimeoutMs: 900000 }));
	const settings = SettingsManager.create(directory, directory, { projectTrusted: false });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("openai-codex", { name: "Fixture", apiKey: jwt, baseUrl: "https://chatgpt.com/backend-api", api: modelData.api,
		streamSimple, models: [modelData] });
	const model = runtime.getModel("openai-codex", modelData.id);
	assert.ok(model);
	const manager = SessionManager.create(directory, directory);
	for (let i = 0; i < 6; i++) {
		manager.appendMessage(user(`request ${i} ` + "u".repeat(1800)));
		if (i === 2) {
			manager.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "call_fixture", name: "fixture_lookup", arguments: { value: "paired fixture" } }], stopReason: "toolUse" });
			manager.appendMessage({ role: "toolResult", toolCallId: "call_fixture", toolName: "fixture_lookup", content: [{ type: "text", text: "paired result" }], isError: false, timestamp: 2 });
		}
		manager.appendMessage(assistant(`answer ${i} ` + "a".repeat(1800)));
	}
	const flags = new Map([["codex-wire-client", "cli"], ["codex-wire-originator", identity.originator], ["codex-wire-user-agent", identity.userAgent], ["codex-wire-transport", "sse"], ["codex-wire-compression", "off"]]);
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => wire(new Proxy(pi, { get(target, key) { return key === "getFlag" ? name => flags.get(name) : Reflect.get(target, key); } })), sessionMemory],
		systemPrompt: "Fixture standing instructions." });
	let session;
	t.after(async () => {
		try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
		finally {
			globalThis.fetch = priorFetch;
			if (priorEnv.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorEnv.agent;
			if (priorEnv.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = priorEnv.offline;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	await loader.reload();
	({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model,
		thinkingLevel: "xhigh", resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools: ["fixture_lookup"],
		customTools: [{ name: "fixture_lookup", label: "Fixture lookup", description: "Look up the fixture value.",
			parameters: Type.Object({ value: Type.String() }), execute: async () => assert.fail("fixture tool must not execute") }] }));
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
	assert.deepEqual(errors, []);
	return { session, manager, model, runtime, calls, errors, directory, setResponse: fn => { compactResponse = fn; } };
}

test("real AgentSession compacts through native Responses, persists, resumes and replays the exact checkpoint", async t => {
	const h = await harness(t);
	const oldBytes = readFileSync(h.manager.getSessionFile());
	assert.equal(h.session.thinkingLevel, "xhigh");
	const result = await h.session.compact("Keep the unresolved work.");
	assert.ok(result.summary.startsWith(CHECKPOINT_CAPTION));
	assert.equal(result.usage, undefined, "native endpoint reported no usage");
	assert.deepEqual(result.details[CHECKPOINT].output.filter(item => item.type === "compaction"), [output[1]]);
	const call = h.calls[0];
	assert.deepEqual(result.details[CHECKPOINT].output.filter(item => item.role === "user"),
		call.body.input.filter(item => item.role === "user").map(item => ({ ...item, type: "message" })),
		"Pi's implicit user-message type must survive native retention");
	assert.ok(call.url.endsWith("/responses"));
	assert.deepEqual(call.body.input.at(-1), { type: "compaction_trigger" });
	assert.deepEqual(call.body.reasoning, { effort: "xhigh", context: "all_turns" });
	for (const key of ["max_output_tokens", "previous_response_id"]) assert.equal(key in call.body, false);
	assert.equal(call.body.stream, true); assert.equal(call.body.store, false);
	assert.equal(call.headers.get("session-id"), h.manager.getSessionId());
	assert.equal(JSON.parse(call.headers.get("x-codex-turn-metadata")).request_kind, "compaction");
	assert.ok(JSON.stringify(call.body).includes("Fixture standing instructions."));
	assert.ok(JSON.stringify(call.body).includes("Keep the unresolved work."));
	const sentCall = call.body.input.find(item => item.type === "function_call");
	const sentResult = call.body.input.find(item => item.type === "function_call_output");
	assert.ok(sentCall && sentResult);
	assert.equal(sentCall.call_id, sentResult.call_id);
	assert.deepEqual(JSON.parse(sentCall.arguments), { value: "paired fixture" });
	const catalog = call.body.input.find(item => item.type === "additional_tools");
	assert.equal(catalog.tools[0].tools[0].name, "fixture_lookup");
	assert.ok(readFileSync(h.manager.getSessionFile()).subarray(0, oldBytes.length).equals(oldBytes));
	await h.session.prompt("Continue the fixture.", { expandPromptTemplates: false });
	const ordinary = h.calls.at(-1);
	assert.ok(ordinary.url.endsWith("/responses"));
	const index = ordinary.body.input.findIndex(item => item.type === "compaction");
	assert.ok(index > 0);
	assert.deepEqual(ordinary.body.input[index], output[1]);
	assert.equal(JSON.stringify(ordinary.body).includes(CHECKPOINT_CAPTION), false);
	assert.equal(JSON.stringify(ordinary.body).includes("codex-checkpoint:"), false);
	assert.deepEqual(h.errors, []);
	const reopened = SessionManager.open(h.manager.getSessionFile());
	const context = { messages: convertToLlm(projectCheckpoints(reopened.buildSessionContext().messages, reopened.getBranch())) };
	const binding = result.details[CHECKPOINT].binding;
	assert.deepEqual(replayCheckpoints(compactInput(h.model, context, "xhigh"), context, binding).input.filter(item => item.type === "compaction"), [output[1]]);
	const child = SessionManager.create(h.directory, h.directory);
	copyCompletedParentTurns(reopened, child, "absent");
	const forkContext = { messages: convertToLlm(checkpointMessages(child.buildContextEntries())) };
	assert.deepEqual(replayCheckpoints(compactInput(h.model, forkContext, "xhigh"), forkContext, binding).input.filter(item => item.type === "compaction"), [output[1]]);
	assert.throws(() => assertCheckpointContext(forkContext, "anthropic"), /requires Codex Wire/);
	assert.throws(() => assertCheckpointContext({ messages: [] }, "openai-codex", reopened.buildContextEntries()), /lost during context conversion/);
	assert.throws(() => replayCheckpoints(compactInput(h.model, context, "xhigh"), context, "0".repeat(64)), /different account or endpoint/);
	let otherRequests = 0;
	h.runtime.registerProvider("fixture-other", { name: "Fixture other", apiKey: "fixture", baseUrl: "https://fixture.invalid", api: modelData.api,
		streamSimple: () => { otherRequests++; throw new Error("Must not reach the other provider"); }, models: [modelData] });
	await h.session.setModel(h.runtime.getModel("fixture-other", modelData.id));
	await h.session.prompt("Wrong-provider fixture.", { expandPromptTemplates: false });
	assert.equal(otherRequests, 0);
	assert.match(h.session.messages.at(-1).errorMessage, /requires Codex Wire/);
	await h.session.setModel(h.model);
	await h.session.prompt("Later fixture turn " + "z".repeat(2400), { expandPromptTemplates: false });
	const second = await h.session.compact();
	assert.notEqual(second.summary, result.summary, "Pi locates saved entries by summary text");
	assert.deepEqual(h.calls.at(-1).body.input.filter(item => item.type === "compaction"), [output[1]]);
	const target = reopened.getBranch().find(entry => entry.type === "message").id;
	const navigation = await h.session.navigateTree(target, { summarize: true });
	assert.equal(navigation.cancelled, false);
	assert.equal(h.calls.at(-1).url.endsWith("/responses"), true);
	assert.deepEqual(h.calls.at(-1).body.input.filter(item => item.type === "compaction"), [output[1]]);
	assert.deepEqual(h.errors, []);
});

test("native compaction honours the existing caller retry budget and never falls through to prose", async t => {
	const h = await harness(t);
	const before = readFileSync(h.manager.getSessionFile());
	h.setResponse(() => new Response("fixture private error", { status: 503 }));
	await assert.rejects(h.session.compact(), /Compaction cancelled/);
	assert.equal(h.calls.length, 4);
	assert.ok(h.calls.every(call => call.url.endsWith("/responses") && call.body.input.at(-1)?.type === "compaction_trigger"));
	assert.deepEqual(readFileSync(h.manager.getSessionFile()), before);
	h.calls.length = 0;
	h.setResponse(() => new Response("fixture endpoint unavailable", { status: 404 }));
	await assert.rejects(h.session.compact(), /Compaction cancelled/);
	assert.equal(h.calls.length, 1, "404 must not retry or fall through to prose");
	assert.deepEqual(readFileSync(h.manager.getSessionFile()), before);
	h.calls.length = 0;
	h.setResponse(() => compactStream([{ type: "message", role: "assistant", content: [] }]));
	await assert.rejects(h.session.compact(), /Compaction cancelled/);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(readFileSync(h.manager.getSessionFile()), before);
	h.calls.length = 0;
	h.setResponse(() => Response.json({ error: { code: "insufficient_quota", message: "fixture private quota" } }, { status: 429 }));
	await assert.rejects(h.session.compact(), /Compaction cancelled/);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(readFileSync(h.manager.getSessionFile()), before);
	h.calls.length = 0;
	h.setResponse(call => new Promise((_resolve, reject) => {
		call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
		queueMicrotask(() => h.session.abortCompaction());
	}));
	await assert.rejects(h.session.compact(), /Compaction cancelled/);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(readFileSync(h.manager.getSessionFile()), before);
});

test("reported compaction usage is preserved and accounted without exposing ciphertext", async t => {
	const h = await harness(t);
	const reported = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } };
	h.setResponse(() => compactStream([output[1]], reported));
	const result = await h.session.compact();
	assert.deepEqual(result.details[CHECKPOINT].reportedUsage, reported);
	assert.equal(result.usage.input, 40);
	assert.equal(result.usage.cacheRead, 60);
	assert.equal(result.usage.output, 20);
	assert.equal(result.usage.reasoning, 5);
	assert.equal(result.usage.totalTokens, 120);
});

test("an existing stock-Pi prose summary becomes part of the native checkpoint input", async t => {
	const h = await harness(t);
	const users = h.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user");
	h.manager.appendCompaction("Existing stock-Pi summary: unfinished fixture work.", users[4].id, 10000);
	h.manager.appendMessage(user("Resumed fixture work."));
	h.manager.appendMessage(assistant("More work " + "r".repeat(1800)));
	const before = readFileSync(h.manager.getSessionFile());
	await h.session.compact();
	assert.ok(JSON.stringify(h.calls.at(-1).body.input).includes("Existing stock-Pi summary: unfinished fixture work."));
	assert.ok(readFileSync(h.manager.getSessionFile()).subarray(0, before.length).equals(before));
});

test("SDK child inherits the compactor while using its own session and routing state", async t => {
	const h = await harness(t);
	await h.session.compact();
	const manager = SessionManager.create(h.directory, h.directory);
	copyCompletedParentTurns(h.manager, manager, "absent");
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const bound = bindChildProvider(h.runtime.getProvider("openai-codex"), manager.getSessionId());
	runtime.registerNativeProvider(bound);
	const settings = SettingsManager.create(h.directory, h.directory, { projectTrusted: false });
	const loader = new DefaultResourceLoader({ cwd: h.directory, agentDir: h.directory, settingsManager: settings,
		noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
		extensionFactories: [pi => nativeCompaction(pi, settings)], systemPrompt: "Child fixture instructions." });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: h.directory, agentDir: h.directory, modelRuntime: runtime, model: h.model,
		thinkingLevel: "xhigh", resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools: [] });
	try {
		await session.bindExtensions({ mode: "print" });
		const result = await session.compact();
		const call = h.calls.at(-1);
		assert.equal(call.headers.get("session-id"), manager.getSessionId());
		assert.notEqual(call.headers.get("session-id"), h.manager.getSessionId());
		assert.deepEqual(call.body.input.filter(item => item.type === "compaction"), [output[1]]);
		assert.deepEqual(result.details[CHECKPOINT].output.filter(item => item.type === "compaction"), [output[1]]);
		await session.prompt("Continue child fixture.", { expandPromptTemplates: false });
		assert.deepEqual(h.calls.at(-1).body.input.filter(item => item.type === "compaction"), [output[1]]);
	} finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
});

test("native compaction retry cancellation stops before another attempt", async () => {
	const controller = new AbortController(); let attempts = 0;
	await assert.rejects(retryCompaction(async () => { attempts++; throw new Error("503"); },
		{ enabled: true, maxRetries: 3, baseDelayMs: 1 }, controller.signal, () => controller.abort()), /abort/i);
	assert.equal(attempts, 1);
	const headers = new Headers({ "chatgpt-account-id": "fixture-account" });
	assert.notEqual(checkpointBinding("https://chatgpt.com/a/responses", headers), checkpointBinding("https://chatgpt.com/b/responses", headers));
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { PartyStore } from "./store.ts";
import { NativeQueueGuard } from "../pi-work-coordination/native-queue.ts";
const { default: party } = await import(process.env.PI_PARTY_TEST_EXTENSION || new URL("./index.ts", import.meta.url).href);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
	await import(process.env.PI_PARTY_TEST_SDK || "@earendil-works/pi-coding-agent");

const modelData = { id: "offline", name: "Offline party fixture", api: "openai-completions", reasoning: false,
	input: ["text"], contextWindow: 32768, maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, extraExtensions = [], uiContext) {
	const directory = mkdtempSync(join(tmpdir(), "pi-party-prompt-"));
	const priorDir = process.env.PI_CODING_AGENT_DIR, priorFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = directory;
	globalThis.fetch = async () => assert.fail("network disabled in party prompt fixture");
	let session, db;
	t.after(async () => {
		try {
			if (session) {
				session.agent.abort();
				await session.agent.waitForIdle();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			db?.close();
		} finally {
			if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
			globalThis.fetch = priorFetch;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false } });
	const manager = SessionManager.inMemory(directory, { id: "recipient" });
	const contexts = [], requests = [], errors = [];
	const started = Promise.withResolvers();
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("party-fixture", { name: "Offline party fixture", apiKey: "fixture", api: modelData.api,
		baseUrl: "http://127.0.0.1:1", models: [modelData], streamSimple(model, context, options) {
			contexts.push(context.messages);
			const stream = new AssistantMessageEventStream();
			let done = false;
			const finish = (aborted = false, content) => {
				if (done) return;
				done = true;
				const message = { role: "assistant", content: content ?? [{ type: "text", text: aborted ? "" : "Fixture reply." }],
					api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: aborted ? "aborted" : content?.some(block => block.type === "toolCall") ? "toolUse" : "stop" };
				stream.push(aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: message.stopReason, message });
			};
			options.signal?.addEventListener("abort", () => finish(true), { once: true });
			requests.push({ finish, signal: options.signal });
			started.resolve();
			if (requests.length > 1) queueMicrotask(() => finish());
			return stream;
		} });
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		extensionFactories: [party, ...extraExtensions], systemPrompt: "Offline fixture." });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
		model: runtime.getModel("party-fixture", "offline"), resourceLoader: loader, sessionManager: manager, settingsManager: settings }));
	new NativeQueueGuard(session, () => false);
	await session.bindExtensions({ mode: "rpc", uiContext, onError: error => errors.push(error) });
	db = new PartyStore(join(directory, "party"));
	db.register("sender", "sender-process", "Peer");
	return { session, runtime, db, contexts, requests, errors, started: started.promise };
}

test("human and peer messages remain queued while party creation awaits user approval", { timeout: 15000 }, async t => {
	const entered = Promise.withResolvers(), approval = Promise.withResolvers();
	t.after(() => approval.resolve(false));
	const f = await fixture(t, [], { confirm: async () => { entered.resolve(); return approval.promise; } });
	await f.session.agent.state.tools.find(tool => tool.name === "party_join").execute("join", { party: "approval-room" });
	const running = f.session.prompt("REVIEW TASK");
	await f.started;
	f.requests[0].finish(false, [{ type: "toolCall", id: "create", name: "party_create", arguments: {
		cwd: "/fixture", label: "Reviewer", task: "Inspect the separate implementation.",
	} }]);
	await entered.promise;
	await f.session.prompt("HUMAN COMMENT WHILE WAITING", { streamingBehavior: "steer" });
	f.db.send("sender", "sender-process", "recipient", "PEER COMMENT WHILE WAITING", true);
	await f.session.agent.state.tools.find(tool => tool.name === "party_delivery").execute("pulse", { enabled: true });
	await nextTick();
	assert.equal(f.requests.length, 1, "an approval wait cannot start another model run");
	approval.resolve(false);
	await running;
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.contexts[1]), /HUMAN COMMENT WHILE WAITING/);
	assert.match(JSON.stringify(f.contexts[1]), /PEER COMMENT WHILE WAITING/);
	const result = f.contexts[1].find(message => message.role === "toolResult" && message.toolCallId === "create");
	assert.deepEqual(JSON.parse(result.content[0].text), { approved: false });
	assert.deepEqual(f.errors, []);
});

test("queued party wakes join a human prompt without launching a second low-level run", { timeout: 15000 }, async t => {
	const f = await fixture(t);
	f.db.send("sender", "sender-process", "recipient", "QUEUED PEER FINDING", true);
	let promptError;
	const running = f.session.prompt("HUMAN TASK").catch(error => { promptError = error; });
	await f.started;
	await nextTick();
	assert.equal(promptError, undefined, `human prompt collided with a party wake: ${promptError}; sessionStreaming=${f.session.isStreaming}, coreStreaming=${f.session.agent.state.isStreaming}`);
	assert.equal(f.session.isStreaming, true);
	assert.equal(f.session.agent.state.isStreaming, true);
	assert.equal(f.requests.length, 1);
	assert.match(JSON.stringify(f.contexts[0]), /HUMAN TASK/);
	assert.match(JSON.stringify(f.contexts[0]), /QUEUED PEER FINDING/);
	await f.session.prompt("HUMAN STEERING", { streamingBehavior: "steer" });
	assert.deepEqual(f.session.getSteeringMessages(), ["HUMAN STEERING"]);
	await f.session.abort();
	await running;
	assert.equal(f.requests[0].signal.aborted, true);
	assert.equal(f.session.isIdle, true);
	assert.equal(f.session.agent.state.isStreaming, false);
	f.session.clearQueue();
	await f.session.prompt("NEW HUMAN TASK");
	assert.equal(f.session.isIdle, true);
	assert.deepEqual(f.errors, []);
});

test("party arrivals during an asynchronous prompt hook are attached to that prompt", { timeout: 15000 }, async t => {
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	t.after(() => gate.resolve());
	const f = await fixture(t, [pi => pi.on("before_agent_start", async () => { entered.resolve(); await gate.promise; })]);
	let promptError;
	const running = f.session.prompt("HUMAN TASK").catch(error => { promptError = error; });
	await entered.promise;
	f.db.send("sender", "sender-process", "recipient", "LATE PEER FINDING", true);
	await f.session.agent.state.tools.find(tool => tool.name === "party_delivery").execute("resume", { enabled: true });
	await nextTick();
	assert.equal(f.requests.length, 0, "a party wake cannot overtake prompt preparation");
	gate.resolve();
	await f.started;
	assert.equal(promptError, undefined);
	assert.equal(f.requests.length, 1);
	assert.match(JSON.stringify(f.contexts[0]), /HUMAN TASK/);
	assert.match(JSON.stringify(f.contexts[0]), /LATE PEER FINDING/);
	await f.session.abort(); await running;
	assert.deepEqual(f.errors, []);
});

test("party wakes cannot overtake native authentication preflight", { timeout: 15000 }, async t => {
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	t.after(() => gate.resolve());
	const f = await fixture(t), check = f.runtime.checkAuth.bind(f.runtime);
	let first = true, promptError;
	f.runtime.hasConfiguredAuth = () => false;
	f.runtime.checkAuth = async (...args) => {
		if (first) { first = false; entered.resolve(); await gate.promise; }
		return check(...args);
	};
	const running = f.session.prompt("HUMAN TASK", { streamingBehavior: "steer" }).catch(error => { promptError = error; });
	await entered.promise;
	f.db.send("sender", "sender-process", "recipient", "AUTH-PREFLIGHT PEER FINDING", true);
	await f.session.agent.state.tools.find(tool => tool.name === "party_delivery").execute("resume", { enabled: true });
	await nextTick();
	const requestsBeforeAdmission = f.requests.length;
	gate.resolve(); await f.started; await nextTick();
	assert.equal(promptError, undefined, `human input collided with a party wake: ${promptError}`);
	assert.equal(requestsBeforeAdmission, 0, "automatic party wake must wait for the human prompt's native admission");
	assert.equal(f.requests.length, 1);
	assert.match(JSON.stringify(f.contexts[0]), /HUMAN TASK/);
	assert.match(JSON.stringify(f.contexts[0]), /AUTH-PREFLIGHT PEER FINDING/);
	await f.session.abort(); await running;
	assert.deepEqual(f.errors, []);
});

test("an idle agent awakened by a peer remains steerable and cancellable", { timeout: 15000 }, async t => {
	const f = await fixture(t);
	f.db.send("sender", "sender-process", "recipient", "PEER-INITIATED TASK", true);
	await f.session.agent.state.tools.find(tool => tool.name === "party_delivery").execute("resume", { enabled: true });
	await f.started;
	assert.equal(f.session.isStreaming, true);
	assert.equal(f.session.agent.state.isStreaming, true);
	await f.session.prompt("HUMAN STEERING", { streamingBehavior: "steer" });
	assert.deepEqual(f.session.getSteeringMessages(), ["HUMAN STEERING"]);
	await f.session.abort();
	assert.equal(f.requests[0].signal.aborted, true);
	assert.equal(f.session.isIdle, true);
	assert.equal(f.session.agent.state.isStreaming, false);
	assert.deepEqual(f.errors, []);
});

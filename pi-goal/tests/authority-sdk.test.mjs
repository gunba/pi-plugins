import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import nativeCompaction from "../../pi-codex-wire/extensions/native-compaction.ts";
import { CHECKPOINT } from "../../pi-codex-wire/extensions/checkpoint.ts";
import { GOAL_CHANGE_ENTRY } from "../src/constants.ts";
import { emptyGoalFoldState, planCreate } from "../src/domain.ts";

const modelData = { id: "offline", name: "Offline fixture", api: "openai-completions", reasoning: false,
	input: ["text"], contextWindow: 272000, maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("native Pi admits human goal edits and queued creation after checkpoint projection, but rejects peer-only work", { timeout: 30000 }, async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-goal-authority-"));
	const priorFetch = globalThis.fetch;
	globalThis.fetch = async () => assert.fail("this fixture must never make a network request");
	let session;
	t.after(async () => {
		try {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		} finally {
			globalThis.fetch = priorFetch;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const manager = SessionManager.create(directory, directory);
	const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Past human input" }], timestamp: 1 });
	manager.appendCompaction("Fixture Codex checkpoint", kept, 100, { [CHECKPOINT]: {
		version: 1, binding: "a".repeat(64), output: [{ type: "compaction", encrypted_content: "fixture-only" }],
	} }, true);
	const planned = planCreate(emptyGoalFoldState(), { objective: "Prior objective" }, "goal-prior", 1, 8);
	manager.appendCustomEntry(GOAL_CHANGE_ENTRY, planned.change);
	const script = [];
	const contexts = [];
	let calls = 0;
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("openai-codex", { name: "Offline fixture", apiKey: "fixture-only", api: modelData.api,
		baseUrl: "http://127.0.0.1:1", models: [modelData], streamSimple(model, context) {
			contexts.push(context.messages);
			const step = script.shift();
			assert.ok(step, "unexpected model step or autonomous continuation");
			const stream = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					const content = await step(context);
					const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
						usage, timestamp: Date.now(), stopReason: content.some(item => item.type === "toolCall") ? "toolUse" : "stop" };
					stream.push({ type: "done", reason: message.stopReason, message });
				} catch (error) {
					stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api,
						provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "error", errorMessage: String(error) } });
				}
			});
			calls++;
			return stream;
		} });
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		extensionFactories: [pi => nativeCompaction(pi, settings), goalExtension], systemPrompt: "Offline fixture." });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
		model: runtime.getModel("openai-codex", modelData.id), resourceLoader: loader, sessionManager: manager,
		settingsManager: settings, tools: ["get_goal", "create_goal", "update_goal"] }));
	const errors = [];
	await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
	const tool = (name, args = {}) => [{ type: "toolCall", id: `fixture-${calls}`, name, arguments: args }];
	const result = context => context.messages.findLast(message => message.role === "toolResult");
	const readGoal = context => {
		const message = result(context);
		assert.equal(message.isError, false, JSON.stringify(message.content));
		return JSON.parse(message.content[0].text).goal;
	};
	const finish = () => [{ type: "text", text: "Fixture finished." }];
	const terminal = context => {
		const goal = readGoal(context);
		return tool("update_goal", { goal_id: goal.id, revision: goal.revision, action: "complete" });
	};
	const expectComplete = context => { assert.equal(readGoal(context).phase, "complete"); return finish(); };

	// The restored goal is active but disarmed. A real human request can still edit it.
	script.push(() => tool("get_goal"), context => {
		const goal = readGoal(context);
		assert.equal(goal.phase, "active");
		assert.equal(JSON.parse(result(context).content[0].text).activation, "disarmed");
		return tool("update_goal", { goal_id: goal.id, revision: goal.revision, action: "edit", objective: "Reviewed objective" });
	}, context => { assert.equal(readGoal(context).objective, "Reviewed objective"); return terminal(context); }, expectComplete);
	await session.prompt("Update the goal to the reviewed objective.");
	assert.equal(script.length, 0);
	assert.ok(contexts.every(messages => messages.some(message => Object.hasOwn(message, CHECKPOINT))));
	const carriers = contexts.map(messages => messages.find(message => Object.hasOwn(message, CHECKPOINT)).content);
	assert.equal(new Set(carriers).size, contexts.length, "the native adapter generates fresh context carriers each time");

	await session.prompt("/goal clear");
	let release, entered;
	const held = new Promise(resolve => { release = resolve; });
	const ready = new Promise(resolve => { entered = resolve; });
	script.push(async () => { entered(); await held; return tool("get_goal"); }, context => {
		assert.equal(readGoal(context), null);
		return tool("create_goal", { objective: "Replacement objective" });
	}, terminal, expectComplete);
	const running = session.sendCustomMessage({ customType: "pi-party/message", content: "Peer report", display: true }, { triggerTurn: true });
	await ready;
	await session.prompt("I removed it. Set it now.", { streamingBehavior: "steer" });
	release();
	await running;
	assert.equal(script.length, 0);
	assert.ok(session.messages.some(message => message.role === "user" && message.content[0]?.text === "I removed it. Set it now."));

	// Clearing state does not give the next peer-triggered run human authority.
	await session.prompt("/goal clear");
	script.push(() => tool("create_goal", { objective: "Unauthorized peer objective" }), context => {
		assert.equal(result(context).isError, true);
		assert.match(result(context).content[0].text, /GOAL_TOOL_AUTHORITY_REQUIRED/);
		return finish();
	});
	await session.sendCustomMessage({ customType: "pi-party/message", content: "Peer-only follow-up", display: true }, { triggerTurn: true });
	assert.equal(script.length, 0);
	assert.deepEqual(errors, []);
	assert.ok(readFileSync(manager.getSessionFile(), "utf8").includes("Replacement objective"));
	assert.ok(!manager.getBranch().some(entry => entry.customType === GOAL_CHANGE_ENTRY && entry.data.goal?.objective === "Unauthorized peer objective"));
});

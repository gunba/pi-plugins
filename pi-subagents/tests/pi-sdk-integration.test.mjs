import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSdkDriverFactory } from "../extensions/pi-sdk-driver.ts";

const providerId = "pi-subagent-integration";
const modelId = "offline-model";
const model = {
	id: modelId,
	name: "Offline integration model",
	api: "openai-completions",
	provider: providerId,
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 2_048,
};

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function streamSimple(_model, context) {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const latest = context.messages.at(-1);
		const prompt = latest?.role === "user"
			? (typeof latest.content === "string"
				? latest.content
				: latest.content.filter((block) => block.type === "text").map((block) => block.text).join(""))
			: "missing prompt";
		const message = {
			role: "assistant",
			content: [{ type: "text", text: `SDK child received: ${prompt}` }],
			api: model.api,
			provider: providerId,
			model: modelId,
			usage: structuredClone(zeroUsage),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: message.content[0].text,
			partial: message,
		});
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: message.content[0].text,
			partial: message,
		});
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

test("Pi SDK driver runs a real isolated AgentSession with inherited provider configuration", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-sdk-integration-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	const manager = SessionManager.create(cwd, sessions, { id: "offline-child" });
	const host = {
		rootSessionId: "root",
		cwd,
		agentDir,
		activeRootLaunchIds: new Set(),
		recordRootLaunch() {},
		deliverRootNotice() { return true; },
		resolveModel: () => model,
		async prepareModelRuntime(_ref, runtime) {
			runtime.registerProvider(providerId, {
				name: "Offline integration provider",
				baseUrl: model.baseUrl,
				apiKey: "offline-test-key",
				api: model.api,
				streamSimple,
				models: [{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}],
			});
		},
	};
	let driver;
	try {
		const factory = new PiSdkDriverFactory(host);
		driver = await factory.open({
			descriptor: {
				version: 1,
				childSessionId: "offline-child",
				rootSessionId: "root",
				parentSessionId: "root",
				mode: "continuable",
				context: "fresh",
				provider: "pi-sdk",
				label: "offline integration",
				depth: 1,
				cwd,
				createdAt: Date.now(),
				model: { provider: providerId, id: modelId },
				thinkingLevel: "off",
				toolNames: [],
			},
			sessionManager: manager,
			authority: {
				sessionId: "offline-child",
				rootSessionId: "root",
				depth: 1,
				generation: "integration",
				token: Symbol("offline-child"),
			},
			customTools: [],
		});
		const outcome = await driver.prompt("hello from the parent");
		assert.equal(outcome.stopReason, "completed");
		assert.equal(outcome.output, "SDK child received: hello from the parent");
		assert.deepEqual(
			manager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message.role),
			["user", "assistant"],
		);
	} finally {
		driver?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

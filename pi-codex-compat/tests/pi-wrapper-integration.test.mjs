import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import codexCompat from "../extensions/codex-compat.ts";
import { CODEX_COMPAT_TOOL_NAMES } from "../extensions/model-tools.ts";
import { shutdownExecSessions } from "../extensions/shell-runtime.ts";

const FAKE_API = "pi-codex-compat-integration";
const FAKE_PROVIDER = "openai";
const FAKE_MODEL_ID = "gpt-5-pi-codex-compat-integration";
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(model, content, stopReason, errorMessage) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: structuredClone(ZERO_USAGE),
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function pushAssistantMessage(stream, message) {
	const emptyPartial = { ...message, content: [] };
	stream.push({ type: "start", partial: emptyPartial });

	const block = message.content[0];
	if (block?.type === "toolCall") {
		const startedPartial = {
			...message,
			content: [
				{ type: "toolCall", id: block.id, name: block.name, arguments: {} },
			],
		};
		stream.push({
			type: "toolcall_start",
			contentIndex: 0,
			partial: startedPartial,
		});
		stream.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: block,
			partial: message,
		});
	} else if (block?.type === "text") {
		const startedPartial = {
			...message,
			content: [{ type: "text", text: "" }],
		};
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: startedPartial,
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: block.text,
			partial: message,
		});
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: block.text,
			partial: message,
		});
	}

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		return;
	}
	stream.push({ type: "done", reason: message.stopReason, message });
}

function createFakeAssistantMessageEventStreamProvider() {
	let scenario;
	let nextToolCallId = 1;

	return {
		streamSimple(model, context, options) {
			const stream = new AssistantMessageEventStream();
			const currentScenario = scenario;
			queueMicrotask(() => {
				if (options?.signal?.aborted) {
					pushAssistantMessage(
						stream,
						assistantMessage(
							model,
							[],
							"aborted",
							"Fake provider request was aborted",
						),
					);
					return;
				}
				if (!currentScenario) {
					pushAssistantMessage(
						stream,
						assistantMessage(
							model,
							[],
							"error",
							"No fake tool-call scenario is active",
						),
					);
					return;
				}

				const lastMessage = context.messages.at(-1);
				if (
					lastMessage?.role === "toolResult" &&
					lastMessage.toolCallId === currentScenario.toolCallId
				) {
					pushAssistantMessage(
						stream,
						assistantMessage(
							model,
							[{ type: "text", text: "Tool result observed." }],
							"stop",
						),
					);
					return;
				}

				pushAssistantMessage(
					stream,
					assistantMessage(
						model,
						[
							{
								type: "toolCall",
								id: currentScenario.toolCallId,
								name: currentScenario.toolName,
								arguments: currentScenario.arguments,
							},
						],
						"toolUse",
					),
				);
			});
			return stream;
		},
		begin(toolName, arguments_) {
			assert.equal(
				scenario,
				undefined,
				"fake provider scenarios must not overlap",
			);
			const toolCallId = `integration-tool-${nextToolCallId++}`;
			scenario = { toolCallId, toolName, arguments: arguments_ };
			return toolCallId;
		},
		end(toolCallId) {
			assert.equal(scenario?.toolCallId, toolCallId);
			scenario = undefined;
		},
	};
}

function textContent(result) {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function receivedArguments(validationText) {
	const marker = "\n\nReceived arguments:\n";
	const markerIndex = validationText.indexOf(marker);
	assert.notEqual(markerIndex, -1, validationText);
	return JSON.parse(validationText.slice(markerIndex + marker.length));
}

async function createHarness() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-codex-wrapper-integration-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });

	const fakeProvider = createFakeAssistantMessageEventStreamProvider();
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(FAKE_PROVIDER, {
		name: "Pi Codex Compat Integration Provider",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "integration-test-key",
		api: FAKE_API,
		streamSimple: fakeProvider.streamSimple,
		models: [
			{
				id: FAKE_MODEL_ID,
				name: "Pi Codex Compat Integration Model",
				api: FAKE_API,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	});
	const model = modelRegistry.find(FAKE_PROVIDER, FAKE_MODEL_ID);
	assert.ok(model);

	const middlewareEvents = [];
	const observeMiddleware = (pi) => {
		pi.on("tool_call", (event) => {
			middlewareEvents.push({
				type: "tool_call",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: structuredClone(event.input),
			});
		});
		pi.on("tool_result", (event) => {
			middlewareEvents.push({
				type: "tool_result",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				details:
					event.details === undefined
						? undefined
						: structuredClone(event.details),
			});
		});
	};

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [codexCompat, observeMiddleware],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Run the integration test's requested tool call.",
	});

	let session;
	let extensionsResult;
	try {
		await resourceLoader.reload();
		({ session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			model,
			thinkingLevel: "off",
			tools: CODEX_COMPAT_TOOL_NAMES,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		}));
		await session.bindExtensions({ mode: "print" });
	} catch (error) {
		modelRegistry.unregisterProvider(FAKE_PROVIDER);
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}

	const sessionEvents = [];
	const unsubscribe = session.subscribe((event) => sessionEvents.push(event));

	async function invoke(toolName, args, options = {}) {
		const toolCallId = fakeProvider.begin(toolName, args);
		const eventOffset = sessionEvents.length;
		const middlewareOffset = middlewareEvents.length;
		const messageOffset = session.messages.length;
		let abortPromise;
		const unsubscribeAbort = options.abortOnUpdate
			? session.subscribe((event) => {
					if (
						event.type === "tool_execution_update" &&
						event.toolCallId === toolCallId
					) {
						abortPromise ??= session.abort();
					}
				})
			: () => {};

		try {
			await session.prompt(
				`Execute ${toolName} for integration scenario ${toolCallId}.`,
			);
			await abortPromise;
		} finally {
			unsubscribeAbort();
			fakeProvider.end(toolCallId);
		}

		const events = sessionEvents.slice(eventOffset);
		const executionEnds = events.filter(
			(event) =>
				event.type === "tool_execution_end" && event.toolCallId === toolCallId,
		);
		assert.equal(executionEnds.length, 1);
		const toolMessages = session.messages
			.slice(messageOffset)
			.filter(
				(message) =>
					message.role === "toolResult" && message.toolCallId === toolCallId,
			);
		assert.equal(toolMessages.length, 1);

		return {
			toolCallId,
			end: executionEnds[0],
			message: toolMessages[0],
			middleware: middlewareEvents
				.slice(middlewareOffset)
				.filter((event) => event.toolCallId === toolCallId),
		};
	}

	return {
		cwd,
		extensionsResult,
		invoke,
		modelRegistry,
		session,
		async dispose() {
			unsubscribe();
			if (!session.isIdle) await session.abort();
			await shutdownExecSessions();
			extensionsResult.runtime.invalidate("Integration test runtime disposed");
			session.dispose();
			modelRegistry.unregisterProvider(FAKE_PROVIDER);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

function assertErrorOutcome(run, expectedIsError) {
	assert.equal(run.end.isError, expectedIsError);
	assert.equal(run.message.isError, expectedIsError);
	assert.deepEqual(run.message.details, run.end.result.details);
}

function assertMiddlewareRun(run, expectedIsError) {
	assert.deepEqual(
		run.middleware.map((event) => event.type),
		["tool_call", "tool_result"],
	);
	assert.equal(run.middleware[1].isError, expectedIsError);
}

test("pi-codex-compat tools run through a real AgentSession agent loop", async (t) => {
	const harness = await createHarness();
	try {
		await t.test("registers and wraps all five owned tools", () => {
			assert.deepEqual(harness.extensionsResult.errors, []);
			assert.equal(harness.extensionsResult.extensions.length, 2);
			assert.deepEqual(
				harness.session.getActiveToolNames().sort(),
				[...CODEX_COMPAT_TOOL_NAMES].sort(),
			);

			const agentTools = new Map(
				harness.session.agent.state.tools.map((tool) => [tool.name, tool]),
			);
			assert.deepEqual(
				[...agentTools.keys()].sort(),
				[...CODEX_COMPAT_TOOL_NAMES].sort(),
			);
			for (const name of CODEX_COMPAT_TOOL_NAMES) {
				const wrapped = agentTools.get(name);
				const registered = harness.session.getToolDefinition(name);
				assert.ok(wrapped, name);
				assert.ok(registered, name);
				assert.notEqual(wrapped.execute, registered.execute, name);
			}
			assert.equal(
				typeof agentTools.get("apply_patch").prepareArguments,
				"function",
			);
			assert.equal(
				typeof agentTools.get("view_image").prepareArguments,
				"function",
			);
		});

		await t.test(
			"invalid apply_patch is a true error with shaped details",
			async () => {
				const run = await harness.invoke("apply_patch", {
					input: "not a patch",
				});
				assertErrorOutcome(run, true);
				assertMiddlewareRun(run, true);
				assert.deepEqual(run.end.result.details.changes, []);
				assert.equal(run.end.result.details.exitCode, 1);
				assert.equal(typeof run.end.result.details.wallTimeSeconds, "number");
				assert.match(run.end.result.details.error, /first line.*Begin Patch/);
				assert.match(textContent(run.end.result), /^Exit code: 1/m);
			},
		);

		await t.test("raw HTTP exec blocking is a true error", async () => {
			const run = await harness.invoke("exec_command", {
				cmd: "curl https://example.com",
				workdir: harness.cwd,
			});
			assertErrorOutcome(run, true);
			assertMiddlewareRun(run, true);
			assert.equal(typeof run.end.result.details.error, "string");
			assert.match(textContent(run.end.result), /blocked by pi-codex-compat/);
		});

		await t.test("an unknown write_stdin session is a true error", async () => {
			const run = await harness.invoke("write_stdin", {
				session_id: 2_147_483_647,
			});
			assertErrorOutcome(run, true);
			assertMiddlewareRun(run, true);
			assert.deepEqual(run.end.result.details, {});
			assert.match(
				textContent(run.end.result),
				/no unified exec session 2147483647/,
			);
		});

		await t.test("exec cancellation is a true error after launch", async () => {
			const run = await harness.invoke(
				"exec_command",
				{
					cmd: `node -e "require('node:net').createServer().listen(0)"`,
					workdir: harness.cwd,
					yield_time_ms: 1_000,
					login: false,
				},
				{ abortOnUpdate: true },
			);
			assertErrorOutcome(run, true);
			assertMiddlewareRun(run, true);
			assert.equal(run.end.result.details.aborted, true);
			assert.match(
				textContent(run.end.result),
				/Process (?:aborted|exited with signal)/,
			);
		});

		await t.test(
			"a shaped view_image failure is a true error with details",
			async () => {
				const run = await harness.invoke("view_image", { path: "missing.txt" });
				assertErrorOutcome(run, true);
				assertMiddlewareRun(run, true);
				assert.equal(
					run.end.result.details.path,
					join(harness.cwd, "missing.txt"),
				);
				assert.equal(
					run.end.result.details.mediaType,
					"application/octet-stream",
				);
				assert.equal(run.end.result.details.bytes, 0);
				assert.match(
					run.end.result.details.error,
					/unsupported image extension/,
				);
			},
		);

		await t.test(
			"a normal exec nonzero exit remains a non-error result",
			async () => {
				const run = await harness.invoke("exec_command", {
					cmd: `node -e "process.exit(7)"`,
					workdir: harness.cwd,
					login: false,
				});
				assertErrorOutcome(run, false);
				assertMiddlewareRun(run, false);
				assert.equal(run.end.result.details.exit_code, 7);
				assert.equal(run.end.result.details.running, false);
				assert.equal("error" in run.end.result.details, false);
			},
		);

		await t.test(
			"TypeBox rejects unknown fields for all five owned tools after argument preparation",
			async () => {
				const legacyPatch = [
					"*** Begin Patch",
					"*** Add File: unknown-field-must-not-run.txt",
					"+not written",
					"*** End Patch",
				].join("\n");
				const cases = [
					{
						toolName: "apply_patch",
						args: { patch: legacyPatch, cwd: ".", unexpected: true },
						expected: { input: legacyPatch, workdir: ".", unexpected: true },
					},
					{
						toolName: "exec_command",
						args: { cmd: "printf should-not-run", unexpected: true },
					},
					{
						toolName: "write_stdin",
						args: { session_id: 2_147_483_647, unexpected: true },
					},
					{
						toolName: "view_image",
						args: { image_path: "missing.png", unexpected: true },
						expected: { path: "missing.png", unexpected: true },
					},
					{
						toolName: "image_gen",
						args: { prompt: "must not generate", unexpected: true },
					},
				];

				for (const scenario of cases) {
					const run = await harness.invoke(scenario.toolName, scenario.args);
					assertErrorOutcome(run, true);
					assert.deepEqual(run.middleware, [], scenario.toolName);
					assert.deepEqual(run.end.result.details, {}, scenario.toolName);
					const output = textContent(run.end.result);
					assert.match(
						output,
						new RegExp(`Validation failed for tool "${scenario.toolName}"`),
						scenario.toolName,
					);
					assert.deepEqual(
						receivedArguments(output),
						scenario.expected ?? scenario.args,
						scenario.toolName,
					);
				}

				await assert.rejects(
					access(join(harness.cwd, "unknown-field-must-not-run.txt")),
					(error) => error?.code === "ENOENT",
				);
			},
		);

		await t.test(
			"TypeBox rejects fractional and negative Unified Exec integers",
			async () => {
				for (const scenario of [
					{
						toolName: "exec_command",
						args: { cmd: "printf no", yield_time_ms: 1.5 },
					},
					{
						toolName: "exec_command",
						args: { cmd: "printf no", max_output_tokens: -1 },
					},
					{ toolName: "write_stdin", args: { session_id: 1.5 } },
				]) {
					const run = await harness.invoke(scenario.toolName, scenario.args);
					assert.equal(
						run.end.isError,
						true,
						`${scenario.toolName} ${JSON.stringify(scenario.args)}`,
					);
					assert.equal(run.message.isError, true);
					assert.deepEqual(run.middleware, []);
					assert.match(textContent(run.end.result), /integer/);
				}
			},
		);

		await t.test(
			"raw argument preparation rejects lossy type coercion",
			async () => {
				for (const scenario of [
					{ toolName: "apply_patch", args: { input: 42 } },
					{ toolName: "exec_command", args: { cmd: 42 } },
					{ toolName: "exec_command", args: { cmd: "true", tty: 1 } },
					{ toolName: "write_stdin", args: { session_id: 1, chars: 7 } },
					{ toolName: "view_image", args: { path: false } },
					{ toolName: "image_gen", args: { prompt: 7 } },
					{
						toolName: "image_gen",
						args: { prompt: "edit", referenced_image_paths: [1] },
					},
					{
						toolName: "image_gen",
						args: { prompt: "edit", num_last_images_to_include: 1.5 },
					},
					{
						toolName: "image_gen",
						args: {
							prompt: "edit",
							referenced_image_paths: [],
							num_last_images_to_include: 1,
						},
					},
				]) {
					const run = await harness.invoke(scenario.toolName, scenario.args);
					assertErrorOutcome(run, true);
					assert.deepEqual(run.middleware, []);
					assert.notEqual(textContent(run.end.result), "");
				}
			},
		);
	} finally {
		await harness.dispose();
	}
});

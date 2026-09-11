import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createChildTodoTool } from "./child-todo-tool.ts";
import { ensureWorkCoordination, getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { releaseWorkCoordinator } from "../../pi-work-coordination/core.ts";
import { noticeBatch, noticeBatchContent } from "./notice-batcher.ts";
import outputBudget from "../../pi-output-budget/extensions/index.ts";
import requestTracing from "../../pi-codex-wire/extensions/request-trace.ts";
import { loadChildToolExtensions } from "./child-tool-extensions.ts";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	ChildDriver,
	ChildDriverFactory,
	RunOutcome,
	RuntimeHost,
	ParentNotice,
} from "./subagent-runtime.ts";
import { addUsage, undispatchedNotices } from "./subagent-runtime.ts";

type AgentMessage = AgentSession["messages"][number];

/** Summarizer requests may omit sessionId; never fall back to the root thread. */
export function bindChildProvider(provider: Provider, sessionId: string): Provider {
	return {
		...provider,
		getModels: provider.getModels.bind(provider),
		...(provider.refreshModels ? { refreshModels: provider.refreshModels.bind(provider) } : {}),
		...(provider.filterModels ? { filterModels: provider.filterModels.bind(provider) } : {}),
		...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
		...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
		stream: (model, context, options) => provider.stream(model, context, { ...options, sessionId: options?.sessionId ?? sessionId } as typeof options),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, sessionId: options?.sessionId ?? sessionId }),
	};
}

const CHILD_CONTEXT = `You are a delegated subagent. Tools follow the parent's enabled selection and execute in your own session. Actual permissions, project trust and direct-human approval requirements still apply; you cannot grant yourself authority. Work independently in the shared working directory. Report questions requiring human input to your direct parent. Background children continue after you start them.`;
const REPORT_CONTEXT = `Use report for actionable findings that change what your parent should do next. Ordinary progress belongs in the dashboard. Your final answer is delivered automatically; do not report it again.`;

export function childSystemContext(mode: "continuable" | "one-shot"): string {
	return mode === "continuable" ? `${CHILD_CONTEXT} ${REPORT_CONTEXT}` : CHILD_CONTEXT;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function latestAssistant(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

export function outcomeFrom(
	messages: readonly AgentMessage[],
	streamed: string,
): RunOutcome {
	const terminal = latestAssistant(messages);
	let outputMessage: AgentMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && assistantText(message)) {
			outputMessage = message;
			break;
		}
	}
	const usage = messages.reduce<RunOutcome["usage"]>((total, message) => {
		if ((message.role !== "assistant" && message.role !== "toolResult") || !message.usage) return total;
		return addUsage(total, { ...message.usage, contextTokens: message.role === "assistant" ? message.usage.totalTokens : 0 });
	}, undefined);
	if (!terminal || terminal.role !== "assistant") {
		return { output: streamed, stopReason: "error", errorMessage: "child produced no assistant message", ...(usage ? { usage } : {}) };
	}
	const output = (outputMessage ? assistantText(outputMessage) : "") || streamed;
	const stopReason: RunOutcome["stopReason"] =
		terminal.stopReason === "stop"
			? "completed"
			: terminal.stopReason === "length"
				? "max-tokens"
				: terminal.stopReason === "aborted"
					? "aborted"
					: "error";
	const unsupportedReason = stopReason === "error" && terminal.stopReason !== "error"
		? `child stopped with non-final reason ${terminal.stopReason}`
		: undefined;
	return {
		output,
		stopReason,
		...(terminal.errorMessage || unsupportedReason
			? { errorMessage: terminal.errorMessage ?? unsupportedReason }
			: {}),
		usage,
	};
}

class PiSdkChildDriver implements ChildDriver {
	private readonly session: AgentSession;
	private readonly noticeState: { received: number; consumed: number };
	private readonly extensionErrors: string[];
	private currentActivity = "idle";
	private runAbort?: AbortController;
	private disposal?: Promise<void>;
	private readonly noticeIds = new Set<string>();

	constructor(session: AgentSession, noticeState: { received: number; consumed: number }, extensionErrors: string[]) {
		this.session = session;
		this.noticeState = noticeState;
		this.extensionErrors = extensionErrors;
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get isRunning(): boolean {
		return this.runAbort !== undefined || this.session.isStreaming;
	}

	get activity(): string {
		return this.currentActivity;
	}

	subscribeActivity(listener: () => void): () => void {
		return this.session.subscribe((event) => {
			const previous = this.currentActivity;
			if (event.type === "tool_execution_start")
				this.currentActivity = `tool: ${event.toolName}`;
			else if (event.type === "message_update") this.currentActivity = "responding";
			else if (event.type === "auto_retry_start") this.currentActivity = "retrying";
			else if (event.type === "compaction_start") this.currentActivity = "compacting";
			else if (event.type === "agent_start") this.currentActivity = "working";
			else if (event.type === "agent_settled") this.currentActivity = "idle";
			if (this.currentActivity !== previous) listener();
		});
	}

	receiveNotice(notice: ParentNotice): void {
		this.receiveNotices([notice]);
	}

	receiveNotices(notices: ParentNotice[]): void {
		notices = notices.filter((notice) => !this.noticeIds.has(notice.messageId));
		if (!notices.length) return;
		for (const notice of notices) this.noticeIds.add(notice.messageId);
		this.noticeState.received++;
		if (notices.some((notice) => notice.priority === "urgent" || notice.priority === "action-required")) getWorkCoordinator(this.session.sessionId)?.cancel("urgent-notice");
		void this.session.sendCustomMessage({
			customType: "pi-subagents/notice",
			content: noticeBatchContent(notices),
			display: true,
			details: noticeBatch(notices),
		}, { deliverAs: "steer", triggerTurn: false }).catch(() => {
			for (const notice of notices) this.noticeIds.delete(notice.messageId);
			// The individual durable receipts remain replayable; never emit an
			// unhandled rejection from the SDK's asynchronous append API.
			this.currentActivity = "notice delivery failed; durable receipt retained";
		});
	}

	async prompt(message: string): Promise<RunOutcome> {
		if (this.extensionErrors.length) throw new Error(`Child extension lifecycle failed: ${this.extensionErrors.join("; ")}`);
		const abort = this.runAbort = new AbortController();
		const finalized: AgentMessage[] = [];
		const priorEntries = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
		let streamed = "";
		const unsubscribe = this.session.subscribe((event) => {
			if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "toolResult"))
				finalized.push(event.message);
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			)
				streamed += event.assistantMessageEvent.delta;
		});
		try {
			let prompt = message;
			while (true) {
				const start = finalized.length;
				await this.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
				if (this.extensionErrors.length) break;
				const messages = finalized.slice(start);
				const lastAssistant = latestAssistant(messages);
				const waitResult = [...messages].reverse().find((item) => item.role === "toolResult" && item.toolName === "wait_for_work" && lastAssistant?.role === "assistant" && lastAssistant.content.some((block) => block.type === "toolCall" && block.id === item.toolCallId));
				const yielded = lastAssistant?.role === "assistant" && lastAssistant.stopReason === "toolUse" && waitResult?.role === "toolResult" && waitResult.details?.waiting === true;
				if (abort.signal.aborted) break;
				if (!yielded) {
					// triggerTurn:false notices arriving after the final provider
					// context are durable but were not seen by that response.
					if (this.noticeState.received > this.noticeState.consumed && lastAssistant?.role === "assistant" && lastAssistant.stopReason === "stop") {
						prompt = "Review the newly delivered child notices and continue the assigned task.";
						continue;
					}
					break;
				}
				const coordinator = getWorkCoordinator(this.session.sessionId);
				if (!coordinator) throw new Error("Explicit child wait lost its session coordinator");
				this.currentActivity = "waiting for explicit event";
				await coordinator?.untilReady(abort.signal);
				if (abort.signal.aborted) break;
				prompt = "The explicit wait has ended. Review the delivered event and continue the assigned task.";
			}
			const outcome = outcomeFrom(finalized, streamed);
			if (this.extensionErrors.length) {
				outcome.stopReason = "error";
				outcome.errorMessage = `Child extension lifecycle failed: ${this.extensionErrors.join("; ")}`;
			}
			if (abort.signal.aborted) { outcome.stopReason = "aborted"; delete outcome.errorMessage; }
			for (const entry of this.session.sessionManager.getEntries()) {
				if (!priorEntries.has(entry.id) && (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
					outcome.usage = addUsage(outcome.usage, { ...entry.usage, contextTokens: 0 });
			}
			return outcome;
		} catch (error) {
			if (!abort.signal.aborted) throw error;
			return { ...outcomeFrom(finalized, streamed), stopReason: "aborted", errorMessage: undefined };
		} finally {
			this.runAbort = undefined;
			unsubscribe();
		}
	}

	interrupt(): void {
		this.runAbort?.abort();
		getWorkCoordinator(this.session.sessionId)?.cancel("child-interrupted");
		void this.session.abort();
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.runAbort?.abort();
		this.disposal = (async () => {
			try { await this.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { releaseWorkCoordinator(this.session.sessionId); this.session.dispose(); }
		})();
		return this.disposal;
	}
}

/** Pi 0.85.1 in-process provider. Runtime queues own tasks; this driver owns explicit event waits. */
export class PiSdkDriverFactory implements ChildDriverFactory {
	private readonly host: RuntimeHost;

	constructor(host: RuntimeHost) {
		this.host = host;
	}

	private createModelRuntime(signal: AbortSignal): Promise<ModelRuntime> {
		return ModelRuntime.create({
			signal,
			authPath: join(this.host.agentDir, "auth.json"),
			modelsPath: join(this.host.agentDir, "models.json"),
		});
	}

	async open(input: Parameters<ChildDriverFactory["open"]>[0]): Promise<ChildDriver> {
		input.signal.throwIfAborted();
		const model = this.host.resolveModel(input.descriptor.model);
		if (!model)
			throw new Error(
				`cannot restore child model ${input.descriptor.model.provider}/${input.descriptor.model.id}`,
			);
		// Each activation gets current credential and provider state. Sharing one
		// ModelRuntime across durable children leaves OAuth state stale after the
		// parent refreshes or replaces credentials.
		const modelRuntime = await this.createModelRuntime(input.signal);
		await this.host.prepareModelRuntime?.(input.descriptor.model, modelRuntime, input.signal);
		const provider = modelRuntime.getProvider(input.descriptor.model.provider);
		const boundProvider = provider && bindChildProvider(provider, input.descriptor.childSessionId);
		if (boundProvider) modelRuntime.registerNativeProvider(boundProvider);
		input.signal.throwIfAborted();
		const projectTrusted = input.descriptor.projectTrusted && this.host.isProjectTrusted();
		const settingsManager = SettingsManager.create(
			input.descriptor.cwd,
			this.host.agentDir,
			{ projectTrusted },
		);
		const toolInfo = this.host.getToolInfo?.();
		const customTools = [...input.customTools];
		// SDK hosts without source metadata may still supply their own child-bound
		// definitions. Normal extension sessions reconstruct the actual providers.
		if (!toolInfo && input.descriptor.toolNames.includes("todo_write")
			&& !customTools.some((tool) => tool.name === "todo_write")) {
			customTools.push(createChildTodoTool(input.sessionManager));
		}
		const customToolNames = customTools.map((tool) => tool.name);
		// Absence from getAllTools can mean an explicit SDK exclusion, not a
		// child-only capability. Only the caller may declare intrinsic tools.
		const childOnlyTools = (input.intrinsicToolNames ?? (!toolInfo ? customToolNames : []))
			.filter((name) => customToolNames.includes(name));
		const fallbackHelpers = !toolInfo
			? ["wait_for_work", "cancel_work_wait", ...(input.descriptor.toolNames.includes("read") ? ["read_artifact", "inspect_files"] : [])]
			: [];
		const enabledTools = () => [...new Set([
			...(this.host.getActiveToolNames?.() ?? input.descriptor.toolNames),
			...childOnlyTools, ...fallbackHelpers,
		])];
		const inheritedExtensions = toolInfo ? await loadChildToolExtensions({
			tools: toolInfo,
			handledToolNames: [...customToolNames, "wait_for_work", "cancel_work_wait"],
			signal: input.signal,
			projectTrusted,
			getFlag: this.host.getFlag ? (name) => this.host.getFlag!(name) : undefined,
		}) : [];
		const localDenied = new Set<string>();
		const extensionErrors: string[] = [];
		let factoryFailure: unknown;
		const checkProvider = () => {
			if (input.descriptor.model.provider === "openai-codex"
				&& modelRuntime.getProvider(input.descriptor.model.provider) !== boundProvider) {
				throw new Error("A child tool extension replaced the required Codex Wire provider.");
			}
		};
		const noticeState = { received: 0, consumed: 0 };
		const loader = new DefaultResourceLoader({
			cwd: input.descriptor.cwd,
			agentDir: this.host.agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				{ name: "work-coordination", factory: (pi) => {
					ensureWorkCoordination(pi, { child: true });
					pi.on("context", () => { noticeState.consumed = noticeState.received; });
				} },
				...inheritedExtensions.map((extension) => ({ name: extension.name, factory: async (pi: ExtensionAPI) => {
					const factory = typeof extension === "function" ? extension : extension.factory;
					const setActiveTools: ExtensionAPI["setActiveTools"] = (names) => {
						const selected = new Set(names);
						for (const name of pi.getActiveTools()) if (!selected.has(name)) localDenied.add(name);
						for (const name of selected) localDenied.delete(name);
						pi.setActiveTools(names.filter((name) => enabledTools().includes(name)));
					};
					try {
						await factory(new Proxy(pi, { get(target, property, receiver) {
							return property === "setActiveTools" ? setActiveTools : Reflect.get(target, property, receiver);
						} }));
					} catch (error) {
						// Keep registered shutdown hooks until the child runner can
						// release partial initialization with a real child context.
						factoryFailure = error;
					}
				} })),
				...(!toolInfo ? [{ name: "output-budget", factory: outputBudget }] : []),
				{ name: "request-tracing", factory: requestTracing },
				{ name: "parent-tool-selection", factory: (pi) => {
					const syncTools = () => {
						checkProvider();
						const available = new Set(pi.getAllTools().map((tool) => tool.name));
						pi.setActiveTools(extensionErrors.length ? [] : enabledTools().filter((name) => available.has(name) && !localDenied.has(name)));
					};
					pi.on("session_start", syncTools);
					pi.on("before_agent_start", syncTools);
					pi.on("context", syncTools);
					pi.on("before_provider_headers", checkProvider);
					pi.on("tool_call", (event) => {
						checkProvider();
						if (extensionErrors.length) return { block: true, reason: `Child extension lifecycle failed: ${extensionErrors.join("; ")}` };
						if (!enabledTools().includes(event.toolName)) {
							return { block: true, reason: `Tool "${event.toolName}" is not enabled in the parent session.` };
						}
						if (localDenied.has(event.toolName)) {
							return { block: true, reason: `Tool "${event.toolName}" is disabled by a child extension policy.` };
						}
					});
				} },
			],
			noThemes: true,
			appendSystemPromptOverride: (base) => [
				...base,
				childSystemContext(input.descriptor.mode),
			],
		});
		const cleanupUnbound = async () => {
			const loaded = loader.getExtensions();
			const runner = new ExtensionRunner(loaded.extensions, loaded.runtime,
				input.descriptor.cwd, input.sessionManager, new ModelRegistry(modelRuntime));
			runner.setUIContext(undefined, "json");
			try { await runner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { runner.invalidate(); releaseWorkCoordinator(input.descriptor.childSessionId); }
		};
		let session: AgentSession;
		try {
			await loader.reload();
			input.signal.throwIfAborted();
			if (factoryFailure) throw factoryFailure;
			const loadErrors = loader.getExtensions().errors;
			if (loadErrors.length) throw new Error(`Cannot load child tool extensions: ${loadErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
			({ session } = await createAgentSession({
			cwd: input.descriptor.cwd,
			agentDir: this.host.agentDir,
			model,
			thinkingLevel: input.descriptor.thinkingLevel,
			modelRuntime,
			settingsManager,
			resourceLoader: loader,
			sessionManager: input.sessionManager,
			customTools,
			// `tools` is an immutable SDK allowlist, not merely initial selection.
			// Keep the registry available and enforce the live parent selection
			// through the session's public active-tool API and tool-call gate.
			noTools: "builtin",
			}));
		} catch (error) {
			await cleanupUnbound();
			throw error;
		}
		const driver = new PiSdkChildDriver(session, noticeState, extensionErrors);
		try {
			session.setActiveToolsByName(enabledTools());
			await session.bindExtensions({ mode: "json", onError: (error) => {
				if (extensionErrors.length < 16) extensionErrors.push(`${error.extensionPath}: ${error.error}`);
			} });
			checkProvider();
			if (extensionErrors.length) throw new Error(`Child extension lifecycle failed: ${extensionErrors.join("; ")}`);
			const available = new Set(session.getAllTools().map((tool) => tool.name));
			const missing = enabledTools().filter((name) => !available.has(name));
			if (missing.length) throw new Error(`Parent tools could not be recreated in the child: ${missing.join(", ")}`);
		} catch (error) {
			await driver.dispose();
			throw error;
		}
		if (input.signal.aborted) {
			await driver.dispose();
			input.signal.throwIfAborted();
		}
		const recovered = undispatchedNotices(input.sessionManager.getBranch());
		if (recovered.length) driver.receiveNotices(recovered);
		return driver;
	}
}

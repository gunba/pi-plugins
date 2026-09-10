import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createChildTodoTool } from "./child-todo-tool.ts";
import { ensureWorkCoordination, getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { releaseWorkCoordinator } from "../../pi-work-coordination/core.ts";
import { noticeBatch, noticeBatchContent } from "./notice-batcher.ts";
import outputBudget from "../../pi-output-budget/extensions/index.ts";
import requestTracing from "../../pi-codex-wire/extensions/request-trace.ts";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	ChildDriver,
	ChildDriverFactory,
	RunOutcome,
	RuntimeHost,
	ParentNotice,
} from "./subagent-runtime.ts";
import { addUsage, CHILD_BUILTIN_TOOL_NAMES, undispatchedNotices } from "./subagent-runtime.ts";

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

const CHILD_CONTEXT = `You are a delegated subagent. Your permission and tool scope were fixed when you were started and cannot be widened from inside this session. Work independently in the shared working directory. Do not ask the user interactive questions; report blocked work or assumptions to your direct parent. Background children continue after you start them.`;
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
	private currentActivity = "idle";
	private runAbort?: AbortController;
	private disposal?: Promise<void>;
	private readonly noticeIds = new Set<string>();

	constructor(session: AgentSession, noticeState: { received: number; consumed: number }) {
		this.session = session;
		this.noticeState = noticeState;
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
		if (provider) modelRuntime.registerNativeProvider(bindChildProvider(provider, input.descriptor.childSessionId));
		input.signal.throwIfAborted();
		const settingsManager = SettingsManager.create(
			input.descriptor.cwd,
			this.host.agentDir,
			{ projectTrusted: input.descriptor.projectTrusted && this.host.isProjectTrusted() },
		);
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
				{ name: "output-budget", factory: outputBudget },
				{ name: "request-tracing", factory: requestTracing },
			],
			noThemes: true,
			appendSystemPromptOverride: (base) => [
				...base,
				childSystemContext(input.descriptor.mode),
			],
		});
		await loader.reload();
		input.signal.throwIfAborted();
		const customTools = [...input.customTools];
		if (
			input.descriptor.toolNames.includes("todo_write") &&
			!customTools.some((tool) => tool.name === "todo_write")
		) customTools.push(createChildTodoTool(input.sessionManager));
		const customToolNames = customTools.map((tool) => tool.name);
		const builtinToolNames = input.descriptor.toolNames.filter((name) =>
			CHILD_BUILTIN_TOOL_NAMES.has(name),
		);
		const { session } = await createAgentSession({
			cwd: input.descriptor.cwd,
			agentDir: this.host.agentDir,
			model,
			thinkingLevel: input.descriptor.thinkingLevel,
			modelRuntime,
			settingsManager,
			resourceLoader: loader,
			sessionManager: input.sessionManager,
			customTools,
			tools: [...new Set([...builtinToolNames, ...customToolNames, "wait_for_work", "cancel_work_wait", ...(input.descriptor.toolNames.includes("read") ? ["read_artifact", "inspect_files"] : [])])],
			excludeTools: [
				"ask_user",
				"ask_question",
				"question",
				"spawn_agent",
				"restart_agent",
				"wait_agent",
				"kill_agent",
			],
		});
		await session.bindExtensions({ mode: "json" });
		const driver = new PiSdkChildDriver(session, noticeState);
		if (input.signal.aborted) {
			await driver.dispose();
			input.signal.throwIfAborted();
		}
		const recovered = undispatchedNotices(input.sessionManager.getBranch());
		if (recovered.length) driver.receiveNotices(recovered);
		return driver;
	}
}

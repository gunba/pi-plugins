import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createChildTodoTool } from "./child-todo-tool.ts";
import type {
	ChildDriver,
	ChildDriverFactory,
	RunOutcome,
	RuntimeHost,
	ParentNotice,
} from "./subagent-runtime.ts";
import { addUsage, CHILD_BUILTIN_TOOL_NAMES, undispatchedNotices } from "./subagent-runtime.ts";

type AgentMessage = AgentSession["messages"][number];

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
	private currentActivity = "idle";

	constructor(session: AgentSession) {
		this.session = session;
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get isRunning(): boolean {
		return this.session.isStreaming;
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
		this.session.sendCustomMessage({
			customType: "pi-subagents/notice",
			content: notice.content,
			display: true,
			details: notice,
		}, { deliverAs: "steer", triggerTurn: false });
	}

	async prompt(message: string): Promise<RunOutcome> {
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
			await this.session.prompt(message, {
				expandPromptTemplates: false,
				source: "extension",
			});
			const outcome = outcomeFrom(finalized, streamed);
			for (const entry of this.session.sessionManager.getEntries()) {
				if (!priorEntries.has(entry.id) && (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
					outcome.usage = addUsage(outcome.usage, { ...entry.usage, contextTokens: 0 });
			}
			return outcome;
		} finally {
			unsubscribe();
		}
	}

	interrupt(): void {
		void this.session.abort();
	}

	dispose(): void {
		this.session.dispose();
	}
}

/** Pi 0.84.3 in-process provider. The runtime, not this driver, owns continuation. */
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
		input.signal.throwIfAborted();
		const settingsManager = SettingsManager.create(
			input.descriptor.cwd,
			this.host.agentDir,
			{ projectTrusted: input.descriptor.projectTrusted && this.host.isProjectTrusted() },
		);
		const loader = new DefaultResourceLoader({
			cwd: input.descriptor.cwd,
			agentDir: this.host.agentDir,
			settingsManager,
			noExtensions: true,
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
			tools: [...new Set([...builtinToolNames, ...customToolNames])],
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
		if (input.signal.aborted) {
			session.dispose();
			input.signal.throwIfAborted();
		}
		const driver = new PiSdkChildDriver(session);
		for (const notice of undispatchedNotices(input.sessionManager.getBranch())) driver.receiveNotice(notice);
		return driver;
	}
}

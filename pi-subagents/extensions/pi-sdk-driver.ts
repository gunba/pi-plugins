import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
	ChildDriver,
	ChildDriverFactory,
	RunOutcome,
	RuntimeHost,
} from "./subagent-runtime.ts";
import { CHILD_BUILTIN_TOOL_NAMES } from "./subagent-runtime.ts";

type AgentMessage = AgentSession["messages"][number];

const CHILD_CONTEXT = `You are a delegated subagent. Your permission and tool scope were fixed when you were started and cannot be widened from inside this session. Work independently in the shared working directory. Do not ask the user interactive questions; report blocked work or assumptions to your direct parent. Background children continue after you start them. Use report for self-contained findings that your direct parent should receive before your turn settles.`;

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
	if (!terminal || terminal.role !== "assistant") {
		return { output: streamed, stopReason: "error", errorMessage: "child produced no assistant message" };
	}
	const output = (outputMessage ? assistantText(outputMessage) : "") || streamed;
	const stopReason: RunOutcome["stopReason"] =
		terminal.stopReason === "length"
			? "max-tokens"
			: terminal.stopReason === "aborted"
				? "aborted"
				: terminal.stopReason === "error"
					? "error"
					: "completed";
	return {
		output,
		stopReason,
		...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
		usage: {
			input: terminal.usage.input,
			output: terminal.usage.output,
			contextTokens: terminal.usage.totalTokens,
			cost: terminal.usage.cost.total,
		},
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
			if (event.type === "tool_execution_start")
				this.currentActivity = `tool: ${event.toolName}`;
			else if (event.type === "message_update") this.currentActivity = "responding";
			else if (event.type === "auto_retry_start") this.currentActivity = "retrying";
			else if (event.type === "compaction_start") this.currentActivity = "compacting";
			else if (event.type === "agent_start") this.currentActivity = "working";
			else if (event.type === "agent_settled") this.currentActivity = "idle";
			listener();
		});
	}

	async prompt(message: string): Promise<RunOutcome> {
		const boundary = this.session.messages.length;
		let streamed = "";
		const unsubscribe = this.session.subscribe((event) => {
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
			return outcomeFrom(this.session.messages.slice(boundary), streamed);
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

/** Pi 0.84.2 in-process provider. The runtime, not this driver, owns continuation. */
export class PiSdkDriverFactory implements ChildDriverFactory {
	private modelRuntime?: Promise<ModelRuntime>;
	private readonly host: RuntimeHost;

	constructor(host: RuntimeHost) {
		this.host = host;
	}

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntime ??= ModelRuntime.create({
			authPath: join(this.host.agentDir, "auth.json"),
			modelsPath: join(this.host.agentDir, "models.json"),
		});
		return this.modelRuntime;
	}

	async open(input: Parameters<ChildDriverFactory["open"]>[0]): Promise<ChildDriver> {
		const model = this.host.resolveModel(input.descriptor.model);
		if (!model)
			throw new Error(
				`cannot restore child model ${input.descriptor.model.provider}/${input.descriptor.model.id}`,
			);
		const modelRuntime = await this.getModelRuntime();
		await this.host.prepareModelRuntime?.(input.descriptor.model, modelRuntime);
		const settingsManager = SettingsManager.create(
			input.descriptor.cwd,
			this.host.agentDir,
		);
		const loader = new DefaultResourceLoader({
			cwd: input.descriptor.cwd,
			agentDir: this.host.agentDir,
			settingsManager,
			noExtensions: true,
			noThemes: true,
			appendSystemPromptOverride: (base) => [...base, CHILD_CONTEXT],
		});
		await loader.reload();
		const customToolNames = input.customTools.map((tool) => tool.name);
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
			customTools: input.customTools,
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
		return new PiSdkChildDriver(session);
	}
}

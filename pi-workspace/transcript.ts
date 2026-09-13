import {
	AssistantMessageComponent,
	UserMessageComponent,
	ToolExecutionComponent,
	CustomMessageComponent,
	BashExecutionComponent,
	CompactionSummaryMessageComponent,
	BranchSummaryMessageComponent,
	getMarkdownTheme,
	type AgentSession,
	type AgentSessionEvent,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Image, type TUI } from "@earendil-works/pi-tui";

type Message = AgentSession["messages"][number];
export class Transcript {
	private tools = new Map<string, ToolExecutionComponent>();
	private assistant?: AssistantMessageComponent;
	private thinking = true;
	private expanded = false;
	private assistants: AssistantMessageComponent[] = [];
	private expandable: { setExpanded(value: boolean): void }[] = [];
	readonly container: Container;
	private tui: TUI;
	private session: AgentSession;
	private cwd: string;
	private theme: Theme;
	constructor(container: Container, tui: TUI, session: AgentSession, cwd: string, theme: Theme) {
		this.container = container;
		this.tui = tui;
		this.session = session;
		this.cwd = cwd;
		this.theme = theme;
		this.thinking = session.settingsManager.getHideThinkingBlock();
	}
	private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
		let component = this.tools.get(id);
		if (!component) {
			component = new ToolExecutionComponent(
				name,
				id,
				args,
				{ showImages: this.session.settingsManager.getShowImages() },
				this.session.getToolDefinition(name),
				this.tui,
				this.cwd,
			);
			component.setExpanded(this.expanded);
			this.tools.set(id, component);
			this.container.addChild(component);
		}
		return component;
	}
	private message(message: Message): void {
		const transforms = this.session.extensionRunner.getMarkdownTransformers();
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			this.container.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1, transforms));
			if (Array.isArray(message.content) && this.session.settingsManager.getShowImages())
				for (const part of message.content)
					if (part.type === "image")
						this.container.addChild(
							new Image(
								part.data,
								part.mimeType,
								{ fallbackColor: (text) => this.theme.fg("dim", text) },
								{ maxWidthCells: this.session.settingsManager.getImageWidthCells() },
							),
						);
		} else if (message.role === "assistant") {
			const component = new AssistantMessageComponent(
				message,
				this.thinking,
				getMarkdownTheme(),
				undefined,
				1,
				transforms,
			);
			this.assistants.push(component);
			this.container.addChild(component);
			this.assistant = component;
			for (const part of message.content)
				if (part.type === "toolCall") this.tool(part.id, part.name, part.arguments);
		} else if (message.role === "toolResult") {
			const tool = this.tool(message.toolCallId, message.toolName, {});
			tool.setArgsComplete();
			tool.updateResult({
				content: message.content,
				details: message.details,
				isError: message.isError,
			});
		} else if (message.role === "custom") {
			if (message.display)
				this.container.addChild(
					new CustomMessageComponent(
						message,
						this.session.extensionRunner.getMessageRenderer(message.customType),
						getMarkdownTheme(),
						1,
					),
				);
		} else if (message.role === "compactionSummary")
			this.container.addChild(new CompactionSummaryMessageComponent(message, getMarkdownTheme()));
		else if (message.role === "branchSummary")
			this.container.addChild(new BranchSummaryMessageComponent(message, getMarkdownTheme()));
		else if (message.role === "bashExecution") {
			const component = new BashExecutionComponent(
				message.command,
				this.tui,
				message.excludeFromContext,
			);
			component.appendOutput(message.output);
			component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
			component.setExpanded(this.expanded);
			this.container.addChild(component);
			this.expandable.push(component);
		}
	}
	entry(entry: SessionEntry): void {
		if (entry.type === "message") this.message(entry.message);
		else if (entry.type === "compaction")
			this.message({
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: Date.parse(entry.timestamp),
			});
		else if (entry.type === "branch_summary")
			this.message({
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: Date.parse(entry.timestamp),
			});
		else if (entry.type === "custom_message")
			this.message({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: Date.parse(entry.timestamp),
			});
		else if (entry.type === "custom") {
			const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
			if (renderer) {
				const content = new Container();
				const setExpanded = (expanded: boolean) => {
					content.clear();
					const component = renderer(entry, { expanded }, this.theme);
					if (component) content.addChild(component);
				};
				setExpanded(this.expanded);
				this.container.addChild(content);
				this.expandable.push({ setExpanded });
			}
		}
	}
	restore(entries: SessionEntry[]): void {
		this.tools.clear();
		this.assistants = [];
		this.expandable = [];
		this.assistant = undefined;
		this.container.clear();
		for (const entry of entries) this.entry(entry);
		this.tui.requestRender();
	}
	event(event: AgentSessionEvent): void {
		if (event.type === "message_start") this.message(event.message);
		else if (event.type === "message_update" && event.message.role === "assistant") {
			this.assistant?.updateContent(event.message, true);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.assistant?.updateContent(event.message, false);
			for (const part of event.message.content)
				if (part.type === "toolCall")
					this.tool(part.id, part.name, part.arguments).setArgsComplete();
		} else if (event.type === "tool_execution_start")
			this.tool(event.toolCallId, event.toolName, event.args).markExecutionStarted();
		else if (event.type === "tool_execution_update")
			this.tools
				.get(event.toolCallId)
				?.updateResult({ ...event.partialResult, isError: false }, true);
		else if (event.type === "tool_execution_end")
			this.tools
				.get(event.toolCallId)
				?.updateResult({ ...event.result, isError: event.isError }, false);
		else if (event.type === "entry_appended" && event.entry.type !== "message")
			this.entry(event.entry);
		this.tui.requestRender();
	}
	toggleTools(): void {
		this.expanded = !this.expanded;
		for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
		for (const component of this.expandable) component.setExpanded(this.expanded);
		this.tui.requestRender();
	}
	setToolsExpanded(value: boolean): void {
		if (value !== this.expanded) this.toggleTools();
	}
	get toolsExpanded(): boolean {
		return this.expanded;
	}
	toggleThinking(): void {
		this.thinking = !this.thinking;
		for (const assistant of this.assistants) assistant.setHideThinkingBlock(this.thinking);
		this.tui.requestRender();
	}
	thinkingLabel(label?: string): void {
		for (const assistant of this.assistants) assistant.setHiddenThinkingLabel(label ?? "Thinking");
		this.tui.requestRender();
	}
}

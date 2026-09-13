import { basename, extname, resolve } from "node:path";
import { open } from "node:fs/promises";
import {
	AgentSessionRuntime,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAgentSessionFromServices,
	createEventBus,
	getAgentDir,
	SessionManager,
	SettingsManager,
	initTheme,
	getSelectListTheme,
	CustomEditor,
	TreeSelectorComponent,
	copyToClipboard,
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type EventBus,
	type ExtensionUIContext,
	type KeybindingsManager as PiKeys,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
	ProcessTerminal,
	TuiAltScreen,
	CombinedAutocompleteProvider,
	Text,
	setKeybindings,
	matchesKey,
	truncateToWidth,
	type Terminal,
	type EditorComponent,
	type EditorTheme,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { safeWorkText } from "../pi-work-ui/view.ts";
import { Reader, WorkspaceLayout, WorkspaceScroll } from "./views.ts";
import { WorkspaceKeys, workspaceTheme } from "./theme.ts";
import { WorkspaceUi } from "./ui.ts";
import { WorkspacePanels, type PanelSnapshot } from "./panels.ts";
import { Transcript } from "./transcript.ts";
import { toolPaths, fileLocation, MAX_FILE_BYTES } from "./files.ts";
import { WorkspaceTerminal } from "./terminal.ts";
import { WorkspaceHttp } from "./http.ts";
import { GitStatus } from "./git-status.ts";

const COMMANDS = {
	open: "Read a file: /open path[:line]",
	diff: "Review Git changes, or /diff path",
	files: "Browse workspace files",
	work: "Show extension work",
	panel: "Toggle the side pane, or /panel 40",
	find: "Search the open file",
	line: "Go to a line in the open file",
	attach: "Attach an image from disk",
	model: "Choose a model",
	thinking: "Choose reasoning effort",
	resume: "Open a saved session",
	new: "Start a new session",
	tree: "Navigate the session tree",
	fork: "Fork from a user message",
	import: "Import a session JSONL file",
	compact: "Compact with the configured Pi compaction handler",
	reload: "Reload Pi extensions and configuration",
	name: "Name this session",
	export: "Export this session as HTML",
	stats: "Session usage",
	help: "Workspace controls",
	quit: "Close this workspace",
};
type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];

export class WorkspaceApp {
	readonly tui: TuiAltScreen;
	theme = workspaceTheme();
	readonly keys: WorkspaceKeys;
	readonly editorTheme: EditorTheme;
	readonly reader: Reader;
	readonly layout: WorkspaceLayout;
	readonly ui: WorkspaceUi;
	readonly footerData: ReadonlyFooterDataProvider;
	editor: EditorComponent;
	transcript?: Transcript;
	panels?: WorkspacePanels;
	working = "Working";
	workingVisible = true;
	private editorFactory: EditorFactory;
	private autocomplete: AutocompleteProvider;
	private unsubscribe?: () => void;
	private inputRelease?: () => void;
	private closing = false;
	private closePromise?: Promise<void>;
	private resolveClosed!: () => void;
	readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});
	private notification = "";
	private toolArguments = new Map<string, { name: string; args: Record<string, unknown> }>();
	private images: { type: "image"; data: string; mimeType: string }[] = [];
	private panelSnapshot?: { sessionId: string; state: PanelSnapshot };
	private boundSessionId?: string;
	private modelSelectionRequired = false;
	private gitStatus?: GitStatus;
	private retired = new Set<Promise<void>>();
	private branchListeners = new Set<() => void>();
	onSettingsChanged?: () => void;
	readonly runtime: AgentSessionRuntime;
	readonly bus: EventBus;
	readonly agentDir: string;
	constructor(
		runtime: AgentSessionRuntime,
		bus: EventBus,
		agentDir: string,
		terminal: Terminal = new ProcessTerminal(),
	) {
		this.runtime = runtime;
		this.bus = bus;
		this.agentDir = agentDir;
		this.keys = new WorkspaceKeys(agentDir);
		setKeybindings(this.keys);
		initTheme(runtime.services.settingsManager.getTheme(), false);
		const surface = new WorkspaceTerminal(terminal);
		this.tui = new TuiAltScreen(surface, true, undefined, {
			copySelection: async (text) => {
				await copyToClipboard(text);
				return true;
			},
		});
		this.reader = new Reader(this.theme, () => this.tui.requestRender());
		this.layout = new WorkspaceLayout(this.tui, this.reader, this.theme);
		surface.onResize = () => {
			if (this.tui.getFocusedComponent() === this.editor) this.layout.focusChat();
			else this.layout.reflow();
		};
		surface.onInput = (data) => {
			const focus = this.tui.getFocusedComponent();
			if (
				(focus === this.reader || focus instanceof WorkspaceScroll) &&
				(["pageUp", "pageDown", "home", "end"] as const).some((key) => matchesKey(data, key))
			) {
				focus.handleInput?.(data);
				this.tui.requestRender();
				return true;
			}
			return false;
		};
		this.editorTheme = {
			borderColor: (text) => this.theme.fg("borderAccent", text),
			selectList: getSelectListTheme(),
		};
		this.autocomplete = new CombinedAutocompleteProvider([], runtime.cwd);
		this.editor = this.makeEditor();
		this.layout.editor.addChild(this.editor);
		this.footerData = {
			getGitBranch: () => this.gitStatus?.value ?? null,
			getExtensionStatuses: () => this.ui.statuses,
			onBranchChange: (callback) => {
				this.branchListeners.add(callback);
				return () => {
					this.branchListeners.delete(callback);
				};
			},
			getAvailableProviderCount: () =>
				new Set(
					this.runtime.session.modelRuntime.getAvailableSnapshot().map((model) => model.provider),
				).size,
		};
		this.ui = new WorkspaceUi(this);
	}
	get session(): AgentSession {
		return this.runtime.session;
	}
	onDialogClose(): void {
		void this.panels?.resumeUpdates().catch((error) => this.notify(String(error), "warning"));
	}
	private makeEditor(): EditorComponent {
		const editor =
			this.editorFactory?.(this.tui, this.editorTheme, this.keys as unknown as PiKeys) ??
			new CustomEditor(this.tui, this.editorTheme, this.keys as unknown as PiKeys, { paddingX: 1 });
		if (editor instanceof CustomEditor)
			editor.onPasteImage = () => {
				void this.pasteClipboard().catch((error) => this.notify(String(error), "error"));
			};
		editor.onSubmit = (text) => {
			void this.submit(text).catch((error) => this.notify(String(error), "error"));
		};
		editor.setAutocompleteProvider?.(this.autocomplete);
		return editor;
	}
	setEditor(factory: EditorFactory): void {
		const text = this.editor.getText();
		const focused = this.tui.getFocusedComponent() === this.editor;
		this.editorFactory = factory;
		this.editor = this.makeEditor();
		this.editor.setText(text);
		this.layout.editor.clear();
		this.layout.editor.addChild(this.editor);
		if (focused) this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}
	getEditorFactory(): EditorFactory {
		return this.editorFactory;
	}
	getAutocomplete(): AutocompleteProvider {
		return this.autocomplete;
	}
	setAutocomplete(provider: AutocompleteProvider): void {
		this.autocomplete = provider;
		this.editor.setAutocompleteProvider?.(provider);
	}
	notify(text: string, type: "info" | "warning" | "error" = "info"): void {
		this.notification = this.theme.fg(
			type === "error" ? "error" : type === "warning" ? "warning" : "muted",
			safeWorkText(text),
		);
		this.renderStatus();
	}
	renderStatus(): void {
		if (this.closing) return;
		this.layout.status.clear();
		const session = this.session;
		const work = session.isCompacting
			? "Compacting"
			: session.isRetrying
				? `Retry ${session.retryAttempt}`
				: !session.isIdle
					? this.working
					: "";
		const queued = session.pendingMessageCount ? ` · ${session.pendingMessageCount} queued` : "";
		if ((work && this.workingVisible) || queued)
			this.layout.status.addChild(
				new Text(` ${this.ui.indicator} ${this.theme.fg("accent", `${work}${queued}`)}`, 0, 0),
			);
		if (this.notification) this.layout.status.addChild(new Text(` ${this.notification}`, 0, 0));
		if (this.ui.hasCustomFooter) {
			this.tui.requestRender();
			return;
		}
		this.layout.footer.clear();
		const usage = session.getContextUsage();
		this.layout.footer.addChild({
			invalidate() {},
			render: (width) => [
				truncateToWidth(
					this.theme.fg(
						"dim",
						` ${session.model?.name ?? "No model"} · ${session.thinkingLevel} · ${usage?.percent === null || usage?.percent === undefined ? "—" : `${usage.percent.toFixed(0)}%`} context${this.images.length ? ` · ${this.images.length} image(s)` : ""}`,
					),
					width,
				),
				truncateToWidth(this.theme.fg("dim", " F6 focus pane · Ctrl+O tools · /help"), width),
			],
		});
		this.tui.requestRender();
	}
	async start(startTerminal = true): Promise<void> {
		this.runtime.setBeforeSessionInvalidate(() => this.detach());
		this.runtime.setRebindSession(() => this.bind());
		if (startTerminal) this.tui.start();
		this.inputRelease = this.tui.addInputListener((data) => this.input(data));
		await this.bind();
		this.layout.focusChat();
		this.tui.setFocus(this.editor);
	}
	private detach(): void {
		if (this.panels && this.boundSessionId)
			this.panelSnapshot = { sessionId: this.boundSessionId, state: this.panels.snapshot() };
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.gitStatus) {
			const cleanup = this.gitStatus.dispose();
			this.retired.add(cleanup);
			void cleanup.then(() => this.retired.delete(cleanup));
			this.gitStatus = undefined;
		}
		this.panels?.dispose();
		this.panels = undefined;
		this.ui.reset();
		this.branchListeners.clear();
		this.toolArguments.clear();
	}
	private async bind(emitStart = true): Promise<void> {
		this.detach();
		this.onSettingsChanged?.();
		if (this.boundSessionId !== this.session.sessionId) this.images = [];
		this.boundSessionId = this.session.sessionId;
		this.modelSelectionRequired = Boolean(this.runtime.modelFallbackMessage);
		this.layout.tabs.clear();
		this.layout.heading.clear();
		this.panels = new WorkspacePanels(
			this.layout,
			this.reader,
			this.tui,
			this.theme,
			this.runtime.cwd,
			this.bus,
			(message) => this.notify(message),
			(title, items) => this.ui.context.select(title, items),
			(title) => this.ui.context.input(title),
		);
		this.panels.canPresent = () => !this.ui.hasDialog;
		this.gitStatus = new GitStatus(
			this.runtime.cwd,
			() => {
				for (const listener of this.branchListeners) listener();
				this.renderStatus();
			},
			(message) => this.notify(message, "warning"),
		);
		void this.gitStatus.start().catch((error) => this.notify(String(error), "warning"));
		this.transcript = new Transcript(
			this.layout.chat,
			this.tui,
			this.session,
			this.runtime.cwd,
			this.theme,
		);
		this.setEditor(undefined);
		this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
		if (emitStart)
			await this.session.bindExtensions({
				mode: "tui",
				uiContext: this.ui.context,
				onError: (error) => this.notify(error.error, "error"),
				abortHandler: () => {
					void this.interrupt();
				},
				shutdownHandler: () => {
					void this.close();
				},
				commandContextActions: {
					waitForIdle: () => this.session.waitForIdle(),
					newSession: (options) => this.runtime.newSession(options),
					fork: (id, options) => this.runtime.fork(id, options),
					navigateTree: (id, options) => this.navigateTree(id, options),
					switchSession: (path, options) => this.runtime.switchSession(path, options),
					reload: () => this.reload(),
				},
			});
		this.transcript.restore(this.session.sessionManager.getBranch());
		if (this.panelSnapshot?.sessionId === this.session.sessionId)
			await this.panels.restore(this.panelSnapshot.state);
		const commands = [
			...Object.entries(COMMANDS).map(([name, description]) => ({ name, description })),
			...this.session.extensionRunner
				.getRegisteredCommands()
				.map((command) => ({ name: command.name, description: command.description })),
			...this.session.resourceLoader
				.getSkills()
				.skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description })),
			...this.session.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
			})),
		];
		this.setAutocomplete(
			this.ui.decorateAutocomplete(new CombinedAutocompleteProvider(commands, this.runtime.cwd)),
		);
		this.layout.transcript.scrollToEnd();
		this.renderStatus();
		this.tui.terminal.setTitle(
			`Pi Workspace · ${this.session.sessionName ?? basename(this.runtime.cwd)}`,
		);
		for (const diagnostic of this.runtime.diagnostics)
			this.notify(diagnostic.message, diagnostic.type === "error" ? "error" : "warning");
		if (this.runtime.modelFallbackMessage)
			this.notify(
				`${this.runtime.modelFallbackMessage} Choose /model before sending a prompt.`,
				"warning",
			);
	}
	private onEvent(event: AgentSessionEvent): void {
		this.transcript?.event(event);
		if (event.type === "tool_execution_start")
			this.toolArguments.set(event.toolCallId, {
				name: event.toolName,
				args: event.args as Record<string, unknown>,
			});
		if (event.type === "tool_execution_end") {
			const tool = this.toolArguments.get(event.toolCallId);
			this.toolArguments.delete(event.toolCallId);
			if (tool && !event.isError && this.panels?.follow) {
				const paths = toolPaths(tool.name, tool.args, this.runtime.cwd);
				if (paths[0])
					void this.panels
						.followFiles(
							paths,
							tool.name !== "read",
							typeof tool.args.offset === "number" ? tool.args.offset : undefined,
						)
						.catch((error) => this.notify(String(error), "warning"));
			}
		}
		if (event.type === "auto_retry_start")
			this.notify(
				`Retrying in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
				"warning",
			);
		if (event.type === "compaction_end" && event.errorMessage)
			this.notify(event.errorMessage, "error");
		if (event.type === "session_info_changed")
			this.tui.terminal.setTitle(`Pi Workspace · ${event.name ?? basename(this.runtime.cwd)}`);
		this.renderStatus();
	}
	private input(data: string): { consume: true } | undefined {
		if (this.closing) return { consume: true };
		if (this.ui.hasDialog) return;
		const focus = this.tui.getFocusedComponent();
		const editorFocus = focus === this.editor;
		const readerFocus = focus === this.reader;
		if (matchesKey(data, "f6")) {
			if (editorFocus) {
				this.layout.show();
				this.tui.setFocus(
					this.layout.content.children.includes(this.layout.readerScroll)
						? this.reader
						: (this.layout.content.children[0] ?? this.editor),
				);
			} else {
				this.layout.focusChat();
				this.tui.setFocus(this.editor);
			}
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "alt+right")) {
			this.layout.resize(this.layout.widthPercent + 5);
			return { consume: true };
		}
		if (matchesKey(data, "alt+left")) {
			this.layout.resize(this.layout.widthPercent - 5);
			return { consume: true };
		}
		if (!editorFocus && matchesKey(data, "escape")) {
			this.layout.focusChat();
			this.tui.setFocus(this.editor);
			return { consume: true };
		}
		for (const [key, shortcut] of this.session.extensionRunner.getShortcuts(
			this.keys.getEffectiveConfig(),
		)) {
			if (matchesKey(data, key)) {
				if (["alt+1", "alt+2", "alt+3", "alt+4"].includes(key)) this.panels?.select("work");
				void Promise.resolve()
					.then(() => shortcut.handler(this.session.extensionRunner.createContext()))
					.catch((error) => this.notify(String(error), "error"));
				return { consume: true };
			}
		}
		if (!editorFocus && !readerFocus) return;
		if (
			editorFocus &&
			this.editor instanceof CustomEditor &&
			this.editor.isShowingAutocomplete() &&
			matchesKey(data, "escape")
		)
			return;
		const action = (fn: () => void | Promise<unknown>) => {
			void Promise.resolve()
				.then(fn)
				.catch((error) => this.notify(String(error), "error"));
			return { consume: true } as const;
		};
		if (matchesKey(data, "escape"))
			return action(async () => {
				if (readerFocus) this.tui.setFocus(this.editor);
				else await this.interrupt();
			});
		if (this.keys.matches(data, "app.clear"))
			return action(() => {
				if (this.editor.getText()) this.editor.setText("");
				else if (!this.session.isIdle) return this.interrupt();
				else return this.close();
			});
		if (this.keys.matches(data, "app.exit") && !this.editor.getText())
			return action(() => this.close());
		if (this.keys.matches(data, "app.tools.expand"))
			return action(() => this.transcript?.toggleTools());
		if (this.keys.matches(data, "app.thinking.toggle"))
			return action(() => this.transcript?.toggleThinking());
		if (this.keys.matches(data, "app.model.select")) return action(() => this.model());
		if (this.keys.matches(data, "app.model.cycleForward"))
			return action(() => this.session.cycleModel());
		if (this.keys.matches(data, "app.model.cycleBackward"))
			return action(() => this.session.cycleModel("backward"));
		if (this.keys.matches(data, "app.thinking.cycle"))
			return action(() => {
				this.session.cycleThinkingLevel();
				this.renderStatus();
			});
		if (this.keys.matches(data, "app.message.followUp") && editorFocus)
			return action(() => this.submit(this.editor.getText(), true));
		if (this.keys.matches(data, "app.session.resume")) return action(() => this.resume());
		if (this.keys.matches(data, "app.session.new"))
			return action(async () => {
				await this.idle();
				await this.runtime.newSession();
			});
		if (this.keys.matches(data, "app.session.tree")) return action(() => this.tree());
		if (readerFocus && data === "/") return action(() => this.panels?.find());
		if (readerFocus && data === "g") return action(() => this.panels?.goTo());
	}
	async interrupt(): Promise<void> {
		const queued = this.session.clearQueue();
		this.session.abortCompaction();
		this.session.abortBranchSummary();
		this.session.abortRetry();
		this.session.abortBash();
		await this.session.abort();
		const restored = [...queued.steering, ...queued.followUp].join("\n\n");
		if (restored)
			this.editor.setText([this.editor.getText(), restored].filter(Boolean).join("\n\n"));
		this.renderStatus();
	}
	private async idle(): Promise<void> {
		if (!this.session.isIdle) throw Error("Wait for the current operation or press Escape first.");
	}
	async submit(text: string, followUp = false): Promise<void> {
		if (!text.trim()) return;
		const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (
			command &&
			!Object.hasOwn(COMMANDS, command[1]!) &&
			!this.session.extensionRunner.getCommand(command[1]!) &&
			!this.session.promptTemplates.some((template) => template.name === command[1]) &&
			!command[1]!.startsWith("skill:")
		)
			throw Error(`Unknown workspace command /${command[1]}. Use /help for available commands.`);
		this.notification = "";
		if (command && Object.hasOwn(COMMANDS, command[1]!)) {
			this.editor.setText("");
			try {
				await this.command(command[1]!, command[2] ?? "");
			} catch (error) {
				this.editor.setText(text);
				throw error;
			}
			this.renderStatus();
			return;
		}
		if (
			this.modelSelectionRequired &&
			!(command && this.session.extensionRunner.getCommand(command[1]!))
		)
			throw Error("The saved model could not be restored. Choose /model before sending a prompt.");
		const images = this.images;
		this.images = [];
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		try {
			await this.session.prompt(text, {
				source: "interactive",
				...(images.length ? { images } : {}),
				...(this.session.isStreaming ? { streamingBehavior: followUp ? "followUp" : "steer" } : {}),
			});
		} catch (error) {
			this.notify(String(error), "error");
		}
	}
	private async command(name: string, args: string): Promise<void> {
		switch (name) {
			case "open":
				if (!args) return this.panels!.browse();
				await this.panels!.open(args);
				return;
			case "diff":
				if (!args) return this.panels!.changes();
				await this.panels!.open(args, true);
				return;
			case "files":
				await this.panels!.browse(args ? fileLocation(args, this.runtime.cwd).path : undefined);
				return;
			case "work":
				this.panels!.select("work");
				return;
			case "panel":
				if (args) {
					if (!/^\d+$/.test(args)) throw Error("Use /panel 25–60, or /panel to toggle.");
					this.layout.resize(Number(args));
				} else this.layout.toggle();
				return;
			case "find":
				if (args) this.reader.search(args);
				else await this.panels!.find();
				return;
			case "line":
				if (args && /^\d+$/.test(args)) this.reader.goTo(Number(args));
				else await this.panels!.goTo();
				return;
			case "attach": {
				if (!args) throw Error("Use /attach path to a PNG, JPEG, GIF or WebP image.");
				const imagePath = fileLocation(args, this.runtime.cwd).path;
				const extension = extname(imagePath).slice(1).toLowerCase();
				const mime = (
					{
						png: "image/png",
						jpg: "image/jpeg",
						jpeg: "image/jpeg",
						gif: "image/gif",
						webp: "image/webp",
					} as Record<string, string>
				)[extension ?? ""];
				if (!mime) throw Error("Unsupported image format.");
				if (this.images.length >= 5) throw Error("Attach at most five images, each below 40 MiB.");
				const file = await open(imagePath, "r");
				let data: Buffer;
				try {
					const info = await file.stat();
					if (!info.isFile() || info.size > 20 * MAX_FILE_BYTES)
						throw Error("Choose an image file below 40 MiB.");
					const buffer = Buffer.alloc(20 * MAX_FILE_BYTES + 1);
					let size = 0;
					while (size < buffer.length) {
						const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
						if (!bytesRead) break;
						size += bytesRead;
					}
					if (size > 20 * MAX_FILE_BYTES) throw Error("Image grew beyond 40 MiB.");
					data = buffer.subarray(0, size);
				} finally {
					await file.close();
				}
				this.images.push({ type: "image", data: data.toString("base64"), mimeType: mime });
				return;
			}
			case "help":
				this.panels!.showText(
					"workspace/help",
					"Help",
					Object.entries(COMMANDS)
						.map(([key, value]) => `/${key}  ${value}`)
						.join("\n\n") +
						"\n\nReader: arrows / PgUp / PgDn · / search · n/N matches · [/] changes · g line\nPane: F6 focus · Alt+Left/Right resize · drag divider\nEnter: send or steer · Alt+Enter: follow-up · Escape: cancel",
				);
				return;
			case "stats":
				this.panels!.showText(
					"workspace/stats",
					"Usage",
					JSON.stringify(this.session.getSessionStats(), null, 2),
				);
				return;
			case "model":
				await this.idle();
				await this.model();
				return;
			case "thinking": {
				await this.idle();
				const levels = this.session.getAvailableThinkingLevels();
				const chosen = args || (await this.ui.context.select("Reasoning effort", levels));
				if (chosen && levels.includes(chosen as (typeof levels)[number]))
					this.session.setThinkingLevel(chosen as (typeof levels)[number]);
				else if (chosen) throw Error("This model does not support that reasoning effort.");
				return;
			}
			case "resume":
				await this.resume(args);
				return;
			case "new":
				await this.idle();
				await this.runtime.newSession();
				return;
			case "tree":
				await this.tree();
				return;
			case "fork": {
				await this.idle();
				const messages = this.session.getUserMessagesForForking();
				const choices = messages.map(
					(message) => `${message.entryId}  ${safeWorkText(message.text).slice(0, 90)}`,
				);
				const chosen = await this.ui.context.select("Fork from message", choices);
				if (chosen) await this.runtime.fork(messages[choices.indexOf(chosen)]!.entryId);
				return;
			}
			case "import":
				await this.idle();
				if (!args) throw Error("Use /import path.jsonl");
				await this.runtime.importFromJsonl(fileLocation(args, this.runtime.cwd).path);
				return;
			case "compact":
				await this.idle();
				await this.session.compact(args || undefined);
				return;
			case "reload":
				await this.reload();
				return;
			case "name":
				if (!args) throw Error("Use /name followed by a session name.");
				this.session.setSessionName(args);
				return;
			case "export":
				this.notify(
					`Exported ${await this.session.exportToHtml(args ? fileLocation(args, this.runtime.cwd).path : undefined)}`,
				);
				return;
			case "quit":
				await this.close();
				return;
		}
	}
	private async model(): Promise<void> {
		await this.idle();
		const models = this.session.modelRuntime.getAvailableSnapshot();
		const names = models.map((model) => `${model.provider}/${model.id}`);
		const chosen = await this.ui.context.select("Model", names);
		if (chosen) {
			await this.session.setModel(models[names.indexOf(chosen)]!);
			this.modelSelectionRequired = false;
		}
		this.renderStatus();
	}
	private async pasteClipboard(): Promise<void> {
		const clipboard = await import("@mariozechner/clipboard");
		if (clipboard.hasImage()) {
			if (this.images.length >= 5) throw Error("At most five images can be attached to a prompt.");
			const data = await clipboard.getImageBase64();
			if (data.length > 56 * 1024 * 1024) throw Error("Clipboard image exceeds 40 MiB.");
			this.images.push({ type: "image", data, mimeType: "image/png" });
			this.renderStatus();
		} else if (clipboard.hasText()) {
			this.editor.insertTextAtCursor?.(await clipboard.getText());
			this.tui.requestRender();
		}
	}
	private async resume(path?: string): Promise<void> {
		await this.idle();
		if (path) {
			await this.runtime.switchSession(fileLocation(path, this.runtime.cwd).path);
			return;
		}
		const sessions = await SessionManager.list(this.runtime.cwd);
		const names = sessions.map(
			(session) => `${session.name ?? session.firstMessage.slice(0, 65)} · ${session.id}`,
		);
		const chosen = await this.ui.context.select("Resume session", names);
		if (chosen) await this.runtime.switchSession(sessions[names.indexOf(chosen)]!.path);
	}
	private async tree(): Promise<void> {
		await this.idle();
		const manager = this.session.sessionManager;
		const id = await this.ui.context.custom<string | undefined>(
			(_tui, _theme, _keys, done) =>
				new TreeSelectorComponent(
					manager.getTree(),
					manager.getLeafId(),
					this.tui.terminal.rows,
					done,
					() => done(undefined),
				),
		);
		if (id) await this.navigateTree(id);
	}
	private async navigateTree(
		...args: Parameters<AgentSession["navigateTree"]>
	): ReturnType<AgentSession["navigateTree"]> {
		const result = await this.session.navigateTree(...args);
		if (!result.cancelled) {
			this.transcript!.restore(this.session.sessionManager.getBranch());
			if (result.editorText) this.editor.setText(result.editorText);
			this.renderStatus();
		}
		return result;
	}
	private async reload(): Promise<void> {
		await this.idle();
		this.keys.reload();
		await this.session.reload({ beforeSessionStart: () => this.bind(false) });
		this.renderStatus();
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = (async () => {
			await this.interrupt();
			this.closing = true;
			try {
				await this.runtime.dispose();
			} finally {
				this.detach();
				this.inputRelease?.();
				this.tui.stop();
				await Promise.all(this.retired);
				this.resolveClosed();
			}
		})();
		return this.closePromise;
	}
}

export interface LaunchOptions {
	cwd: string;
	agentDir: string;
	session?: string;
	continue?: boolean;
	memory?: boolean;
}
export function launchOptions(
	args: string[],
	cwd = process.cwd(),
	agentDir = getAgentDir(),
): LaunchOptions {
	const options: LaunchOptions = { cwd, agentDir };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (["--cwd", "--agent-dir", "--session"].includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw Error(`${arg} requires a value.`);
			if (arg === "--cwd") options.cwd = resolve(cwd, value);
			else if (arg === "--agent-dir") options.agentDir = resolve(cwd, value);
			else options.session = resolve(cwd, value);
		} else if (arg === "--continue" || arg === "-c") options.continue = true;
		else if (arg === "--no-session") options.memory = true;
		else throw Error(`Unknown option ${arg}. Use --help for workspace options.`);
	}
	if ([options.session, options.continue, options.memory].filter(Boolean).length > 1)
		throw Error("Choose one of --session, --continue or --no-session.");
	return options;
}

export async function main(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Pi Workspace\n\npi-workspace [--cwd path] [--session file.jsonl | --continue | --no-session] [--agent-dir path]\n\nPersistent code, diff and extension panes using the public Pi SDK.\nUses your existing Pi configuration. Start when the saved session is not open elsewhere.",
		);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw Error("Pi Workspace needs an interactive terminal.");
	const options = launchOptions(args);
	const bus = createEventBus();
	const http = new WorkspaceHttp();
	const factory: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		http.configure(settingsManager);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { eventBus: bus },
		});
		const failures = services.resourceLoader.getExtensions().errors;
		if (failures.length)
			throw Error(failures.map((failure) => `${failure.path}: ${failure.error}`).join("\n"));
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let runtime: AgentSessionRuntime | undefined;
	let app: WorkspaceApp | undefined;
	const quit = () => {
		void app?.close().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	};
	try {
		// Pi extensions and default session locations share this documented host
		// environment, including when an isolated --agent-dir was selected.
		process.env.PI_CODING_AGENT_DIR = options.agentDir;
		const manager = options.memory
			? SessionManager.inMemory(options.cwd)
			: options.session
				? SessionManager.open(options.session)
				: options.continue
					? SessionManager.continueRecent(options.cwd)
					: SessionManager.create(options.cwd);
		runtime = await createAgentSessionRuntime(factory, {
			cwd: manager.getCwd(),
			agentDir: options.agentDir,
			sessionManager: manager,
		});
		app = new WorkspaceApp(runtime, bus, options.agentDir);
		app.onSettingsChanged = () => http.configure(runtime!.services.settingsManager);
		process.once("SIGINT", quit);
		process.once("SIGTERM", quit);
		await app.start();
		await app.closed;
	} finally {
		process.removeListener("SIGINT", quit);
		process.removeListener("SIGTERM", quit);
		try {
			if (app) await app.close();
			else await runtime?.dispose();
		} finally {
			try {
				await http.dispose();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	}
}

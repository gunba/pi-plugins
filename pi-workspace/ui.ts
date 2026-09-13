import {
	ExtensionSelectorComponent,
	ExtensionInputComponent,
	ExtensionEditorComponent,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type KeybindingsManager as PiKeys,
	type Theme,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	type Component,
	type EditorComponent,
	type TUI,
	type TuiAltScreen,
	type EditorTheme,
	type OverlayHandle,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type { WorkspaceLayout } from "./views.ts";
import type { WorkspaceKeys } from "./theme.ts";
import type { Transcript } from "./transcript.ts";

type OwnedComponent = Component & { dispose?(): void };
type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
export interface UiOwner {
	tui: TuiAltScreen;
	layout: WorkspaceLayout;
	keys: WorkspaceKeys;
	theme: Theme;
	editorTheme: EditorTheme;
	editor: EditorComponent;
	transcript?: Transcript;
	working: string;
	workingVisible: boolean;
	notify(text: string, type?: "info" | "warning" | "error"): void;
	renderStatus(): void;
	setEditor(factory: EditorFactory): void;
	getEditorFactory(): EditorFactory;
	getAutocomplete(): AutocompleteProvider;
	setAutocomplete(provider: AutocompleteProvider): void;
	footerData: ReadonlyFooterDataProvider;
	onDialogClose(): void;
}

/** The SDK's documented UI adapter boundary; no InteractiveMode internals. */
export class WorkspaceUi {
	readonly context: ExtensionUIContext;
	readonly statuses = new Map<string, string>();
	private widgets = new Map<string, OwnedComponent>();
	private inputListeners = new Set<() => void>();
	private dialogs = new Set<() => void>();
	private footer?: OwnedComponent;
	private header?: OwnedComponent;
	private generation = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private frames = ["●"];
	private frame = 0;
	private indicatorTimer?: NodeJS.Timeout;
	get indicator(): string {
		return this.frames[this.frame % Math.max(1, this.frames.length)] ?? "";
	}
	get hasCustomFooter(): boolean {
		return this.footer !== undefined;
	}
	get hasDialog(): boolean {
		return this.dialogs.size > 0;
	}
	private autocompleteFactories: Parameters<ExtensionUIContext["addAutocompleteProvider"]>[0][] =
		[];
	decorateAutocomplete(provider: AutocompleteProvider): AutocompleteProvider {
		return this.autocompleteFactories.reduce((current, factory) => factory(current), provider);
	}
	private host: UiOwner;
	constructor(host: UiOwner) {
		this.host = host;
		const context: ExtensionUIContext = {
			select: (title, options, opts) =>
				this.dialog(
					(done) =>
						new ExtensionSelectorComponent(title, options, done, () => done(undefined), {
							tui: host.tui,
							timeout: opts?.timeout,
						}),
					opts,
				),
			confirm: async (title, message, opts) =>
				(await context.select(`${title}\n${message}`, ["Yes", "No"], opts)) === "Yes",
			input: (title, placeholder, opts) =>
				this.dialog(
					(done) =>
						new ExtensionInputComponent(title, placeholder, done, () => done(undefined), opts),
					opts,
				),
			notify: (message, type) => host.notify(message, type),
			onTerminalInput: (handler) => {
				const release = host.tui.addInputListener(handler);
				this.inputListeners.add(release);
				return () => {
					release();
					this.inputListeners.delete(release);
				};
			},
			setStatus: (key, text) => {
				if (text === undefined) this.statuses.delete(key);
				else this.statuses.set(key, text);
				this.renderWidgets();
				host.renderStatus();
			},
			setWorkingMessage: (message) => {
				host.working = message ?? "Working";
				host.renderStatus();
			},
			setWorkingVisible: (visible) => {
				host.workingVisible = visible;
				host.renderStatus();
			},
			setWorkingIndicator: (options) => {
				clearInterval(this.indicatorTimer);
				this.indicatorTimer = undefined;
				this.frames = options?.frames ?? ["●"];
				this.frame = 0;
				if (this.frames.length > 1) {
					this.indicatorTimer = setInterval(
						() => {
							this.frame++;
							host.renderStatus();
						},
						Math.max(40, options?.intervalMs ?? 100),
					);
					this.indicatorTimer.unref();
				}
				host.renderStatus();
			},
			setHiddenThinkingLabel: (label) => host.transcript?.thinkingLabel(label),
			setWidget: (
				key: string,
				content: string[] | ((tui: TUI, theme: Theme) => OwnedComponent) | undefined,
			) => {
				this.widgets.get(key)?.dispose?.();
				this.widgets.delete(key);
				if (content)
					this.widgets.set(
						key,
						Array.isArray(content)
							? new Text(content.join("\n"), 1, 0)
							: content(host.tui, host.theme),
					);
				this.renderWidgets();
			},
			setFooter: (factory) => {
				this.footer?.dispose?.();
				this.footer = factory?.(host.tui, host.theme, host.footerData);
				host.layout.footer.clear();
				if (this.footer) host.layout.footer.addChild(this.footer);
				else host.renderStatus();
			},
			setHeader: (factory) => {
				host.layout.header.clear();
				this.header?.dispose?.();
				this.header = factory?.(host.tui, host.theme);
				if (this.header) host.layout.header.addChild(this.header);
				host.tui.requestRender();
			},
			setTitle: (title) => host.tui.terminal.setTitle(title),
			custom: (factory, options) => this.custom(factory, options),
			pasteToEditor: (text) => {
				host.editor.insertTextAtCursor?.(text);
				host.tui.requestRender();
			},
			setEditorText: (text) => {
				host.editor.setText(text);
				host.tui.requestRender();
			},
			getEditorText: () => host.editor.getText(),
			editor: (title, prefill) =>
				this.dialog(
					(done) =>
						new ExtensionEditorComponent(
							host.tui,
							host.keys as unknown as PiKeys,
							title,
							prefill,
							done,
							() => done(undefined),
						),
				),
			addAutocompleteProvider: (factory) => {
				this.autocompleteFactories.push(factory);
				host.setAutocomplete(factory(host.getAutocomplete()));
			},
			setEditorComponent: (factory) => host.setEditor(factory),
			getEditorComponent: () => host.getEditorFactory(),
			get theme() {
				return host.theme;
			},
			getAllThemes: () => [{ name: host.theme.name ?? "workspace", path: undefined }],
			getTheme: (name) => (name === host.theme.name ? host.theme : undefined),
			setTheme: (theme) =>
				theme === host.theme || theme === host.theme.name
					? { success: true }
					: {
							success: false,
							error:
								"Workspace uses a fixed pane palette; native message rendering uses your saved Pi theme.",
						},
			getToolsExpanded: () => host.transcript?.toolsExpanded ?? false,
			setToolsExpanded: (value) => host.transcript?.setToolsExpanded(value),
		};
		this.context = context;
	}
	private renderWidgets(): void {
		this.host.layout.widgets.clear();
		for (const widget of this.widgets.values()) this.host.layout.widgets.addChild(widget);
		if (!this.widgets.size)
			this.host.layout.widgets.addChild(
				new Text(
					"No active extension work.\n\nGoals, tasks, subagents, parties and scheduled work appear here as they are created.",
					2,
					1,
				),
			);
		if (this.statuses.size)
			this.host.layout.widgets.addChild(new Text([...this.statuses.values()].join("\n"), 1, 1));
		this.host.tui.requestRender();
	}
	private dialog<T>(
		factory: (done: (value: T | undefined) => void) => OwnedComponent,
		options?: ExtensionUIDialogOptions,
	): Promise<T | undefined> {
		return this.custom((_tui, _theme, _keys, done) => {
			const component = factory(done);
			const abort = () => done(undefined);
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
			const timer = options?.timeout ? setTimeout(abort, options.timeout) : undefined;
			const dispose = component.dispose?.bind(component);
			// Own only this factory's component lifecycle, never a Pi runtime method.
			return {
				get focused() {
					return "focused" in component ? Boolean(component.focused) : false;
				},
				set focused(value: boolean) {
					if ("focused" in component) component.focused = value;
				},
				render: (width) => component.render(width),
				invalidate: () => component.invalidate(),
				handleInput: (data) => component.handleInput?.(data),
				handleMouse: (event) => component.handleMouse?.(event),
				dispose: () => {
					clearTimeout(timer);
					options?.signal?.removeEventListener("abort", abort);
					dispose?.();
				},
			};
		});
	}
	private custom<T>(
		factory: Parameters<ExtensionUIContext["custom"]>[0],
		options?: Parameters<ExtensionUIContext["custom"]>[1],
	): Promise<T> {
		const generation = this.generation;
		const result = this.queue.then(() =>
			generation === this.generation ? this.present<T>(factory, options) : (undefined as T),
		);
		this.queue = result.catch(() => {});
		return result;
	}
	private present<T>(
		factory: Parameters<ExtensionUIContext["custom"]>[0],
		options?: Parameters<ExtensionUIContext["custom"]>[1],
	): Promise<T> {
		const generation = this.generation;
		return new Promise<T>((resolve, reject) => {
			let component: OwnedComponent | undefined;
			let overlay: OverlayHandle | undefined;
			let finished = false;
			const previous = [...this.host.layout.content.children];
			const previousTabs = [...this.host.layout.tabs.children];
			const previousHeading = [...this.host.layout.heading.children];
			const focus = this.host.tui.getFocusedComponent();
			const cancel = () => done(undefined);
			const done = (value: unknown) => {
				if (finished) return;
				finished = true;
				this.dialogs.delete(cancel);
				overlay?.hide();
				component?.dispose?.();
				if (!options?.overlay && component && generation === this.generation) {
					this.host.layout.content.clear();
					for (const child of previous)
						this.host.layout.content.addChild(child, { basis: 0, grow: 1 });
					this.host.layout.tabs.clear();
					for (const child of previousTabs) this.host.layout.tabs.addChild(child);
					this.host.layout.heading.clear();
					for (const child of previousHeading) this.host.layout.heading.addChild(child);
				}
				if (generation === this.generation) this.host.tui.setFocus(focus ?? this.host.editor);
				this.host.tui.requestRender();
				resolve(value as T);
				if (generation === this.generation) this.host.onDialogClose();
			};
			this.dialogs.add(cancel);
			Promise.resolve()
				.then(() =>
					factory(this.host.tui, this.host.theme, this.host.keys as unknown as PiKeys, done),
				)
				.then((created) => {
					component = created;
					if (finished || generation !== this.generation) {
						component.dispose?.();
						done(undefined);
						return;
					}
					if (options?.overlay) {
						const source = options.overlayOptions;
						// Native overlay options are read during each render. Accessors keep
						// the documented dynamic options contract without replacing the handle.
						const live =
							typeof source === "function"
								? Object.fromEntries(
										[
											"width",
											"minWidth",
											"maxHeight",
											"anchor",
											"offsetX",
											"offsetY",
											"row",
											"col",
											"margin",
											"visible",
											"nonCapturing",
										].map((key) => [key, undefined]),
									)
								: source;
						if (typeof source === "function" && live)
							for (const key of Object.keys(live))
								Object.defineProperty(live, key, {
									enumerable: true,
									get: () => source()[key as keyof ReturnType<typeof source>],
								});
						overlay = this.host.tui.showOverlay(component, live);
						options.onHandle?.(overlay);
					} else {
						this.host.layout.show();
						this.host.layout.tabs.clear();
						this.host.layout.tabs.addChild(
							new Text(this.host.theme.fg("accent", " Workspace · Esc to return"), 0, 0),
						);
						this.host.layout.heading.clear();
						this.host.layout.content.clear();
						this.host.layout.content.addChild(component, { basis: 0, grow: 1 });
						this.host.tui.setFocus(component);
					}
					this.host.tui.requestRender();
				})
				.catch((error) => {
					if (finished) return;
					finished = true;
					this.dialogs.delete(cancel);
					overlay?.hide();
					component?.dispose?.();
					if (generation === this.generation) this.host.tui.setFocus(focus ?? this.host.editor);
					reject(error);
				});
		});
	}
	reset(): void {
		this.generation++;
		for (const cancel of [...this.dialogs]) cancel();
		clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.frames = ["●"];
		this.frame = 0;
		this.host.workingVisible = true;
		this.host.working = "Working";
		for (const release of this.inputListeners) release();
		this.inputListeners.clear();
		for (const widget of this.widgets.values()) widget.dispose?.();
		this.widgets.clear();
		this.host.layout.widgets.clear();
		this.footer?.dispose?.();
		this.footer = undefined;
		this.header?.dispose?.();
		this.header = undefined;
		this.host.layout.header.clear();
		this.autocompleteFactories = [];
		this.statuses.clear();
		this.renderWidgets();
	}
}

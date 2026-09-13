import { basename, dirname, relative } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { EventBus, Theme } from "@earendil-works/pi-coding-agent";
import { FileRepository, fileLocation, readDocument } from "./files.ts";
import { ActionBar, WorkspaceScroll, type Reader, type WorkspaceLayout } from "./views.ts";
import { WORKSPACE_DISCOVER, type WorkspaceApi } from "./api.ts";
import { safeWorkText } from "../pi-work-ui/view.ts";

export interface PanelSnapshot {
	active: string;
	follow: boolean;
	files: [string, { diff: boolean; previousPath?: string; scroll: number }][];
}

export class WorkspacePanels {
	readonly repository: FileRepository;
	private active = "work";
	private views = new Map<string, { title: string; component: Component & { dispose?(): void } }>();
	private files = new Map<string, { diff: boolean; previousPath?: string; scroll: number }>();
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private revision = 0;
	private closed = false;
	private release: () => void;
	follow = true;
	canPresent = () => true;
	private pending?: Parameters<WorkspacePanels["open"]>;
	private layout: WorkspaceLayout;
	private reader: Reader;
	private tui: TUI;
	private theme: Theme;
	readonly cwd: string;
	private notify: (message: string) => void;
	private choose: (title: string, items: string[]) => Promise<string | undefined>;
	private input: (title: string) => Promise<string | undefined>;
	constructor(
		layout: WorkspaceLayout,
		reader: Reader,
		tui: TUI,
		theme: Theme,
		cwd: string,
		bus: EventBus,
		notify: (message: string) => void,
		choose: (title: string, items: string[]) => Promise<string | undefined>,
		input: (title: string) => Promise<string | undefined>,
	) {
		this.layout = layout;
		this.reader = reader;
		this.tui = tui;
		this.theme = theme;
		this.cwd = cwd;
		this.notify = notify;
		this.choose = choose;
		this.input = input;
		this.repository = new FileRepository(cwd);
		const api: WorkspaceApi = {
			openFile: async (path, options) => {
				if (this.closed) return;
				await this.open(path, options?.diff, options?.line);
			},
			registerView: (id, title, factory) => {
				if (this.closed) return { show() {}, refresh() {}, dispose() {} };
				if (!id || id === "work" || this.files.has(id))
					throw Error("Choose a unique extension view ID.");
				const view = { title, component: factory(this.tui, this.theme) };
				this.views.get(id)?.component.dispose?.();
				this.views.set(id, view);
				if (this.active === id) this.select(id);
				const current = () => !this.closed && this.views.get(id) === view;
				return {
					show: () => {
						if (current()) this.select(id);
					},
					refresh: () => {
						if (current()) {
							view.component.invalidate();
							this.tui.requestRender();
						}
					},
					dispose: () => {
						if (!current()) return;
						this.views.delete(id);
						view.component.dispose?.();
						if (this.active === id) this.select("work");
						else this.tui.requestRender();
					},
				};
			},
		};
		this.release = bus.on(WORKSPACE_DISCOVER, (request) => {
			if (!this.closed && request && typeof request === "object")
				(request as { workspace?: WorkspaceApi }).workspace = api;
		});
		layout.tabs.addChild(
			new ActionBar(
				() => [
					{ label: "Work", selected: this.active === "work", action: () => this.select("work") },
					{
						label: "Files",
						action: () => void this.browse().catch((error) => notify(String(error))),
					},
					{
						label: "Changes",
						action: () => void this.changes().catch((error) => notify(String(error))),
					},
					{
						label: "⋯",
						action: () => void this.chooseTab().catch((error) => notify(String(error))),
					},
					...Array.from(this.files.keys()).map((path) => ({
						label: basename(path),
						selected: this.active === path,
						action: () =>
							void this.open(path, this.files.get(path)!.diff).catch((error) =>
								notify(String(error)),
							),
					})),
					...Array.from(this.views).map(([id, view]) => ({
						label: view.title,
						selected: this.active === id,
						action: () => this.select(id),
					})),
				],
				theme,
			),
		);
		this.select("work");
	}
	private saveScroll(): void {
		const file = this.files.get(this.active);
		if (file) file.scroll = this.layout.readerScroll.scrollTop;
	}
	showText(id: string, title: string, text: string): void {
		if (this.closed) return;
		this.views.get(id)?.component.dispose?.();
		this.views.set(id, {
			title,
			component: new WorkspaceScroll(new Text(text, 1, 1), { overscroll: "contain" }),
		});
		this.select(id);
	}
	snapshot(): PanelSnapshot {
		this.saveScroll();
		return {
			active: this.active,
			follow: this.follow,
			files: [...this.files].map(([path, state]) => [path, { ...state }]),
		};
	}
	async restore(snapshot: PanelSnapshot): Promise<void> {
		this.files = new Map(snapshot.files);
		this.follow = snapshot.follow;
		const state = this.files.get(snapshot.active);
		if (state) await this.open(snapshot.active, state.diff, undefined, state.previousPath);
		else this.select(this.views.has(snapshot.active) ? snapshot.active : "work");
	}
	select(id: string): void {
		if (this.closed || !this.canPresent()) return;
		if (id !== "work" && !this.views.has(id)) return;
		this.saveScroll();
		this.revision++;
		this.active = id;
		this.stopWatching();
		this.layout.show();
		this.layout.heading.clear();
		if (id === "work") {
			this.layout.heading.addChild(
				new Text(this.theme.fg("dim", " Extensions · Alt+1–4 expand sections"), 0, 0),
			);
			this.layout.showWork();
			if (this.tui.terminal.columns < 80) this.tui.setFocus(this.layout.workScroll);
		} else {
			const view = this.views.get(id);
			if (view) {
				this.layout.heading.addChild(new Text(safeWorkText(view.title), 1, 0));
				this.layout.showView(view.component);
				if (this.tui.terminal.columns < 80) this.tui.setFocus(view.component);
			}
		}
		this.tui.requestRender();
	}
	async open(
		value: string,
		diff = false,
		line?: number,
		previousPath?: string,
		background = false,
	): Promise<void> {
		if (this.closed) return;
		if (!this.canPresent()) {
			this.pending = [value, diff, line, previousPath, background];
			return;
		}
		const location = fileLocation(value, this.cwd);
		const targetLine = line ?? location.line;
		this.saveScroll();
		const generation = ++this.revision;
		const text = diff
			? await this.repository.diff(location.path, previousPath)
			: await readDocument(location.path).then((doc) =>
					doc.missing
						? "File does not exist."
						: doc.binary
							? "Binary file — a text preview is unavailable."
							: doc.text,
				);
		if (this.closed || generation !== this.revision) return;
		if (!this.canPresent()) {
			this.pending = [value, diff, line, previousPath, background];
			return;
		}
		const existing = this.files.get(location.path);
		if (!existing && this.files.size >= 8) this.files.delete(this.files.keys().next().value!);
		this.files.set(location.path, {
			diff,
			previousPath,
			scroll: existing?.diff === diff ? existing.scroll : 0,
		});
		this.active = location.path;
		this.layout.show(!background);
		this.layout.showReader();
		if (!background && this.tui.terminal.columns < 80) this.tui.setFocus(this.reader);
		this.reader.set(text, location.path, diff);
		if (targetLine > 1) this.reader.goTo(targetLine);
		else this.layout.readerScroll.reveal(this.files.get(location.path)!.scroll);
		this.layout.heading.clear();
		this.layout.heading.addChild(
			new Text(
				this.theme.fg(
					"muted",
					` ${safeWorkText(relative(this.cwd, location.path) || basename(location.path))}`,
				),
				0,
				0,
			),
		);
		this.layout.heading.addChild(
			new ActionBar(
				() => [
					{
						label: diff ? "Diff · HEAD" : "Read",
						selected: true,
						action: () =>
							void this.open(location.path, !diff, 1, previousPath).catch((e) =>
								this.notify(String(e)),
							),
					},
					{ label: this.reader.searchStatus || "Find", action: () => void this.find() },
					{ label: "Line", action: () => void this.goTo() },
					{
						label: this.follow ? "Following" : "Pinned",
						action: () => {
							this.follow = !this.follow;
							this.tui.requestRender();
						},
					},
					{
						label: "×",
						action: () => {
							this.files.delete(location.path);
							this.select("work");
						},
					},
				],
				this.theme,
			),
		);
		this.stopWatching();
		try {
			this.watcher = watch(dirname(location.path), (_event, name) => {
				if (name && String(name) !== basename(location.path)) return;
				clearTimeout(this.timer);
				this.timer = setTimeout(() => {
					if (this.active === location.path && !this.closed)
						void this.open(location.path, diff, undefined, previousPath, true).catch((e) =>
							this.notify(String(e)),
						);
				}, 180);
				this.timer.unref();
			});
			this.watcher.on("error", (error) => this.notify(`File watcher: ${error.message}`));
			this.watcher.unref();
		} catch (error) {
			this.notify(`File watcher: ${String(error)}`);
		}
		this.tui.requestRender();
	}
	async resumeUpdates(): Promise<void> {
		if (this.closed) return;
		if (!this.pending) {
			if (this.views.has(this.active)) this.select(this.active);
			else if (!this.files.has(this.active)) this.select("work");
			return;
		}
		const pending = this.pending;
		this.pending = undefined;
		await this.open(...pending);
	}
	async followFiles(paths: string[], diff: boolean, line?: number): Promise<void> {
		for (const path of paths.slice(0, 8).reverse()) {
			if (this.closed || !this.follow) return;
			await this.open(path, diff, line, undefined, true);
		}
	}
	async find(): Promise<void> {
		const query = await this.input("Find in file");
		if (query !== undefined) this.reader.search(query);
		this.tui.setFocus(this.reader);
	}
	async goTo(): Promise<void> {
		const line = await this.input("Go to line");
		if (line && /^\d+$/.test(line)) this.reader.goTo(Number(line));
		this.tui.setFocus(this.reader);
	}
	async browse(path = this.cwd): Promise<void> {
		const entries = await this.repository.directory(path);
		const labels = [
			"../",
			...entries.map(
				(entry, index) =>
					`${index + 1}  ${safeWorkText(basename(entry.path))}${entry.directory ? "/" : ""}`,
			),
		];
		const selected = await this.choose(`Files · ${safeWorkText(path)}`, labels);
		if (selected === undefined) return;
		if (selected === "../") return this.browse(dirname(path));
		const entry = entries[labels.indexOf(selected) - 1]!;
		if (entry.directory) return this.browse(entry.path);
		await this.open(entry.path);
	}
	async changes(): Promise<void> {
		const changes = await this.repository.changes();
		if (!changes.length) {
			this.notify("No Git changes in this workspace.");
			return;
		}
		const labels = changes.map(
			(change, index) =>
				`${index + 1}  ${change.status}  ${safeWorkText(relative(this.cwd, change.path))}`,
		);
		const selected = await this.choose("Git changes · HEAD → working tree", labels);
		if (selected === undefined) return;
		const change = changes[labels.indexOf(selected)]!;
		await this.open(change.path, true, 1, change.previousPath);
	}
	private async chooseTab(): Promise<void> {
		const tabs = [
			{ id: "work", label: "Work" },
			...Array.from(this.files, ([path, file]) => ({
				id: path,
				label: `${file.diff ? "Diff" : "Read"} · ${relative(this.cwd, path)}`,
			})),
			...Array.from(this.views, ([id, view]) => ({ id, label: view.title })),
		];
		const labels = tabs.map((tab, index) => `${index + 1}  ${safeWorkText(tab.label)}`);
		const chosen = await this.choose("Open views", labels);
		if (!chosen) return;
		const id = tabs[labels.indexOf(chosen)]!.id;
		if (this.files.has(id)) await this.open(id, this.files.get(id)!.diff);
		else this.select(id);
	}
	private stopWatching(): void {
		this.watcher?.close();
		this.watcher = undefined;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
	dispose(): void {
		this.closed = true;
		this.revision++;
		this.stopWatching();
		this.release();
		for (const view of this.views.values()) view.component.dispose?.();
		this.views.clear();
	}
}

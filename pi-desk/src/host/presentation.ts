import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	type ExtensionAPI,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	PRESENTATION_DISCOVER,
	type Presentation,
	type UiAnswer,
	type UiInteraction,
	type UiValue,
	type UiView,
	type UiDetails,
	type PresentationScope,
	type UiTranscriptSource,
	type UiTranscriptHandle,
	type UiMaintenance,
} from "../../../pi-ui/index.ts";
import type { InteractionSnapshot, PresentationSnapshot, ViewSnapshot } from "../shared/protocol.ts";
import { FEEDBACK_ENTRY, type Feedback } from "../shared/feedback.ts";

interface PendingInteraction {
	snapshot: InteractionSnapshot;
	finish: (answer: UiAnswer | null) => void;
}
interface PublishedView {
	snapshot: ViewSnapshot;
	actions: Record<string, (value: UiValue) => unknown | Promise<unknown>>;
}
const plain = (text: string) => stripVTControlCharacters(text);

/** One worker's presentation state. Browser connections never own interaction lifetimes. */
export class DeskPresentation implements Presentation {
	readonly version = 2;
	readonly capabilities: Presentation["capabilities"];
	generation = randomUUID();
	private views = new Map<string, PublishedView>();
	private actions = new Map<string, { label: string; generation: string }>();
	private actionErrors = new Map<string, string>();
	private viewRevision = 0;
	private batchDepth = 0;
	private batchChanged = false;
	private nextRevision: () => number;
	private scopes = new Map<string, { label: string; presentation: DeskPresentation; close: () => void }>();
	suspended = false;
	private maintenanceOwners = new Map<string, UiMaintenance>();
	registerMaintenance(owner: UiMaintenance): UiTranscriptHandle {
		if (this.retired) throw new Error("The presentation has closed.");
		const id = randomUUID(); this.maintenanceOwners.set(id, owner);
		return { id, close: () => { this.maintenanceOwners.delete(id); } };
	}
	inspectMaintenance(): void {
		const covered = new Set<string>();
		for (const owner of this.maintenanceOwners.values()) {
			owner.inspect(); for (const scope of owner.scopes()) covered.add(scope);
		}
		if ([...this.scopes.keys()].some(id => !covered.has(id)))
			throw new Error("A scoped session has no owning-driver maintenance checkpoint.");
	}
	async maintenance(id: string, action: "hold" | "restore" | "release"): Promise<void> {
		for (const owner of this.maintenanceOwners.values()) await owner[action](id);
	}
	setSuspended(value: boolean): void {
		this.suspended = value;
		for (const { presentation } of this.scopes.values()) presentation.setSuspended(value);
	}
	private retired = false;
	private uiRevision = 0;
	private presentationRevision = 0;
	private readonly transcripts = new Set<UiTranscriptHandle>();
	private readonly registerSource?: (source: UiTranscriptSource) => UiTranscriptHandle;
	private readonly command?: (name: string, args?: string) => Promise<void>;
	private interactions = new Map<string, PendingInteraction>();
	private settingOrigin = new AsyncLocalStorage<{ id: string; title: string; live: () => boolean }>();
	private statuses: Record<string, string> = {};
	private notifications: PresentationSnapshot["notifications"] = [];
	private recordFeedback: (feedback: Feedback) => void = () => {};
	private editorText = "";
	private editorId = randomUUID();
	private title = "Pi Desk";
	private expanded = false;
	private theme!: Theme;
	private readonly changed: (snapshot: PresentationSnapshot) => void;
	private readonly opened: (view: string, section?: string) => void;

	constructor(
		changed: (snapshot: PresentationSnapshot) => void,
		opened: (view: string, section?: string) => void,
		nextRevision?: () => number,
		registerSource?: (source: UiTranscriptSource) => UiTranscriptHandle,
		command?: (name: string, args?: string) => Promise<void>,
	) {
		this.changed = changed;
		this.opened = opened;
		this.nextRevision = nextRevision ?? (() => ++this.viewRevision);
		this.registerSource = registerSource;
		this.command = command;
		this.capabilities = ["questions", "details", "work", "scopes", "conversations",
			...(registerSource ? ["transcripts" as const] : []), ...(command ? ["commands" as const] : [])];
		// Extensions may format notifications even outside TUI mode.
		initTheme("dark", false);
	}

	install(pi: ExtensionAPI): void {
		let active = true;
		const revision = this.presentationRevision;
		const current = () => active && revision === this.presentationRevision && !this.retired;
		this.recordFeedback = feedback => { if (current()) pi.appendEntry(FEEDBACK_ENTRY, feedback); };
		const host = this;
		const lease: Presentation = {
			version: 2,
			get suspended() { return !current() || host.suspended; },
			capabilities: this.capabilities,
			batch: update => { if (current()) this.batch(update); },
			...(this.command ? { runCommand: async (name: string, args?: string) => {
				if (!current()) throw new Error("The command belongs to a previous session.");
				await this.command!(name, args);
			} } : {}),
			publish: (id, view, actions) => { if (current()) this.publish(id, view, actions); },
			open: (id, section) => { if (current()) this.open(id, section); },
			request: (form, options) => current() ? this.request(form, options) : Promise.resolve(null),
			registerMaintenance: owner => {
				if (!current()) throw new Error("The maintenance owner belongs to a previous session.");
				return this.registerMaintenance(owner);
			},
			createScope: (id, label) => {
				if (!current()) throw new Error("The presentation belongs to a previous session.");
				return this.createScope(id, label);
			},
			...(this.registerSource ? { registerTranscript: (source: UiTranscriptSource) => {
				if (!current()) throw new Error("The presentation belongs to a previous session.");
				return this.registerTranscript(source);
			} } : {}),
		};
		const release = pi.events.on(PRESENTATION_DISCOVER, raw => {
			if (current() && raw && typeof raw === "object") (raw as { presentation?: Presentation }).presentation = lease;
		});
		pi.on("session_start", (_event, ctx) => { this.theme = ctx.ui.theme; });
		pi.on("session_shutdown", () => { active = false; release(); });
	}

	snapshot(): PresentationSnapshot {
		const views: ViewSnapshot[] = [...this.views].map(([id, view]) => ({ ...view.snapshot,
			working: this.actions.get(id)?.label, actionError: this.actionErrors.get(id) }));
		const interactions = [...this.interactions.values()].map(item => item.snapshot);
		const statuses = { ...this.statuses };
		const notifications = [...this.notifications];
		for (const [id, child] of this.scopes) {
			const snapshot = child.presentation.snapshot();
			const scope = { id, label: child.label };
			views.push(...snapshot.views.map(view => ({ ...view, id: `scope:${id}/${view.id}`, scope,
				title: `${child.label} · ${view.title}` })));
			interactions.push(...snapshot.interactions.map(item => ({ ...item, scope: item.scope ?? scope,
				...(item.settings ? { settings: { ...item.settings, id: `scope:${id}/${item.settings.id}` } } : {}) })));
			for (const [key, value] of Object.entries(snapshot.statuses)) statuses[`scope:${id}/${key}`] = `${child.label}: ${value}`;
			notifications.push(...snapshot.notifications.map(item => ({ ...item, text: `${child.label}: ${item.text}` })));
		}
		return {
			generation: this.generation,
			views, interactions, statuses, notifications: notifications.slice(-60),
			editorText: this.editorText, editorId: this.editorId,
			title: this.title,
		};
	}

	batch(update: () => void): void {
		this.batchDepth++;
		try { update(); } finally {
			this.batchDepth--;
			if (!this.batchDepth && this.batchChanged) { this.batchChanged = false; this.update(); }
		}
	}
	private update(): void {
		if (this.batchDepth) { this.batchChanged = true; return; }
		this.changed(this.snapshot());
	}

	advance(): void {
		this.generation = randomUUID();
		this.actions.clear(); this.actionErrors.clear();
		this.cancelInteractions();
		this.update();
	}

	reset(): void {
		this.uiRevision++;
		this.presentationRevision++;
		this.maintenanceOwners.clear();
		for (const source of [...this.transcripts]) source.close();
		this.generation = randomUUID();
		for (const scope of [...this.scopes.values()]) scope.close();
		this.cancelInteractions();
		this.views.clear();
		this.actions.clear(); this.actionErrors.clear();
		this.statuses = {};
		this.notifications = [];
		this.editorText = "";
		this.editorId = randomUUID();
		this.update();
	}

	close(): void {
		if (this.retired) return;
		this.retired = true;
		this.reset();
	}

	cancelInteractions(): void {
		for (const pending of [...this.interactions.values()]) pending.finish(null);
	}

	publish(id: string, view: UiView | undefined, actions: PublishedView["actions"] = {}): void {
		if (this.retired) return;
		if (!view) { this.views.delete(id); this.actionErrors.delete(id); }
		else this.views.set(id, {
			snapshot: { ...structuredClone(view), id, revision: this.nextRevision() },
			actions,
		});
		this.update();
	}

	open(id: string, section?: string): void { if (!this.retired) this.opened(id, section); }

	createScope(id: string, label: string): PresentationScope {
		if (this.retired || !this.theme) throw new Error("The session presentation is unavailable.");
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid presentation scope.");
		this.scopes.get(id)?.close();
		const child = new DeskPresentation(() => { if (!child.retired) this.update(); },
			(view, section) => this.open(`scope:${id}/${view}`, section), this.nextRevision, this.registerSource);
		child.setSuspended(this.suspended);
		const ui = child.createUi(this.theme);
		const close = () => {
			if (child.retired) return;
			child.close();
			if (this.scopes.get(id)?.presentation === child) this.scopes.delete(id);
			this.update();
		};
		this.scopes.set(id, { label: plain(label), presentation: child, close });
		return {
			version: 2, capabilities: child.capabilities, ui,
			get suspended() { return child.retired || child.suspended; },
			batch: child.batch.bind(child),
			publish: child.publish.bind(child), open: child.open.bind(child), request: child.request.bind(child),
			createScope: child.createScope.bind(child), install: child.install.bind(child),
			cancelInteractions: child.cancelInteractions.bind(child), close,
			...(this.registerSource ? { registerTranscript: child.registerTranscript.bind(child) } : {}),
		};
	}

	registerTranscript(source: UiTranscriptSource): UiTranscriptHandle {
		if (this.retired || !this.registerSource) throw new Error("Transcript presentation is unavailable.");
		const registered = this.registerSource(source);
		const handle = { id: registered.id, close: () => {
			if (this.transcripts.delete(handle)) registered.close();
		} };
		this.transcripts.add(handle);
		return handle;
	}

	async act(id: string, revision: number, action: string, value: UiValue = null,
		interrupt?: (operation: () => Promise<unknown>) => Promise<unknown>): Promise<{ accepted: true }> {
		for (const [scope, child] of this.scopes) {
			const prefix = `scope:${scope}/`;
			if (id.startsWith(prefix)) return child.presentation.act(id.slice(prefix.length), revision, action, value);
		}
		const view = this.views.get(id);
		if (!view || view.snapshot.revision !== revision) throw new Error("This view changed. Refresh before trying again.");
		if (this.actions.has(id)) throw new Error("This action is already in progress.");
		const handler = view.actions[action];
		const itemActions = view.snapshot.kind === "details" ? (view.snapshot.data as UiDetails).items?.flatMap(item => item.actions ?? []) ?? [] : [];
		const controls = view.snapshot.kind === "details" ? (view.snapshot.data as UiDetails).controls ?? [] : [];
		const descriptor = [...view.snapshot.actions ?? [], ...itemActions, ...controls.map(control => control.action)].find(item => item.id === action);
		if (!handler || !descriptor) throw new Error("Unknown action.");
		if (descriptor.input === "message" && (typeof value !== "string" || !value.trim() || value.length > 1_000_000))
			throw new Error("Enter a message of at most 1,000,000 characters.");
		const operation = { label: plain(descriptor.label), generation: this.generation };
		this.actions.set(id, operation); this.actionErrors.delete(id);
		view.snapshot = { ...view.snapshot, revision: this.nextRevision() };
		this.update();
		const current = () => !this.retired && operation.generation === this.generation && this.actions.get(id) === operation;
		const work = Promise.resolve().then(() => {
			if (!current()) throw new Error("The action belongs to a previous session.");
			const run = () => view.snapshot.surface === "settings"
				? this.settingOrigin.run({ id, title: view.snapshot.title, live: current }, () => handler(value))
				: handler(value);
			return descriptor.interrupt === "resume" && interrupt ? interrupt(async () => run()) : run();
		}).catch(error => {
			if (!current()) throw error;
			const message = plain(`${operation.label}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 2000);
			if (this.views.has(id)) this.actionErrors.set(id, message);
			this.notify(message, "error");
			throw error;
		}).finally(() => {
			if (this.actions.get(id) !== operation) return;
			this.actions.delete(id); this.update();
		});
		// Interactive actions remain asynchronous; inline text waits for actual admission.
		if (descriptor.input === "message" || descriptor.interrupt === "resume") await work;
		else void work.catch(() => {});
		return { accepted: true };
	}

	request(form: UiInteraction, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<UiAnswer | null> {
		if (this.retired || options.signal?.aborted) return Promise.resolve(null);
		const origin = this.settingOrigin.getStore();
		const settings = origin?.live() ? { id: origin.id, title: origin.title } : undefined;
		const id = randomUUID();
		const timeout = options.timeout && options.timeout > 0 ? Math.min(options.timeout, 2_147_483_647) : undefined;
		return new Promise(resolve => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (answer: UiAnswer | null) => {
				if (!this.interactions.delete(id)) return;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				this.update();
				resolve(answer);
			};
			const abort = () => finish(null);
			this.interactions.set(id, {
				snapshot: { id, form: structuredClone(form), ...(settings ? { settings } : {}), ...(timeout ? { deadline: Date.now() + timeout } : {}) },
				finish,
			});
			options.signal?.addEventListener("abort", abort, { once: true });
			if (timeout) timer = setTimeout(abort, timeout);
			this.update();
		});
	}

	answer(id: string, answer: unknown): void {
		const pending = this.interactions.get(id);
		if (!pending) {
			const child = [...this.scopes.values()].find(scope => scope.presentation.snapshot().interactions.some(item => item.id === id));
			if (child) { child.presentation.answer(id, answer); return; }
			throw new Error("This question has already been answered or closed.");
		}
		pending.finish(validateAnswer(pending.snapshot.form, answer));
	}

	notify(text: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.retired) return;
		const feedback = { id: randomUUID(), text: plain(text), level, timestamp: Date.now(), generation: this.generation };
		if (level !== "info") this.recordFeedback({ ...feedback, level });
		this.notifications.push(feedback);
		this.notifications = this.notifications.slice(-30);
		this.update();
	}

	createUi(theme: Theme): ExtensionUIContext {
		this.theme = theme;
		const revision = ++this.uiRevision;
		const live = () => !this.retired && this.uiRevision === revision;
		const request = async (form: UiInteraction, options?: { signal?: AbortSignal; timeout?: number }): Promise<UiAnswer | null> => {
			if (!live()) return null;
			const answer = await this.request(form, options);
			return live() ? answer : null;
		};
		const text = async (form: UiInteraction, opts?: { signal?: AbortSignal; timeout?: number }) => {
			const result = await request(form, opts);
			return result?.kind === "freeform" ? result.text : undefined;
		};
		const heading = (title: string) => {
			const [first, ...body] = plain(title).split("\n");
			return { title: first, context: body.join("\n").trim() || undefined };
		};
		return {
			theme,
			select: async (title, options, opts) => {
				const answer = await request({
					kind: "question", ...heading(title), options: options.map(title => ({ title })),
					allowMultiple: false, allowFreeform: false, allowComment: false,
				}, opts);
				return answer?.kind === "selection" ? answer.selections[0] : undefined;
			},
			confirm: async (title, message, opts) => {
				const answer = await request({ kind: "confirm", title: plain(title), message: plain(message) }, opts);
				return answer?.kind === "confirm" && answer.confirmed;
			},
			input: (title, placeholder, opts) => text({ kind: "input", ...heading(title), placeholder }, opts),
			editor: (title, value) => text({ kind: "editor", ...heading(title), value }),
			notify: (message, level) => { if (live()) this.notify(message, level); },
			setStatus: (key, value) => {
				if (!live()) return;
				if (value === undefined) delete this.statuses[key];
				else this.statuses[key] = plain(value);
				this.update();
			},
			setTitle: title => { if (live()) { this.title = plain(title); this.update(); } },
			setEditorText: value => { if (live()) { this.editorText = value; this.editorId = randomUUID(); this.update(); } },
			pasteToEditor: value => { if (live()) { this.editorText += value; this.editorId = randomUUID(); this.update(); } },
			getEditorText: () => live() ? this.editorText : "",
			onTerminalInput: () => () => {},
			setWidget: (key, content) => {
				if (!live() || typeof content === "function") return;
				this.publish(`widget:${key}`, content ? { kind: "text", title: key, data: content.map(plain) } : undefined);
			},
			custom: async () => { throw new Error("This extension needs a Pi Desk presentation for its terminal dialog."); },
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			addAutocompleteProvider: () => {},
			setWorkingMessage: message => {
				if (!live()) return;
				if (message) this.statuses.working = plain(message);
				else delete this.statuses.working;
				this.update();
			},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			getAllThemes: () => [{ name: "dark", path: undefined }],
			getTheme: () => theme,
			setTheme: () => ({ success: false, error: "Use Pi Desk appearance settings." }),
			getToolsExpanded: () => live() && this.expanded,
			setToolsExpanded: expanded => { if (live()) { this.expanded = expanded; this.update(); } },
		};
	}
}

function validateAnswer(form: UiInteraction, input: unknown): UiAnswer | null {
	if (input === null) return null;
	if (!input || typeof input !== "object") throw new Error("Invalid answer.");
	const answer = input as Record<string, unknown>;
	if (form.kind === "confirm") {
		if (answer.kind !== "confirm" || typeof answer.confirmed !== "boolean") throw new Error("Choose confirm or cancel.");
		return { kind: "confirm", confirmed: answer.confirmed };
	}
	if (answer.kind === "freeform") {
		if (form.kind === "question" && !form.allowFreeform) throw new Error("Choose one of the listed options.");
		if (typeof answer.text !== "string" || answer.text.length > 1_000_000) throw new Error("Invalid text answer.");
		if (form.kind === "question" && !answer.text.trim()) throw new Error("Enter an answer.");
		return { kind: "freeform", text: answer.text };
	}
	if (form.kind !== "question" || answer.kind !== "selection" || !Array.isArray(answer.selections)) throw new Error("Invalid selection.");
	const selections = [...new Set(answer.selections)];
	if (!selections.length || (!form.allowMultiple && selections.length !== 1)
		|| selections.some(value => typeof value !== "string" || !form.options.some(option => option.title === value))) {
		throw new Error("Choose from the listed options.");
	}
	if (answer.comment !== undefined && (!form.allowComment || typeof answer.comment !== "string" || answer.comment.length > 100_000)) {
		throw new Error("Invalid comment.");
	}
	return {
		kind: "selection", selections: selections as string[],
		...(typeof answer.comment === "string" ? { comment: answer.comment } : {}),
	};
}

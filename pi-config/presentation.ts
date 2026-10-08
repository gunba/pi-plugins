import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Presentation, UiAction, UiValue } from "../pi-ui/index.ts";
import { configCategories, type ConfigFileView, type ConfigSettingView, type ConfigViewData } from "./view.ts";
import { readOptional, writeCheckedFile } from "./files.ts";

export interface ConfigDocument {
	id: string; title: string; path: string; group: string; kind: string; scope: string;
	format: "json" | "markdown" | "text"; exists: boolean; loaded?: boolean; readonly?: boolean; note?: string; createTemplate?: () => string;
}
export interface ConfigField {
	key: string; label: string; type: string; description: string; defaultValue: unknown; choices?: string[];
}
export interface ConfigUiOperations {
	discover(): ConfigDocument[];
	effective(): unknown;
	reference(): ConfigField[];
	nativeResources?: boolean;
	validate(entry: ConfigDocument, text: string): string | undefined;
	insert(text: string, key: string, value: unknown): string | null;
}

/** Host-side protected values never enter a remote editor or a published preview. */
export function projectConfig(text: string): { text: string; restore: (edited: string) => string; protectedCount: number } {
	let root: unknown;
	try { root = JSON.parse(text.trim() || "{}"); }
	catch { throw new Error("The configuration is not valid JSON. Repair it on the computer before opening the remote editor."); }
	const protectedValues: { path: string[]; marker: string; value: unknown }[] = [];
	const sensitive = /^(?:token|accesstoken|refreshtoken|idtoken|bearertoken)$|password|secret|credential|authorization|apikey|cookie|headers|^env$|^auth|^args$|^command$|key$|proxy|url|endpoint/i;
	const walk = (value: unknown, path: string[]): unknown => {
		const key = path.at(-1)?.replace(/[^a-z0-9]/gi, "") ?? "";
		if (path.length && (sensitive.test(key) || typeof value === "string" && /(?:https?:\/\/)[^/\s]*@/.test(value))) {
			const marker = `[host-only:${randomUUID()}]`;
			protectedValues.push({ path, marker, value });
			return marker;
		}
		if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, String(index)]));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, [...path, key])]));
		return value;
	};
	const safe = walk(root, []);
	return {
		text: JSON.stringify(safe, null, 2), protectedCount: protectedValues.length,
		restore: edited => {
			const result = JSON.parse(edited);
			for (const item of protectedValues) {
				let parent = result;
				for (const part of item.path.slice(0, -1)) parent = parent && typeof parent === "object" && Object.hasOwn(parent, part) ? parent[part] : undefined;
				const key = item.path.at(-1)!;
				if (!parent || !Object.hasOwn(parent, key) || parent[key] !== item.marker) {
					throw new Error("Protected values must stay in their original fields. Change credentials and connection commands on the computer.");
				}
				Object.defineProperty(parent, key, { value: item.value, writable: true, enumerable: true, configurable: true });
			}
			// A marker copied elsewhere must never become a real configuration value.
			const serialized = JSON.stringify(result, null, 2);
			if (protectedValues.some(item => serialized.includes(item.marker))) throw new Error("A protected placeholder was copied to another field.");
			return serialized;
		},
	};
}

export class ConfigPresentation {
	private active = true;
	private filter = "";
	private category = "settings";
	private search = "";
	private offset = 0;
	private entries?: ConfigDocument[];
	private selected?: { entry: ConfigDocument; original: string | undefined; projection: ReturnType<typeof projectConfig> };
	private readonly remote: Presentation;
	private readonly ops: ConfigUiOperations;
	private readonly notify: (message: string, level?: "info" | "error") => void;

	constructor(remote: Presentation, ops: ConfigUiOperations, notify: (message: string, level?: "info" | "error") => void) {
		this.remote = remote; this.ops = ops; this.notify = notify;
		this.render();
	}
	close(): void { this.active = false; this.remote.publish("config", undefined); }
	open(filter = ""): void {
		this.check();
		this.filter = filter;
		const category = ({ md: "context", skills: "skill", prompts: "prompt", extensions: "extension" } as Record<string, string>)[filter] ?? filter;
		this.category = configCategories.some(item => item.id === category) ? category : "settings";
		this.search = this.category === category ? "" : filter; this.offset = 0;
		this.selected = undefined; this.entries = this.ops.discover(); this.render(); this.remote.open("config");
	}
	private check(): void { if (!this.active) throw new Error("Configuration belongs to a previous session or branch."); }
	private select(entry: ConfigDocument): void {
		this.check();
		if (entry.exists && statSync(entry.path).size > 256 * 1024) throw new Error("This file is too large for the configuration editor. Open it on the computer.");
		const original = readOptional(entry.path);
		const text = original ?? entry.createTemplate?.() ?? "";
		const validation = this.ops.validate(entry, text);
		if (validation) throw new Error(entry.format === "json" ? "This file is not valid JSON. Repair it on the computer before opening the remote editor." : validation);
		const projection = entry.format === "json" ? projectConfig(text) : { text, restore: (text: string) => text, protectedCount: 0 };
		this.selected = { entry, original, projection }; this.render();
	}
	private async edit(initial = this.selected?.projection.text): Promise<void> {
		const selected = this.selected;
		if (!selected || initial === undefined) return;
		if (selected.entry.readonly) throw Error("This resource belongs to an installed runtime. Edit its source rather than the managed copy.");
		if (selected.original === undefined) {
			const answer = await this.remote.request({ kind: "confirm", title: "Create file", message: selected.entry.path });
			this.check();
			if (answer?.kind !== "confirm" || !answer.confirmed) return;
		}
		let text = initial;
		while (this.active) {
			const answer = await this.remote.request({ kind: "editor", title: selected.entry.title, value: text, submitLabel: "Save file" });
			this.check();
			if (answer?.kind !== "freeform") return;
			text = answer.text;
			let restored: string;
			try {
				const validation = this.ops.validate(selected.entry, text);
				if (validation) throw new Error(validation);
				restored = selected.projection.restore(text);
			} catch (error) { this.notify(String(error), "error"); continue; }
			// Reuse the terminal's checked write, lock ordering and Windows rename retries.
			await writeCheckedFile(selected.entry.path, selected.original, restored.endsWith("\n") ? restored : `${restored}\n`, () => this.check());
			this.check();
			this.notify(`Saved ${selected.entry.path}. Reload Pi resources from session settings to apply changes; some settings need a new session.`);
			this.select({ ...selected.entry, exists: true });
			return;
		}
	}
	private settingWarnings: string[] = [];
	private settingRows(): ConfigSettingView[] {
		this.settingWarnings = [];
		const safe = (value: unknown) => JSON.parse(projectConfig(JSON.stringify(value ?? {})).text.replace(/\[host-only:[^\]]+\]/g, "[Protected on computer]"));
		const effective = safe(this.ops.effective());
		const saved = (scope: string) => {
			const entry = this.entries?.find(entry => entry.kind === "settings" && entry.scope === scope);
			if (!entry || !entry.exists) return {};
			try {
				if (statSync(entry.path).size > 256 * 1024) throw Error("Large file");
				return safe(JSON.parse(readOptional(entry.path) ?? "{}"));
			} catch { this.settingWarnings.push(`Saved ${scope} values are unavailable. Open ${entry.title} for details.`); return {}; }
		};
		const global = saved("global"), project = saved("project");
		const catalog = new Map(this.ops.reference().map(field => [field.key, field]));
		const keys = new Set(catalog.keys());
		const visit = (value: unknown, prefix = "") => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			for (const [key, child] of Object.entries(value)) {
				const path = prefix ? `${prefix}.${key}` : key;
				if (!child || typeof child !== "object" || Array.isArray(child) || !Object.keys(child).length || catalog.has(path)) keys.add(path);
				visit(child, path);
			}
		};
		visit(effective); visit(global); visit(project);
		const display = (value: unknown): string | undefined => {
			if (value === undefined) return undefined;
			const text = JSON.stringify(value, null, 2);
			return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
		};
		return [...keys].sort().map(key => {
			const field = catalog.get(key), value = atPath(effective, key);
			return { key, label: field?.label ?? key, type: field?.type ?? (Array.isArray(value) ? "array" : typeof value),
				description: field?.description ?? "Present in this session or its saved settings.", choices: field?.choices,
				value: display(value), defaultValue: display(field?.defaultValue), global: display(atPath(global, key)), project: display(atPath(project, key)) };
		});
	}
	private render(): void {
		if (!this.active) return;
		const callbacks: Record<string, (value: UiValue) => Promise<void>> = {};
		const action = (id: string, label: string, run: (value: UiValue) => void | Promise<void>): UiAction => {
			callbacks[id] = async value => { this.check(); try { await run(value); } finally { if (this.active) this.render(); } };
			return { id, label };
		};
		const fileView = (entry: ConfigDocument): ConfigFileView => ({
			id: entry.id, title: entry.title, path: entry.path, kind: entry.kind, scope: entry.scope,
			format: entry.format, exists: entry.exists, loaded: entry.loaded, readonly: entry.readonly, note: entry.note,
		});
		const matches = (text: string) => this.search.toLowerCase().split(/\s+/).every(word => text.toLowerCase().includes(word));
		const kinds: readonly string[] = configCategories.find(category => category.id === this.category)?.kinds ?? [];
		const documents = (this.entries ?? []).filter(entry => (this.category === "all" || kinds.includes(entry.kind)) && matches(`${entry.title} ${entry.path} ${entry.scope} ${entry.note ?? ""}`)).map(fileView);
		const settings = this.entries && !this.selected && ["settings", "all"].includes(this.category) ? this.settingRows().filter(field => matches(`${field.key} ${field.label} ${field.description}`)) : [];
		const rows = [...documents.map(file => ({ file })), ...settings.map(field => ({ field }))];
		const offset = Math.min(this.offset, Math.max(0, Math.ceil(rows.length / 40) - 1) * 40);
		const page = this.selected ? [] : rows.slice(offset, offset + 40);
		const data: ConfigViewData = {
			loaded: !!this.entries, query: this.filter, nativeResources: !!this.ops.nativeResources,
			category: this.category, filter: this.search, offset, total: rows.length,
			documents: page.flatMap(row => "file" in row ? [row.file] : []), settings: page.flatMap(row => "field" in row ? [row.field] : []),
		};
		const actions: UiAction[] = [
			action("list", "Search resources", value => {
				if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.query !== "string" || value.query.length > 500
					|| !configCategories.some(item => item.id === value.category) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw Error("Choose a category and search query.");
				this.category = String(value.category); this.search = value.query; this.offset = Math.floor(Number(value.offset) / 40) * 40;
			}),
			action("browse", "Refresh", () => { this.entries = this.ops.discover(); this.selected = undefined; }),
			action("open", "Open file", value => {
				const entry = this.entries?.find(entry => entry.id === value);
				if (!entry) throw Error("This file is no longer in the resource inventory.");
				this.select(entry);
			}),
			action("review-setting", "Review setting", async value => {
				if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.key !== "string" || !["global", "project"].includes(String(value.scope))) throw Error("Choose a setting and scope.");
				if (value.key.split(".").some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw Error("This key cannot be inserted with the setting editor.");
				if (!this.settingRows().some(field => field.key === value.key)) throw Error("This setting is no longer listed.");
				const entry = this.entries?.find(entry => entry.kind === "settings" && entry.scope === value.scope);
				if (!entry) throw Error("The settings file is unavailable.");
				this.select(entry);
				const current = atPath(JSON.parse(this.selected!.projection.text), value.key);
				const reference = this.ops.reference().find(field => field.key === value.key);
				const active = atPath(JSON.parse(projectConfig(JSON.stringify(this.ops.effective() ?? {})).text), value.key);
				if (current === undefined && JSON.stringify(active)?.includes("[host-only:")) throw Error("Change this protected setting on the computer.");
				const initial = current !== undefined ? this.selected!.projection.text
					: this.ops.insert(this.selected!.projection.text, value.key, active ?? reference?.defaultValue ?? null);
				if (initial === null) throw Error("This setting cannot be inserted into the current file.");
				await this.edit(initial);
			}),
		];
		if (this.selected) {
			const { entry, projection } = this.selected;
			data.selected = { file: fileView(entry), preview: projection.text.slice(0, 24_000), truncated: projection.text.length > 24_000, protectedCount: projection.protectedCount };
			actions.push(action("files", "Back", () => { this.selected = undefined; this.entries = this.ops.discover(); }),
				action("reopen", "Refresh file", () => this.select(entry)));
			if (!entry.readonly) actions.push(action("edit", "Edit file", () => this.edit()));
		}
		data.warnings = !this.selected && ["settings", "all"].includes(this.category) ? this.settingWarnings : undefined;
		this.remote.publish("config", { kind: "configuration", title: "Pi settings & resources", surface: "settings", data, actions }, callbacks);
	}
}

function atPath(value: unknown, path: string): unknown {
	for (const key of path.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

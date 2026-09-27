import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Presentation, UiAction, UiDetails, UiValue } from "../pi-ui/index.ts";
import { readOptional, writeCheckedFile } from "./files.ts";

export interface ConfigDocument {
	id: string; title: string; path: string; group: string; kind: string; scope: string;
	format: "json" | "markdown" | "text"; exists: boolean; loaded?: boolean; note?: string; createTemplate?: () => string;
}
export interface ConfigField {
	key: string; label: string; type: string; description: string; defaultValue: unknown; choices?: string[];
}
export interface ConfigUiOperations {
	discover(): ConfigDocument[];
	matches(entry: ConfigDocument, filter: string): boolean;
	fields(entry: ConfigDocument): ConfigField[];
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
	private offset = 0;
	private entries?: ConfigDocument[];
	private selected?: { entry: ConfigDocument; original: string | undefined; projection: ReturnType<typeof projectConfig> };
	private reference = false;
	private fieldFilter = "";
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
		this.filter = filter; this.offset = 0; this.selected = undefined; this.entries = this.ops.discover(); this.render(); this.remote.open("config");
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
		this.selected = { entry, original, projection }; this.reference = false; this.offset = 0; this.render();
	}
	private async edit(initial = this.selected?.projection.text): Promise<void> {
		const selected = this.selected;
		if (!selected || initial === undefined) return;
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
	private async search(reference = false): Promise<void> {
		const answer = await this.remote.request({ kind: "input", title: reference ? "Find a setting" : "Find a configuration file",
			value: reference ? this.fieldFilter : this.filter });
		this.check();
		if (answer?.kind !== "freeform") return;
		if (reference) this.fieldFilter = answer.text;
		else this.filter = answer.text;
		this.offset = 0;
	}
	private render(): void {
		if (!this.active) return;
		const callbacks: Record<string, (value: UiValue) => Promise<void>> = {};
		const action = (id: string, label: string, run: () => void | Promise<void>): UiAction => {
			callbacks[id] = async () => { this.check(); try { await run(); } finally { if (this.active) this.render(); } };
			return { id, label };
		};
		const actions: UiAction[] = [];
		let details: UiDetails;
		if (this.selected) {
			const { entry, projection } = this.selected;
			details = { summary: entry.title, fields: [
				{ label: "Path", value: entry.path }, { label: "Scope", value: entry.scope },
				{ label: "Protected fields", value: String(projection.protectedCount) },
			] };
			actions.push(action("files", "All files", () => { this.selected = undefined; this.entries = this.ops.discover(); this.offset = 0; }),
				action("reopen", "Reopen file", () => this.select(entry)), action("edit", "Edit file", () => this.edit()));
			const fields = this.ops.fields(entry);
			if (fields.length) actions.push(action("reference", this.reference ? "Show preview" : "Setting reference", () => { this.reference = !this.reference; this.offset = 0; }));
			if (this.reference) {
				const found = fields.filter(field => `${field.key} ${field.label} ${field.description}`.toLowerCase().includes(this.fieldFilter.toLowerCase()));
				details.items = found.slice(this.offset, this.offset + 30).map(field => ({
					id: field.key, title: field.label, subtitle: `${field.key} · ${field.type}`,
					body: `${field.description}\nDefault: ${JSON.stringify(field.defaultValue)}${field.choices ? `\nChoices: ${field.choices.join(", ")}` : ""}`,
					actions: [action(`insert:${field.key}`, "Insert default & review", async () => {
						const initial = this.ops.insert(projection.text, field.key, field.defaultValue);
						if (initial === null) throw new Error("This setting cannot be inserted into the current file.");
						await this.edit(initial);
					})],
				}));
				actions.push(action("search-fields", "Find a setting", () => this.search(true)));
				if (found.length > this.offset + 30) actions.push(action("more", "More settings", () => { this.offset += 30; }));
				if (this.offset) actions.push(action("previous", "Previous settings", () => { this.offset = Math.max(0, this.offset - 30); }));
			} else details.items = [{ id: "preview", title: "Preview", body: projection.text.slice(0, 12_000),
				status: projection.text.length > 12_000 ? "Open the editor for the complete file." : undefined }];
		} else {
			const entries = this.entries?.filter(entry => this.ops.matches(entry, this.filter)) ?? [];
			details = { summary: this.entries ? `${entries.length} files${this.filter ? ` · ${this.filter}` : ""}` : "Inspect and edit Pi settings and resources on this computer.",
				items: entries.slice(this.offset, this.offset + 30).map((entry, index) => ({
					id: entry.id, title: entry.title, subtitle: `${entry.scope} · ${entry.group}${entry.exists ? "" : " · not created"}`,
					body: entry.path, actions: [action(`open:${index}`, "Open", () => this.select(entry))],
				})) };
			actions.push(action("browse", this.entries ? "Refresh files" : "Browse configuration", () => { this.entries = this.ops.discover(); this.offset = 0; }),
				action("search", "Search files", async () => { await this.search(); this.entries ??= this.ops.discover(); }));
			if (entries.length > this.offset + 30) actions.push(action("next", "More files", () => { this.offset += 30; }));
			if (this.offset) actions.push(action("previous", "Previous files", () => { this.offset = Math.max(0, this.offset - 30); }));
		}
		this.remote.publish("config", { kind: "details", title: "Configuration", surface: "settings", data: details, actions }, callbacks);
	}
}

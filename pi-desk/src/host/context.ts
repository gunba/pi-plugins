import { createHash } from "node:crypto";
import { closeSync, fsyncSync, fstatSync, ftruncateSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import type { AgentSession, ResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ContextChange, ContextFile, ContextSnapshot } from "../shared/context.ts";

const ENTRY = "desk-context-profile";
interface Profile { tools: Record<string, boolean>; skills: Record<string, boolean>; instructions: Record<string, boolean> }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"); };
const selections = (value: unknown): Record<string, boolean> => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter((pair): pair is [string, boolean] => typeof pair[1] === "boolean"));

/** One native resource-loader facade; it does not modify installed skills or extension executors. */
export class NativeContext {
	readonly resources: ResourceLoader;
	private session?: AgentSession;
	private edited = new Map<string, string>();
	private original = new Map<string, boolean>();
	private manager: SessionManager;
	private base: ResourceLoader;
	private readonlyRoots: string[];
	constructor(manager: SessionManager, base: ResourceLoader, readonlyRoots: string[] = []) {
		this.manager = manager; this.base = base; this.readonlyRoots = readonlyRoots;
		this.resources = {
			getExtensions: () => base.getExtensions(), getPrompts: () => base.getPrompts(), getThemes: () => base.getThemes(),
			getSkills: () => { const result = base.getSkills(), profile = this.profile().data; return { ...result, skills: result.skills.filter(skill => profile.skills[skill.name] !== false) }; },
			getAgentsFiles: () => { const profile = this.profile().data; return { agentsFiles: this.files().filter(file => profile.instructions[file.path] !== false) }; },
			getSystemPrompt: () => base.getSystemPrompt(), getSystemPromptSource: () => base.getSystemPromptSource(),
			getAppendSystemPrompt: () => base.getAppendSystemPrompt(), getAppendSystemPromptSources: () => base.getAppendSystemPromptSources(),
			extendResources: paths => base.extendResources(paths),
			reload: async options => { await base.reload(options); this.edited.clear(); },
		};
	}
	attach(session: AgentSession): void { this.session = session; this.apply(); }
	toolChoices(): Record<string, boolean> { return { ...this.profile().data.tools }; }
	private profile(): { revision: string; data: Profile } {
		const branch = this.manager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "custom" && entry.customType === ENTRY) {
				const data = entry.data as Partial<Profile> | undefined;
				return { revision: entry.id, data: { tools: selections(data?.tools), skills: selections(data?.skills), instructions: selections(data?.instructions) } };
			}
		}
		return { revision: "default", data: { tools: {}, skills: {}, instructions: {} } };
	}
	private files() { return this.base.getAgentsFiles().agentsFiles.map(file => ({ ...file, content: this.edited.get(file.path) ?? file.content })); }
	private file(path: string) { const file = this.files().find(file => file.path === path); if (!file) throw Error("This instruction file is not loaded by this conversation."); return file; }
	private editable(path: string): boolean {
		try { const canonical = realpathSync(path); return !this.readonlyRoots.some(root => inside(root, canonical)); } catch { return false; }
	}
	apply(): void {
		if (!this.session) return;
		const names = new Set(this.session.getActiveToolNames()), known = new Set(this.session.getAllTools().map(tool => tool.name));
		const choices = this.profile().data.tools;
		for (const [name, enabled] of this.original) if (!Object.hasOwn(choices, name)) {
			if (enabled) names.add(name); else names.delete(name);
			this.original.delete(name);
		}
		for (const [name, enabled] of Object.entries(choices)) if (known.has(name)) {
			if (!this.original.has(name)) this.original.set(name, names.has(name));
			if (enabled) names.add(name); else names.delete(name);
		}
		// The native setter rebuilds the system prompt using the scoped resource getters.
		this.session.setActiveToolsByName([...names]);
	}
	inspect(): ContextSnapshot {
		const session = this.session!;
		const profile = this.profile(), selected = new Set(session.getActiveToolNames()), declared = new Set(session.agent.state.tools.map(tool => tool.name));
		const callable = new Set(session.getCallableToolNames());
		const tools = session.getAllTools().map(tool => {
			const definition = session.getToolDefinition(tool.name), exposure = definition?.exposure ?? "direct";
			return { id: tool.name, description: tool.description.slice(0, 800), exposure, selected: selected.has(tool.name), declared: declared.has(tool.name),
				callable: callable.has(tool.name), selectable: exposure === "direct" || exposure === "model-only",
				characters: declared.has(tool.name) ? JSON.stringify(session.agent.state.tools.find(item => item.name === tool.name)).length : 0 };
		});
		return { revision: profile.revision, prompt: session.systemPrompt, estimatedTokens: Math.ceil((session.systemPrompt.length + tools.reduce((sum, tool) => sum + tool.characters, 0)) / 4),
			instructions: this.files().map(file => ({ id: file.path, path: file.path, characters: file.content.length, included: profile.data.instructions[file.path] !== false, editable: this.editable(file.path) })),
			skills: this.base.getSkills().skills.map(skill => ({ id: skill.name, path: skill.filePath, description: skill.description, included: profile.data.skills[skill.name] !== false })), tools };
	}
	update(change: ContextChange): ContextSnapshot {
		const profile = this.profile();
		if (change.revision !== profile.revision) throw Error("Context choices changed. Refresh before editing them.");
		if (change.resource === "tool") {
			if (!this.inspect().tools.some(tool => tool.id === change.id && tool.selectable)) throw Error("Choose a direct or model-only tool. Callable catalog entries are controlled by their native extension.");
			profile.data.tools[change.id] = change.included;
		} else if (change.resource === "skill") {
			if (!this.base.getSkills().skills.some(skill => skill.name === change.id)) throw Error("This skill is no longer loaded.");
			profile.data.skills[change.id] = change.included;
		} else {
			this.file(change.id); profile.data.instructions[change.id] = change.included;
		}
		this.manager.appendCustomEntry(ENTRY, profile.data);
		this.apply(); return this.inspect();
	}
	read(path: string): ContextFile {
		this.file(path);
		const canonical = realpathSync(path), content = readFileSync(canonical);
		if (content.length > 512_000) throw Error("This instruction file is too large for the editor.");
		return { path, text: content.toString("utf8"), version: digest(canonical + "\0" + content.toString("utf8")), editable: this.editable(path) };
	}
	save(path: string, version: string, text: string): ContextSnapshot {
		this.file(path);
		if (!this.editable(path)) throw Error("Managed runtime files are read-only.");
		const canonical = realpathSync(path), fd = openSync(canonical, "r+");
		try {
			if (!fstatSync(fd).isFile()) throw Error("Choose an instruction file.");
			const current = readFileSync(fd, "utf8");
			if (digest(canonical + "\0" + current) !== version) throw Error("The instruction file changed on disk. Reopen it before saving.");
			const data = Buffer.from(text);
			if (data.length > 512_000) throw Error("This instruction file is too large for the editor.");
			let written = 0;
			while (written < data.length) written += writeSync(fd, data, written, data.length - written, written);
			ftruncateSync(fd, data.length); fsyncSync(fd);
		} finally { closeSync(fd); }
		this.edited.set(path, text); this.apply(); return this.inspect();
	}
}

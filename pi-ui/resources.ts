import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { UiResource } from "./index.ts";

/** Metadata only, from the owning session's native resource loader. */
export function resourceInventory(loader: ResourceLoader, readonlyRoots: string[] = []): UiResource[] {
	const readonly = (path: string) => {
		if (path.startsWith("builtin:")) return true;
		try {
			const canonical = realpathSync(path);
			return readonlyRoots.some(root => { const part = relative(root, canonical); return !part || !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"); });
		} catch { return true; }
	};
	const extensions = loader.getExtensions();
	const files: UiResource[] = [
		...loader.getAgentsFiles().agentsFiles.map(file => ({ path: file.path, title: basename(file.path), kind: "context" as const, loaded: true })),
		...[loader.getSystemPromptSource(), ...loader.getAppendSystemPromptSources()].flatMap(file => file ? [{ path: file.path, title: basename(file.path), kind: "context" as const, loaded: true }] : []),
		...loader.getSkills().skills.map(skill => ({ path: skill.filePath, title: skill.name, description: skill.description, kind: "skill" as const, loaded: true })),
		...loader.getPrompts().prompts.map(prompt => ({ path: prompt.filePath, title: prompt.name, description: prompt.description, kind: "prompt" as const, loaded: true })),
		...extensions.extensions.map(extension => ({ path: extension.path, title: basename(extension.path), kind: "extension" as const, loaded: true })),
		...extensions.errors.map(extension => ({ path: extension.path, title: basename(extension.path), kind: "extension" as const, loaded: false, description: extension.error })),
	];
	return files.map(file => ({ ...file, readonly: readonly(file.path) }));
}

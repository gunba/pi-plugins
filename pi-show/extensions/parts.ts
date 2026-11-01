import { applySpecPatch, validateSpec, type AgentPatch } from "../../pi-ui/agent-ui.ts";
import { catalogValidator } from "../../pi-ui/agent-catalog.ts";
import { progressParser, type ProgressSource } from "../../pi-ui/agent-progress.ts";
import { SHOWN_ENTRY, type Shown } from "./types.ts";
export type PartUpdate = { id?: string; title?: string; note?: string; spec?: unknown; patch?: AgentPatch[]; before?: string; pinned?: boolean; collapsed?: boolean; remove?: boolean; source?: ProgressSource | null };
export function restoredParts(entries: readonly { type: string; customType?: string; data?: unknown }[]): Map<string, Shown> {
	const parts = new Map<string, Shown>();
	for (const entry of entries) if (entry.type === "custom" && entry.customType === SHOWN_ENTRY) {
		const part = entry.data as Shown;
		if (part && typeof part.id === "string") { if (part.remove) parts.delete(part.id); else parts.set(part.id, part); }
	}
	return parts;
}
/** Persist a complete part after each agent update so history pagination never loses a patch base. */
export function updatePart(parts: Map<string, Shown>, id: string, update: PartUpdate, items?: Shown["items"]): Shown {
	if (!/^[\w.-]{1,100}$/.test(id)) throw new Error("Part IDs use 1–100 letters, digits, dots, underscores or hyphens.");
	const previous = parts.get(id);
	if (update.remove) return { id, title: (previous?.title ?? update.title ?? id).slice(0, 200), items: [], remove: true, persisted: true };
	if (!previous && parts.size >= 64) throw new Error("Remove a part before adding more than 64 parts.");
	if (update.before && update.before !== id && !parts.has(update.before)) throw new Error("The before part does not exist.");
	if (update.spec !== undefined && update.patch !== undefined) throw new Error("Send a spec or patches, not both.");
	if (update.patch && !previous?.spec) throw new Error("Create the spec before patching it.");
	const spec = update.spec !== undefined ? validateSpec(update.spec, catalogValidator())
		: update.patch ? applySpecPatch(previous!.spec!, update.patch, catalogValidator()) : previous?.spec;
	const source = update.source === null ? undefined : update.source ?? previous?.source;
	if (source) {
		progressParser(source);
		if (!spec) throw new Error("Progress sources need a spec with state bindings.");
		if (!previous?.source && [...parts.values()].filter(part => part.source).length >= 16) throw new Error("At most 16 live progress sources are supported.");
	}
	const result: Shown = { ...(previous ?? {}), id, title: (update.title ?? previous?.title ?? id).slice(0, 200),
		items: items ?? previous?.items ?? [], persisted: true,
		...(spec ? { spec } : {}), ...(update.note !== undefined ? { note: update.note.slice(0, 20_000) } : {}),
		...(update.before !== undefined ? { before: update.before } : {}), ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
		...(update.collapsed !== undefined ? { collapsed: update.collapsed } : {}), ...(source ? { source } : {}),
	};
	if (!source) delete result.source;
	for (const element of Object.values(result.spec?.elements ?? {})) if (["File", "Image"].includes(element.type) && !result.items[Number(element.props.item)]) throw new Error("File/Image references a missing attached item.");
	if (!result.spec && !result.note?.trim() && !result.items.length) throw new Error("Provide a spec, note, file, web link, or described changes to show.");
	return result;
}

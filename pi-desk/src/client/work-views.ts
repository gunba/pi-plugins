import type { ViewSnapshot } from "../shared/protocol.ts";

/** Work's shared terminal projection is navigation, not another browser card. */
export function panelViews(views: readonly ViewSnapshot[], panel: string | undefined, focused?: string): ViewSnapshot[] {
	return views.filter(view => view.kind !== "work" && view.kind !== "conversation" && (panel === "view" ? view.id === focused : view.surface !== "settings"));
}

export function openView(view: string, section?: string): { panel: "workspace" | "view"; focused?: string } {
	const last = view.lastIndexOf("/") + 1;
	if (view.slice(last) === "party") return { panel: "workspace", focused: view };
	if (view.slice(last) !== "work") return { panel: "view", focused: view };
	return { panel: "workspace", focused: section ? `${view.slice(0, last)}${section}` : undefined };
}

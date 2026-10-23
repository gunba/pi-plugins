import type { ViewSnapshot } from "../shared/protocol.ts";

/** Work's shared terminal projection is navigation, not another browser card. */
export function panelViews(views: readonly ViewSnapshot[], focused?: string): ViewSnapshot[] {
	return views.filter(view => view.kind !== "work" && view.kind !== "conversation" && view.id === focused);
}

export function openView(view: string, section?: string): { panel: "view"; focused?: string } {
	const last = view.lastIndexOf("/") + 1;
	if (view.slice(last) !== "work") return { panel: "view", focused: view };
	return { panel: "view", focused: section ? `${view.slice(0, last)}${section}` : undefined };
}

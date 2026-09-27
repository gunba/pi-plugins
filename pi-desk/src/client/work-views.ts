import type { ViewSnapshot } from "../shared/protocol.ts";

/** Work's shared terminal projection is navigation, not another browser card. */
export function panelViews(views: readonly ViewSnapshot[], panel: string | undefined, focused?: string): ViewSnapshot[] {
	return views.filter(view => view.kind !== "work" && view.kind !== "conversation" && (panel === "view" ? view.id === focused : view.surface !== "settings"));
}

export function openView(view: string, section?: string): { panel: "work" | "view"; focused?: string } {
	const last = view.lastIndexOf("/") + 1;
	if (view.slice(last) !== "work") return { panel: "view", focused: view };
	const target = section === "scheduled" ? "scheduler" : section;
	return { panel: "work", focused: target ? `${view.slice(0, last)}${target}` : undefined };
}

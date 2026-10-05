import type { UiAction, UiConversation, UiDetails } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";

export interface AgentRow {
	id: string; title: string; subtitle?: string; status: string; view?: ViewSnapshot; action?: UiAction;
}
export function agentInventory(views: readonly ViewSnapshot[]) {
	const conversations = views.filter(view => view.kind === "conversation");
	const current = conversations.filter(view => {
		const data = view.data as UiConversation;
		return data.active || Number(data.fields?.find(field => field.label === "Queued tasks")?.value ?? 0) > 0;
	});
	const historyView = views.find(view => view.id === "subagents" && view.kind === "details");
	const history = new Map<string, AgentRow>();
	for (const item of (historyView?.data as UiDetails | undefined)?.items ?? []) {
		const id = `agent:${item.id}`;
		history.set(id, { id, title: item.title, subtitle: item.subtitle, status: item.status ?? "finished", action: item.actions?.[0] });
	}
	for (const view of conversations) if (!current.includes(view)) {
		const data = view.data as UiConversation;
		history.set(view.id, { ...history.get(view.id), id: view.id, title: view.title, subtitle: data.subtitle, status: data.status, view });
	}
	return { current, history: [...history.values()], historyView, total: current.length + history.size };
}

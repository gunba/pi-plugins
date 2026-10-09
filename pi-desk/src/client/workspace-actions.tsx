import type { UiAction } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { ActionMenu } from "./action-menu.tsx";
import { Icon } from "./icons.tsx";

export function WorkspaceActions({ view, invoke, disabled }: {
	view: ViewSnapshot; invoke: (action: UiAction) => void; disabled?: boolean;
}) {
	const kind = view.id.split("/").at(-1), actions = view.actions ?? [];
	const primary = actions.find(action => action.id === (kind === "messages" ? "discover" : kind === "subagents" ? "launch" : "create"));
	const settings = kind === "subagents" ? actions.find(action => action.id === "launch-settings") : undefined;
	const other = actions.filter(action => action !== primary && action !== settings);
	return <div className="workspace-actions">
		{primary && <button className="quiet-action workspace-primary" disabled={disabled} onClick={() => invoke(primary)}>
			<Icon name={kind === "messages" ? "chat" : "plus"} />{primary.label}</button>}
		{settings && <button className="icon-button" title="Agent launch settings" aria-label="Agent launch settings" disabled={disabled}
			onClick={() => invoke(settings)}><Icon name="sliders" /></button>}
		<ActionMenu actions={other} invoke={invoke} disabled={disabled} label={`${view.title} actions`} />
	</div>;
}

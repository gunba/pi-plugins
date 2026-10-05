import type { UiAction } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { ActionMenu } from "./action-menu.tsx";
import { Icon } from "./icons.tsx";

export function WorkspaceActions({ view, invoke, disabled, manageParty }: {
	view: ViewSnapshot; invoke: (action: UiAction) => void; disabled?: boolean; manageParty?: () => void;
}) {
	const kind = view.id.split("/").at(-1), actions = view.actions ?? [];
	const primary = actions.find(action => action.id === (kind === "party" ? "broadcast" : kind === "subagents" ? "launch" : "create"));
	const settings = kind === "subagents" ? actions.find(action => action.id === "launch-settings") : undefined;
	const other = actions.filter(action => action !== primary && action !== settings
		&& !(manageParty && ["join", "leave", "discover"].includes(action.id)));
	return <div className="workspace-actions">
		{primary && <button className="quiet-action workspace-primary" disabled={disabled} onClick={() => invoke(primary)}>
			<Icon name={kind === "party" ? "chat" : "plus"} />{primary.label}</button>}
		{settings && <button className="icon-button" title="Agent launch settings" aria-label="Agent launch settings" disabled={disabled}
			onClick={() => invoke(settings)}><Icon name="sliders" /></button>}
		{manageParty && <button className="icon-button" title="Manage party members" aria-label="Manage party members" disabled={disabled}
			onClick={manageParty}><Icon name="party" /></button>}
		<ActionMenu actions={other} invoke={invoke} disabled={disabled} label={`${view.title} actions`} />
	</div>;
}

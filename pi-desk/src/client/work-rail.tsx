import { useEffect, useState } from "react";
import type { UiAction, UiConversation, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import type { ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { Icon, SectionIcon } from "./icons.tsx";
import { PlanView } from "./plan-view.tsx";
import { DetailsView } from "./details-view.tsx";
import { Disclosure } from "./disclosure.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { WorkspaceActions } from "./workspace-actions.tsx";
import { agentInventory } from "./agent-inventory.ts";
import { activityLabel, leadingActivity } from "./activity.ts";

const preference = (key: string): string[] => {
	try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value : []; }
	catch { return []; }
};
const names: Record<string, string> = { subagents: "Agents", party: "Party", plan: "Plan" };
export function WorkRail({ views, connected, invoke, openAgents, openView, manageParty, focused, embedded }: {
	views: readonly ViewSnapshot[]; connected: boolean; invoke: (command: WorkerCommand) => void;
	openAgents: (id?: string, history?: boolean) => void; openView: (id: string) => void;
	manageParty: () => void; focused?: string; embedded?: boolean;
}) {
	const [hidden, setHidden] = useState(() => preference("pi-desk:workspace-hidden"));
	const [collapsed, setCollapsed] = useState(() => preference("pi-desk:workspace-collapsed"));
	useEffect(() => { localStorage.setItem("pi-desk:workspace-hidden", JSON.stringify(hidden)); }, [hidden]);
	useEffect(() => { localStorage.setItem("pi-desk:workspace-collapsed", JSON.stringify(collapsed)); }, [collapsed]);
	useEffect(() => { if (focused) { setHidden(current => current.filter(id => id !== focused)); setCollapsed(current => current.filter(id => id !== focused)); } }, [focused]);
	const sections = views.filter(view => (!view.scope || view.id === focused) && view.surface !== "settings" && !["work", "conversation"].includes(view.kind));
	const order = ["plan", "subagents", "party", "scheduler"];
	sections.sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)));
	const inventory = agentInventory(views);
	const agentState = leadingActivity(inventory.current.map(view => (view.data as UiConversation).status ?? "idle"));
	return <aside className={`work-rail${embedded ? " embedded" : ""}`} aria-label="Workspace">
		<div className="work-rail-heading"><strong>{embedded ? "Sections" : "Workspace"}</strong>
			<details className="workspace-customize"><summary title="Customize workspace" aria-label="Customize workspace"><Icon name="sliders" /></summary>
				<div><strong>Show sections</strong>{sections.map(view => <label key={view.id}><input type="checkbox" checked={!hidden.includes(view.id)}
					onChange={event => setHidden(current => event.target.checked ? current.filter(id => id !== view.id) : [...current, view.id])} />{names[view.id] ?? view.title}</label>)}</div>
			</details>
		</div>
		<div className="work-rail-scroll">
			{sections.filter(view => !hidden.includes(view.id)).map(view => {
				const closed = collapsed.includes(view.id), locked = !connected || !!view.working;
				const action = (item: UiAction, value?: UiValue) => invoke({ kind: "action", view: view.id, revision: view.revision, action: item.id, value });
				return <section className="workspace-section" key={view.id} data-view={view.id}>
					<button className="workspace-section-heading" aria-expanded={!closed} onClick={() => setCollapsed(current => closed ? current.filter(id => id !== view.id) : [...current, view.id])}>
						<SectionIcon id={view.id} /><strong>{names[view.id] ?? view.title}</strong>
						{view.id === "subagents" && <><span className={`status-dot ${agentState}`} title={activityLabel(agentState)} /><small>{inventory.current.length} current</small></>}
						<span className={`party-chevron${closed ? "" : " expanded"}`} aria-hidden="true">›</span>
					</button>
					{!closed && <div className="workspace-section-content">
						{view.id === "plan" && view.kind === "details" ? <PlanView view={view} showHeading={false} disabled={locked}
							invoke={action} expand={() => openView(view.id)} /> : <>
							<WorkspaceActions view={view} invoke={action} disabled={locked} manageParty={view.id === "party" ? manageParty : undefined} />
							{view.working && <p className="muted" role="status">{view.working}…</p>}
							{view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
							{view.id === "subagents" ? <>
								{inventory.current.map(agent => { const data = agent.data as UiConversation; return <button key={agent.id} className="rail-agent" onClick={() => openAgents(agent.id)}>
									<span className={`status-dot ${data.status ?? (data.active ? "running" : "idle")}`} /><span>{agent.title}</span><small>{data.activity ?? activityLabel(data.status)}</small>
								</button>; })}
								{!inventory.current.length && <p className="workspace-empty">No agents working.</p>}
								{inventory.history.length > 0 && <button className="rail-agent-history" onClick={() => openAgents(undefined, true)}><Icon name="clock" />Previous agents <span>{inventory.history.length}</span><span>›</span></button>}
								<Disclosure id="agent-launch-defaults" className="workspace-secondary" summary="Launch defaults"><DetailsView data={{ fields: (view.data as UiDetails).fields }} disabled={locked} invoke={action} /></Disclosure>
							</> : view.id === "party" ? <PartyContent data={view.data as UiDetails} invoke={action} disabled={locked} />
								: view.kind === "details" ? <DetailsView data={view.data as UiDetails} disabled={locked} invoke={action} />
								: <button className="quiet-action" onClick={() => openView(view.id)}>Open {view.title}<Icon name="expand" /></button>}
						</>}
					</div>}
				</section>;
			})}
			{!sections.length && <div className="work-rail-empty"><Icon name="layers" /><p>A conversation's plan, agents and party appear here.</p></div>}
			{!!sections.length && sections.every(view => hidden.includes(view.id)) && <p className="workspace-empty">All sections hidden. Use Customize workspace to show them.</p>}
		</div>
	</aside>;
}

function PartyContent({ data, invoke, disabled }: { data: UiDetails; invoke: (action: UiAction) => void; disabled: boolean }) {
	return <div className="workspace-party">
		{data.summary && <p className="workspace-summary">{data.summary}</p>}
		{data.items?.map(item => {
			const message = item.actions?.find(action => action.id.startsWith("send:"));
			const actions = item.actions?.filter(action => action !== message && !action.id.startsWith("remove:")) ?? [];
			return <div className="workspace-peer" key={item.id}>
				<Disclosure id={`party:${item.id}`} className="workspace-peer-details" summary={<><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}{item.status && <small className="workspace-peer-status">{item.status}</small>}</>}>
					{item.body && <p className="detail-copy">{item.body}</p>}
				</Disclosure>
				{message && <button className="icon-button" title={`Message ${item.title}`} aria-label={`Message ${item.title}`} disabled={disabled} onClick={() => invoke(message)}><Icon name="chat" /></button>}
				<ActionMenu actions={actions} disabled={disabled} invoke={invoke} label={`Actions for ${item.title}`} />
			</div>;
		})}
		{!!data.fields?.length && <Disclosure id="party-delivery-details" className="workspace-secondary" summary="Delivery & session details"><DetailsView data={{ fields: data.fields }} disabled={disabled} invoke={invoke} /></Disclosure>}
	</div>;
}

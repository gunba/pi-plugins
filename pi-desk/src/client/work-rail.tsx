import type { UiConversation } from "../../../pi-ui/index.ts";
import type { ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";
import { PlanView } from "./plan-view.tsx";
import { agentInventory } from "./agent-inventory.ts";

export function WorkRail({ views, connected, invoke, openAgents, openWork, openPlan, embedded }: {
	views: readonly ViewSnapshot[]; connected: boolean; invoke: (command: WorkerCommand) => void; openAgents: (id?: string, history?: boolean) => void;
	openWork: () => void; openPlan: () => void; embedded?: boolean;
}) {
	const plan = views.find(view => view.id === "plan" && view.kind === "details" && !view.scope);
	const { current: agents, history, total } = agentInventory(views);
	return <aside className={`work-rail${embedded ? " embedded" : ""}`} aria-label="Workspace">
		<div className="work-rail-heading"><span>Workspace</span><button className="icon-button" title="Open all work" aria-label="Open all work" onClick={openWork}><Icon name="layers" /></button></div>
		<div className="work-rail-scroll">
			{plan ? <PlanView view={plan} disabled={!connected} expand={openPlan}
				invoke={action => invoke({ kind: "action", view: plan.id, revision: plan.revision, action: action.id })} />
				: <div className="work-rail-empty"><Icon name="plan" /><p>Plans appear here as you work.</p></div>}
			{total > 0 && <section className="rail-agents"><button className="rail-agents-heading" onClick={() => openAgents()}>
				<Icon name="account" /><strong>Agents</strong><span>{agents.length} current</span></button>
				{agents.map(view => { const data = view.data as UiConversation; return <button key={view.id} className="rail-agent" onClick={() => openAgents(view.id)}>
					<span className={`status-dot ${data.active ? "running" : "idle"}`} /><span>{view.title}</span><small>{data.active ? "Working" : "Idle"}</small>
				</button>; })}
				{!agents.length && <p className="muted">No active or queued agents.</p>}
				{history.length > 0 && <button className="rail-agent-history" onClick={() => openAgents(undefined, true)}>
					Previous agents <span>{history.length}</span><span>Browse →</span>
				</button>}
			</section>}
		</div>
	</aside>;
}

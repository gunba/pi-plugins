import type { UiAction, UiDetails } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";

function planParts(view: ViewSnapshot) {
	const data = view.data as UiDetails, actions = view.actions ?? [];
	const field = (label: string) => data.fields?.find(field => field.label === label)?.value;
	const automatic = field("Continuation")?.startsWith("Automatic");
	const primary = actions.find(action => action.id === "resume" || action.id === "complete")
		?? (automatic ? actions.find(action => action.id === "pause") : undefined)
		?? actions.find(action => action.id === "create");
	const add = actions.find(action => action.id === "add");
	return { data, actions, field, automatic, primary, add };
}

/** Pause/resume, expand and the rest of the plan's actions, for a heading row rather than beside the objective. */
export function PlanControls({ view, invoke, disabled, expand }: {
	view: ViewSnapshot; invoke: (action: UiAction) => void; disabled?: boolean; expand?: () => void;
}) {
	const { actions, primary, add } = planParts(view), locked = disabled || !!view.working;
	return <div className="plan-controls">
		{primary && <button type="button" className="quiet-action" disabled={locked} onClick={() => invoke(primary)}>
			<Icon name={primary.id === "pause" ? "pause" : primary.id === "resume" ? "play" : primary.id === "create" ? "plus" : "check"} />{primary.label}</button>}
		{expand && <button type="button" className="icon-button" title="Expand plan" aria-label="Expand plan" onClick={expand}><Icon name="expand" /></button>}
		<ActionMenu actions={actions.filter(action => action !== primary && action !== add)} invoke={invoke} disabled={locked} label="Plan actions" />
	</div>;
}

export function PlanView({ view, invoke, disabled, showHeading = true, controls = true, expand }: {
	view: ViewSnapshot; invoke: (action: UiAction) => void; disabled?: boolean; showHeading?: boolean;
	/** False when the surrounding heading row shows PlanControls. */
	controls?: boolean; expand?: () => void;
}) {
	const { data, field, automatic, add } = planParts(view), items = data.items ?? [];
	const completed = items.filter(item => item.status === "completed").length;
	const locked = disabled || !!view.working;
	return <section className="plan-view" aria-label="Plan">
		{(showHeading || controls) && <header className="plan-heading">{showHeading ? <span><Icon name="plan" /><strong>Plan</strong></span> : <span />}
			{controls && <PlanControls view={view} invoke={invoke} disabled={disabled} expand={expand} />}</header>}
		<div className="plan-objective"><p>{data.summary}</p></div>
		{view.actionError && <p role="alert" className="error-text">{view.actionError}</p>}
		{items.length > 0 && <div className="plan-progress">
			<div><span>{completed} of {items.length} complete</span><span className="plan-phase">{field("State")}</span></div>
			<progress value={completed} max={items.length} aria-label="Plan progress" />
		</div>}
		{field("Blocker") && <p className="plan-blocker">{field("Blocker")}</p>}
		<ol className="plan-steps">{items.map((item, index) => {
			const status = item.actions?.find(action => action.id.startsWith("status:"));
			const mark = item.status === "completed" ? <Icon name="check" /> : item.status === "in progress" ? <span className="step-active-dot" /> : <span>{index + 1}</span>;
			return <li className={`plan-step ${item.status?.replaceAll(" ", "-")}`} key={item.id}>
				{status ? <button className="step-status" disabled={locked} aria-label={`Change status: ${item.title} (${item.status})`}
					title={`Change status · ${item.status}`} onClick={() => invoke(status)}><span className="step-marker">{mark}</span></button>
					: <span className="step-status" aria-label={item.status}><span className="step-marker">{mark}</span></span>}
				<div className="step-content"><span>{item.title}</span>{item.status === "in progress" && <small>In progress</small>}</div>
				<ActionMenu actions={item.actions?.filter(action => action !== status) ?? []} invoke={invoke}
					disabled={locked} label={`Actions for step ${index + 1}`} />
			</li>;
		})}</ol>
		<footer className="plan-footer">
			{add && <button className="quiet-action" disabled={locked} onClick={() => invoke(add)}><Icon name="plus" />Add step</button>}
			{field("Continuation") && <span title={`Rounds ${field("Rounds") ?? "0"} · Revision ${field("Revision") ?? ""}`}>
				{automatic ? field("Continuation") : "Manual continuation"}</span>}
		</footer>
	</section>;
}

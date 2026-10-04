import type { UiAction, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import { ExternalLinks } from "./external-links.tsx";
import { SettingControl } from "./settings-controls.tsx";

export function DetailsView({ data, invoke, disabled }: {
	data: UiDetails; invoke: (action: UiAction, value?: UiValue) => void; disabled?: boolean;
}) {
	return <>
		{data.summary && <p className="detail-copy">{data.summary}</p>}
		<ExternalLinks links={data.links} />
		{data.controls?.map(control => <SettingControl key={control.action.id} control={control} invoke={invoke} disabled={disabled} />)}
		{data.fields && <dl className="detail-fields">{data.fields.map(field => <div key={field.label}>
			<dt>{field.label}</dt><dd>{field.value}</dd>
		</div>)}</dl>}
		{data.items?.map(item => <article className="detail-item" key={item.id}>
			<div className="detail-item-heading"><div><strong>{item.title}</strong>
				{item.subtitle && <small>{item.subtitle}</small>}</div>
				{item.status && <span className="detail-status">{item.status}</span>}</div>
			{item.meter && <progress className="detail-meter" value={item.meter.value} max={item.meter.max} aria-label={item.meter.label} />}
			{item.body && <p className="detail-copy">{item.body}</p>}
			{item.actions && <div className="panel-actions">{item.actions.map(action =>
				<button key={action.id} disabled={disabled} className={action.destructive ? "danger" : undefined}
					onClick={() => invoke(action)}>{action.label}</button>)}</div>}
		</article>)}
	</>;
}

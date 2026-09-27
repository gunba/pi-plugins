import type { UiAction, UiDetails } from "../../../pi-ui/index.ts";
import { ExternalLinks } from "./external-links.tsx";

export function DetailsView({ data, invoke, disabled }: { data: UiDetails; invoke: (action: UiAction) => void; disabled?: boolean }) {
	return <>
		{data.summary && <p className="detail-copy">{data.summary}</p>}
		<ExternalLinks links={data.links} />
		{data.fields && <dl className="detail-fields">{data.fields.map(field => <div key={field.label}>
			<dt>{field.label}</dt><dd>{field.value}</dd>
		</div>)}</dl>}
		{data.items?.map(item => <article className="history-item" key={item.id}>
			<strong>{item.title}</strong>
			{item.subtitle && <small>{item.subtitle}</small>}
			{item.status && <small>{item.status}</small>}
			{item.meter && <progress className="detail-meter" value={item.meter.value} max={item.meter.max} aria-label={item.meter.label} />}
			{item.body && <p className="detail-copy">{item.body}</p>}
			{item.actions && <div className="panel-actions">{item.actions.map(action =>
				<button key={action.id} disabled={disabled} className={action.destructive ? "danger" : undefined}
					onClick={() => invoke(action)}>{action.label}</button>)}</div>}
		</article>)}
	</>;
}

import type { UiAction, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import { ExternalLinks } from "./external-links.tsx";
import { SettingControl } from "./settings-controls.tsx";
import { Icon, ProviderIcon } from "./icons.tsx";

export function DetailsView({ data, invoke, disabled, accounts = false }: {
	data: UiDetails; invoke: (action: UiAction, value?: UiValue) => void; disabled?: boolean; accounts?: boolean;
}) {
	if (accounts) return <div className="accounts-view">
		<p className="settings-intro">Manage model sign-ins on this computer.</p>
		<div className="account-search">{data.controls?.map(control =>
			<SettingControl key={control.action.id} control={control} invoke={invoke} disabled={disabled} />)}</div>
		<div className="account-list">{data.items?.map(item => {
			const configured = item.status?.startsWith("Configured");
			const source = item.status?.split(" · ")[1];
			return <article className="account-card" key={item.id}>
				<div className="account-heading"><ProviderIcon id={item.id} title={item.title} />
					<div className="account-name"><strong>{item.title}</strong>
						{source && <small>{source === "stored" ? "Saved on this computer" : source === "environment" ? "From environment" : source}</small>}</div>
					<span className={`account-status${configured ? " configured" : ""}`}>{configured ? <><Icon name="check" />Configured</> : "Not configured"}</span>
				</div>
				{item.body && <p className="account-identity">{item.body}</p>}
				{!!item.actions?.length && <div className="account-actions">{item.actions.map(action => {
					const login = action.id.startsWith("login:"), label = login && !configured ? "Sign in" : action.label;
					return <button key={action.id} type="button" disabled={disabled}
						className={action.destructive ? "icon-button account-remove" : "quiet-action"}
						title={`${action.label} · ${item.title}`} aria-label={`${action.label} · ${item.title}`}
						onClick={() => invoke(action)}>
						<Icon name={action.destructive ? "trash" : configured ? "switch" : "login"} />
						{!action.destructive && label}
					</button>;
				})}</div>}
			</article>;
		})}</div>
		{data.summary && <details className="account-help"><summary><Icon name="info" />How sign-in works</summary><p>{data.summary}</p></details>}
	</div>;
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

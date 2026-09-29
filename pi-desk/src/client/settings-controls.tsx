import { useEffect, useId, useState, type CSSProperties } from "react";
import type { UiAction, UiControl, UiValue } from "../../../pi-ui/index.ts";

export function SettingControl({ control, invoke, disabled }: {
	control: UiControl; invoke: (action: UiAction, value?: UiValue) => void; disabled?: boolean;
}) {
	const id = useId();
	const [draft, setDraft] = useState(String(control.value));
	useEffect(() => setDraft(String(control.value)), [control.value]);
	const locked = disabled || control.disabled;
	const save = () => {
		if (locked || draft === String(control.value)) return;
		const value = control.kind === "range" ? Number(draft) : draft;
		if (control.kind === "range" && (!Number.isSafeInteger(value) || Number(value) < control.min || Number(value) > control.max)) return;
		invoke(control.action, value);
	};
	return <div className={`setting-control setting-${control.kind}`}>
		<label htmlFor={id}>{control.label}</label>
		{control.kind === "toggle" ? <input id={id} type="checkbox" role="switch" checked={control.value} disabled={locked}
			onChange={event => invoke(control.action, event.target.checked)} />
			: control.kind === "select" ? <select id={id} value={control.value} disabled={locked}
				onChange={event => invoke(control.action, event.target.value)}>
				{control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
			</select>
			: control.kind === "text" ? <input id={id} type="search" value={draft} placeholder={control.placeholder}
				disabled={locked} onChange={event => setDraft(event.target.value)} onBlur={save}
				onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
			: <form onSubmit={event => { event.preventDefault(); save(); }}>
				<div className="budget-ruler">
					<ContextMeter capacity={control.max} limit={Number(draft) || control.value} used={control.used} />
					<input type="range" aria-label={`${control.label} slider`} min={0} aria-valuemin={control.min} max={control.max} step={control.step ?? 1}
						value={Number(draft) || control.min} disabled={locked} onChange={event => setDraft(String(Math.max(control.min, Number(event.target.value))))} />
				</div>
				<div className="budget-values"><span>0</span><span>{control.max.toLocaleString()} {control.unit}</span></div>
				<div className="budget-entry">
					<input id={id} type="number" min={control.min} max={control.max} step={control.step ?? 1}
						value={draft} required disabled={locked} onChange={event => setDraft(event.target.value)} />
					<span>{control.unit}</span><button disabled={locked || draft === String(control.value)}>{control.action.label}</button>
				</div>
			</form>}
		{control.help && <p className="muted setting-help">{control.help}</p>}
	</div>;
}
export function ContextMeter({ capacity, limit, used }: { capacity: number; limit: number; used?: number | null }) {
	const percent = (value: number) => `${Math.min(100, Math.max(0, value / Math.max(1, capacity) * 100))}%`;
	return <span className={`context-meter${used != null && used > limit ? " over-budget" : ""}`}
		role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={used ?? 0}
		aria-valuetext={`${used == null ? "Usage not measured" : `${used.toLocaleString()} tokens used`}; budget ${limit.toLocaleString()}; capacity ${capacity.toLocaleString()}`}
		style={{ "--context-used": percent(used ?? 0), "--context-limit": percent(limit) } as CSSProperties}>
		<span className="context-allowed" /><span className="context-used" /><span className="context-stop" />
	</span>;
}

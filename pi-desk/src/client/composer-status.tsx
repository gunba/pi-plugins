import { useState, type ReactNode } from "react";
import type { UiAction, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import type { SessionView, ViewSnapshot } from "../shared/protocol.ts";
import { ContextMeter } from "./settings-controls.tsx";
import { sessionActivity } from "./activity.ts";
import { useAnchoredPopover } from "./anchored-popover.ts";
import { Icon } from "./icons.tsx";

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const tokens = (value: number) => tokenFormat.format(value);
export function ComposerStatus({ session, computer, connected, disabled, preferences, shortcutHint, open, invoke }: {
	session: SessionView; computer: string; connected: boolean; disabled?: boolean;
	preferences: ReactNode; shortcutHint: string;
	open: (view: ViewSnapshot) => void;
	invoke: (view: ViewSnapshot, action: UiAction, value: UiValue) => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const menu = useAnchoredPopover(session.key, false, 340);
	const snapshot = session.snapshot;
	const badges = (session.ui?.views ?? []).filter(view => !view.scope).flatMap(view => (view.badges ?? []).map(badge => ({ ...badge, view })));
	const context = snapshot?.context, usage = snapshot?.usage;
	const contextView = session.ui?.views.find(view => !view.scope && view.context);
	const capacity = contextView?.context?.capacity ?? context?.contextWindow;
	const limit = contextView?.context?.limit ?? context?.contextWindow;
	const state = session.controls?.some(control => control.kind === "close" && control.state === "running") ? "Closing"
		: session.reconnecting ? "Reconnecting" : session.state === "starting" ? "Starting" : session.state === "closed" ? "Closed" : session.state === "failed" ? "Unavailable"
			: snapshot?.activity === "waiting" ? "Waiting for input" : snapshot?.activity === "running" ? "Working" : snapshot?.activity === "error" ? "Needs attention" : "Idle";
	const contextTitle = `Context budget${capacity ? ` · ${tokens(capacity)} model capacity` : ""}`;
	const contextControl = <button type="button" className="composer-context" disabled={!contextView || disabled || !connected} title={contextTitle}
		onClick={() => { if (contextView) { menu.close(); open(contextView); } }}>
		{capacity && limit ? <><ContextMeter capacity={capacity} limit={limit} used={context?.tokens} />
			<span>{context?.tokens == null ? "—" : tokens(context.tokens)} / {tokens(limit)}</span></> : "Context not measured"}
	</button>;
	const badgeControl = (badge: typeof badges[number], index: number) => {
		const control = badge.view.kind === "details" ? (badge.view.data as UiDetails | null)?.controls?.find(item => item.action.id === badge.control) : undefined;
		const key = `${badge.view.id}/${index}`, locked = disabled || !connected || pending || !!badge.view.working || control?.disabled;
		return control?.kind === "toggle" ? <button type="button" key={key} className="composer-badge composer-toggle"
			title={control.help ?? badge.description} aria-label={control.label} aria-pressed={control.value} disabled={locked}
			onClick={async () => { if (pending) return; setPending(true); try { await invoke(badge.view, control.action, !control.value); } finally { setPending(false); } }}>
			{badge.label} <strong>{badge.value}</strong>
		</button> : control?.kind === "select" ? <label className="composer-badge composer-select" key={key} title={control.help ?? badge.description}>
			<span>{badge.label}</span><select aria-label={control.label} value={control.value} disabled={locked}
				onChange={async event => { const value = event.target.value; if (pending) return; setPending(true); try { await invoke(badge.view, control.action, value); } finally { setPending(false); } }}>
				{control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
			</select>
		</label> : <span className="composer-badge" key={key} title={badge.description ?? `${badge.label} ${badge.value}`}>{badge.label} {badge.value}</span>;
	};
	return <div className="composer-status">
		<div className="composer-status-inline">{contextControl}<div className="composer-badges-inline">{badges.filter(badge => badge.compact).map(badgeControl)}</div></div>
		<button type="button" className="composer-status-trigger" ref={menu.trigger} popoverTarget={menu.id}
			aria-label={`${connected ? state : "Disconnected"} · Conversation status and options`} title="Conversation status and options" aria-haspopup="dialog" aria-expanded={menu.open}>
			<span className={`status-dot ${connected ? sessionActivity(session) : "offline"}`} /><Icon name="more" />
		</button>
		<div ref={menu.panel} id={menu.id} popover="auto" className="composer-status-menu" role="dialog" aria-label="Conversation status and options"
			onBeforeToggle={menu.beforeToggle} onToggle={menu.toggle} onKeyDown={menu.keyDown}>
			<div className="composer-status-heading" tabIndex={-1} data-autofocus><strong>{connected ? state : "Disconnected"}</strong><span>{computer}</span></div>
			<div className="composer-overflow-preferences">{preferences}</div>
			<div className="composer-status-section">{contextControl}{badges.map(badgeControl)}</div>
			{usage && <div className="composer-status-section composer-usage">
				<strong>Recorded usage · ${usage.cost.toFixed(2)}</strong>
				<span>↑{tokens(usage.input)} input · ↓{tokens(usage.output)} output</span>
				<span>{tokens(usage.cacheRead)} cache read · {tokens(usage.cacheWrite)} cache write</span>
				<small>Recorded totals, not a subscription balance.</small>
			</div>}
			<p className="composer-shortcuts">{shortcutHint}</p>
		</div>
	</div>;
}

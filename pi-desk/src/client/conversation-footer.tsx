import { useState } from "react";
import type { UiAction, UiDetails, UiValue } from "../../../pi-ui/index.ts";
import type { SessionView, ViewSnapshot } from "../shared/protocol.ts";
import { ContextMeter } from "./settings-controls.tsx";
import { sessionActivity } from "./activity.ts";

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const tokens = (value: number) => tokenFormat.format(value);
export function ConversationFooter({ session, computer, connected, disabled, open, invoke }: {
	session: SessionView; computer: string; connected: boolean; disabled?: boolean;
	open: (view: ViewSnapshot) => void;
	invoke: (view: ViewSnapshot, action: UiAction, value: UiValue) => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const snapshot = session.snapshot;
	const badges = (session.ui?.views ?? []).filter(view => !view.scope).flatMap(view => (view.badges ?? []).map(badge => ({ ...badge, view })));
	const context = snapshot?.context, usage = snapshot?.usage;
	const contextView = session.ui?.views.find(view => !view.scope && view.context);
	const capacity = contextView?.context?.capacity ?? context?.contextWindow;
	const limit = contextView?.context?.limit ?? context?.contextWindow;
	const state = session.controls?.some(control => control.kind === "close" && control.state === "running") ? "Closing"
		: session.state === "starting" ? "Starting" : session.state === "closed" ? "Closed" : session.state === "failed" ? "Unavailable"
			: snapshot?.activity === "waiting" ? "Waiting for input" : snapshot?.activity === "running" ? "Working" : snapshot?.activity === "error" ? "Needs attention" : "Idle";
	const contextTitle = `Context budget${capacity ? ` · ${tokens(capacity)} model capacity` : ""}`;
	return <div className="conversation-footer">
		<button type="button" className="footer-context" disabled={!contextView || disabled || !connected} title={contextTitle}
			onClick={() => { if (contextView) open(contextView); }}>
			{capacity && limit ? <><ContextMeter capacity={capacity} limit={limit} used={context?.tokens} />
				<span>{context?.tokens == null ? "—" : tokens(context.tokens)} / {tokens(limit)}</span></> : "Context not measured"}
		</button>
		{badges.map((badge, index) => {
			const control = badge.view.kind === "details" ? (badge.view.data as UiDetails | null)?.controls?.find(item => item.action.id === badge.control) : undefined;
			const className = `footer-badge${badge.compact ? "" : " footer-extra"}`;
			return control?.kind === "toggle" ? <button type="button" key={`${badge.view.id}/${index}`} className={`${className} footer-toggle`}
				title={control.help ?? badge.description} aria-label={control.label} aria-pressed={control.value}
				disabled={disabled || !connected || pending || !!badge.view.working || control.disabled}
				onClick={async () => { if (pending) return; setPending(true); try { await invoke(badge.view, control.action, !control.value); } finally { setPending(false); } }}>
				{badge.label} <strong>{badge.value}</strong>
			</button> : control?.kind === "select" ? <label className={`${className} footer-select`} key={`${badge.view.id}/${index}`} title={control.help ?? badge.description}>
				<span>{badge.label}</span><select aria-label={control.label} value={control.value}
					disabled={disabled || !connected || pending || !!badge.view.working || control.disabled}
					onChange={async event => { const value = event.target.value; if (pending) return; setPending(true); try { await invoke(badge.view, control.action, value); } finally { setPending(false); } }}>
					{control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
				</select>
			</label> : <span className={className} key={`${badge.view.id}/${index}`} title={badge.description}>{badge.label} {badge.value}</span>;
		})}
		{usage && <span className="footer-usage" title={`Recorded totals: ${tokens(usage.input)} input · ${tokens(usage.output)} output · ${tokens(usage.cacheRead)} cache read · ${tokens(usage.cacheWrite)} cache write. Not a subscription balance.`}>
			<span className="footer-usage-tokens">↑{tokens(usage.input)} ↓{tokens(usage.output)} · </span>${usage.cost.toFixed(2)}
		</span>}
		<span className="footer-state" title={`${computer} · ${session.cwd}${!connected ? " · last known state" : ""}`}>
			<span className={`status-dot ${connected ? sessionActivity(session) : "offline"}`} />{connected ? state : "Disconnected"}
		</span>
	</div>;
}

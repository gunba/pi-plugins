import { useEffect, useState, type ReactNode } from "react";
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
			<span title={context?.estimated ? "Estimated from message lengths; no provider-reported usage applies." : undefined}>
				{context?.tokens == null ? "—" : `${context.estimated ? "~" : ""}${tokens(context.tokens)}`} / {tokens(limit)}</span></> : "Context not measured"}
	</button>;
	// Countdowns tick every 15 seconds while visible.
	const [now, setNow] = useState(Date.now());
	useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 15_000); return () => clearInterval(timer); }, []);
	/** Time left before the provider drops this conversation's prompt cache; a running turn keeps it fresh. */
	const cacheGauge = () => {
		const cache = snapshot?.cache;
		if (!cache) return null;
		const live = snapshot?.activity === "running", left = live ? cache.ttlMs : Math.max(0, cache.usedAt + cache.ttlMs - now);
		const expires = new Date(cache.usedAt + cache.ttlMs);
		const title = live ? "Prompt cache: kept warm while Pi works."
			: left ? `Prompt cache: expires at ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} unless a message is sent.\nAfter that, the next message pays to cache the whole conversation again.`
			: "Prompt cache: expired. The next message pays to cache the whole conversation again.";
		return <span className={`usage-gauge usage-gauge-cache${left ? "" : " expired"}`} title={title}>
			<span className="usage-gauge-label">Cache</span>
			<span className="usage-gauge-value">{live ? "live" : left ? countdown(left) : "expired"}</span>
		</span>;
	};
	/** How much of this conversation's spend went on reading its cache: the cost the 97% hit rate hides. */
	const spendGauge = () => {
		const costs = usage?.costs, total = usage?.cost ?? 0;
		if (!costs || total <= 0) return null;
		const share = (value: number) => `${Math.round(value / total * 100)}%`, money = (value: number) => `$${value.toFixed(value < 10 ? 2 : 0)}`;
		const title = [`This conversation's spend at API prices: ${money(total)}, including compaction and child agents.`,
			`Cache reads ${money(costs.cacheRead)} (${share(costs.cacheRead)})`, `Uncached input ${money(costs.input)} (${share(costs.input)})`,
			`Cache writes ${money(costs.cacheWrite)} (${share(costs.cacheWrite)})`, `Output ${money(costs.output)} (${share(costs.output)})`,
			usage?.missed?.count ? `Lost to ${usage.missed.count} cache miss${usage.missed.count === 1 ? "" : "es"}: ${money(usage.missed.cost)} (${tokens(usage.missed.tokens)} tokens billed again)` : "No cache misses."].join("\n");
		return <span className="usage-gauge usage-gauge-spend" title={title}>
			<span className="usage-gauge-label">Cache spend</span>
			<span className="usage-gauge-value">{share(costs.cacheRead)}</span>
		</span>;
	};
	/** A remaining allowance drawn as a gauge; older workers send only "NN% left · resets in …". */
	const gauge = (badge: typeof badges[number]) => {
		if (badge.meter) return badge.meter;
		const left = /^(\d{1,3})% left/.exec(badge.value);
		return left ? { value: Number(left[1]), max: 100, resetsAt: undefined } : undefined;
	};
	const usageBadge = (badge: typeof badges[number], index: number) => {
		const meter = gauge(badge)!, percent = Math.max(0, Math.min(100, meter.value / Math.max(1, meter.max) * 100));
		const reset = meter.resetsAt ? new Date(meter.resetsAt) : undefined, until = reset ? countdown(reset.getTime() - now) : /· resets in (.+)$/.exec(badge.value)?.[1];
		const resetText = reset ? ` · resets ${reset.toDateString() === new Date().toDateString() ? reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: reset.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : (/· (resets in .+)$/.exec(badge.value)?.[1] ? ` · ${/· (resets in .+)$/.exec(badge.value)![1]}` : "");
		const kind = badge.label === "5h" ? " usage-gauge-session" : /^week/i.test(badge.label) ? " usage-gauge-week" : "";
		return <span className={`usage-gauge${kind}${percent <= 10 ? " critical" : percent <= 25 ? " low" : ""}`} key={`${badge.view.id}/${index}`}
			title={`${badge.label === "Weekly" ? "Weekly" : `${badge.label}`} allowance: ${Math.round(percent)}% left${resetText}${badge.description ? `\n${badge.description}` : ""}`}>
			<span className="usage-gauge-label">{badge.label === "Weekly" ? "Week" : badge.label}</span>
			<span className="usage-gauge-value">{Math.round(percent)}%</span>
			{until && <span className="usage-gauge-reset">{until}</span>}
		</span>;
	};
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
		<div className="composer-status-inline"><div className="composer-context-inline">{contextControl}</div>
			<div className="composer-facts-inline">{cacheGauge()}{spendGauge()}{badges.filter(badge => !badge.control).map((badge, index) => gauge(badge) ? usageBadge(badge, index) : badgeControl(badge, index))}</div>
			<div className="composer-badges-inline">{badges.filter(badge => badge.compact && badge.control).map(badgeControl)}</div>
		</div>
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

/** Time until a reset, short enough for the status bar: "45m", "2h 10m", "3d 4h". */
function countdown(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

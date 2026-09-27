import type { SessionView, ViewSnapshot } from "../shared/protocol.ts";

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const tokens = (value: number) => tokenFormat.format(value);
export function ConversationFooter({ session, computer, connected, open }: {
	session: SessionView; computer: string; connected: boolean; open: (view: ViewSnapshot) => void;
}) {
	const snapshot = session.snapshot;
	const badges = (session.ui?.views ?? []).filter(view => !view.scope).flatMap(view => (view.badges ?? []).map(badge => ({ ...badge, view })));
	const context = snapshot?.context, usage = snapshot?.usage;
	const state = session.controls?.some(control => control.kind === "close" && control.state === "running") ? "Closing"
		: session.state === "starting" ? "Starting" : session.state === "closed" ? "Closed" : session.state === "failed" ? "Stopped"
			: snapshot?.activity === "waiting" ? "Waiting for input" : snapshot?.activity === "running" ? "Working" : snapshot?.activity === "error" ? "Needs attention" : "Idle";
	const statuses = Object.entries(session.ui?.statuses ?? {}).filter(([key, value]) => !key.startsWith("scope:") && value);
	return <details className="conversation-footer">
		<summary>
			<span className="footer-model" title={snapshot?.model ? `${snapshot.model.provider} / ${snapshot.model.id}` : "No model selected"}>
				{snapshot?.model?.name ?? "No model"}{snapshot && ` · ${snapshot.thinking === "off" ? "thinking off" : snapshot.thinking}`}
			</span>
			<span>{context?.percent == null ? "Context —" : `${context.percent.toFixed(1)}% context`}</span>
			{badges.map((badge, index) => <span className={`footer-badge${badge.compact ? "" : " footer-extra"}`} key={`${badge.view.id}/${index}`} title={badge.description}>{badge.label} {badge.value}</span>)}
			{usage && <span className="footer-usage" title="Recorded session totals, including saved child usage">↑{tokens(usage.input)} ↓{tokens(usage.output)} · ${usage.cost.toFixed(3)}</span>}
			<span className="footer-state">{connected ? state : "Disconnected"}</span>
			<span className="footer-expand" aria-label="Conversation details">⌄</span>
		</summary>
		<div className="footer-details">
			<p>{computer} · {state}{!connected && " · last known state"}<br /><span className="muted">{session.cwd}</span></p>
			{snapshot?.model && <p>{snapshot.model.provider} / {snapshot.model.id} · {snapshot.thinking} thinking</p>}
			<p>Context: {context?.tokens == null ? "not reported" : `${tokens(context.tokens)} tokens`}
				{context && ` / ${tokens(context.contextWindow)} capacity`}</p>
			{usage ? <p>Recorded tokens: {tokens(usage.input)} input · {tokens(usage.output)} output · {tokens(usage.cacheRead)} cache read · {tokens(usage.cacheWrite)} cache write
				<br />Recorded cost: ${usage.cost.toFixed(3)}. Not a subscription balance.</p> : <p>Session usage has not been reported.</p>}
			{badges.map((badge, index) => <p key={`${badge.view.id}/${index}`}>
				<button type="button" onClick={() => open(badge.view)}>{badge.label}: {badge.value}</button> {badge.description}
			</p>)}
			{statuses.length > 0 && <ul>{statuses.map(([key, text]) => <li key={key}>{text}</li>)}</ul>}
		</div>
	</details>;
}

import { useEffect, useState } from "react";
import { api } from "./connection.ts";
import type { Computer, WorkspaceState } from "./workspace.ts";
import type { Cause, EfficiencyReport, Period } from "../host/efficiency.ts";

const money = (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString()}`;
const percent = (part: number, whole: number) => whole > 0 ? `${(part / whole * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "—";
const date = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
const CAUSES: Record<Cause, string> = {
	expiry: "Cache lifetime passed", switch: "Model or thinking changed", prompt: "System prompt or tools changed (tool loading, extension or Desk update)",
	contextEdit: "An extension edited earlier context", unknown: "No declared lifetime (Codex) after a long idle", unexplained: "Unexplained",
};

/** The rates the agent-efficiency plan tracks, with their targets. */
function rows(period: Period) {
	const calls = period.tools.reduce((sum, tool) => sum + tool.calls, 0), failures = period.tools.reduce((sum, tool) => sum + tool.errors, 0);
	return [
		["Spend at API prices", money(period.cost), ""],
		["Cache reads, share of spend", percent(period.costs.cacheRead, period.cost), ""],
		["First request of a turn missing a warm cache", percent(period.firstMisses, period.firstRequests), "about 2%"],
		["Compaction input read from cache", period.compactions.count ? percent(period.compactions.cacheRead, period.compactions.input) : "—", "over 90%"],
		["Codex in-turn requests that lost the cache", `${percent(period.codexLosses, period.codexInTurn)} · ${money(period.codexLossCost)}`, ""],
		["Polls and waits, share of steps", percent(period.polls, period.steps), "under 1%"],
		["Tool failures, share of calls", percent(failures, calls), "under 1.5%"],
		["Cache warming requests", `${period.cacheWarm.count} · ${money(period.cacheWarm.cost)}`, "none"],
	] as const;
}

export function EfficiencyPanel({ host, computer, connected }: { host: WorkspaceState; computer?: Computer; connected: boolean }) {
	const computers = host.computers;
	const [chosen, setChosen] = useState("");
	const id = chosen || computer?.id || computers?.find(item => item.connected)?.id;
	const [state, setState] = useState<{ report: EfficiencyReport | null; refreshing: boolean }>(), [error, setError] = useState("");
	useEffect(() => {
		if (!connected) return;
		let live = true, timer: ReturnType<typeof setTimeout> | undefined;
		const load = () => api<{ report: EfficiencyReport | null; refreshing: boolean }>("/efficiency", undefined, id).then(value => {
			if (!live) return;
			setState(value); setError("");
			if (value.refreshing) timer = setTimeout(load, 4000);
		}, failure => { if (live) setError(String(failure)); });
		load();
		return () => { live = false; clearTimeout(timer); };
	}, [id, connected]);
	const report = state?.report;
	return <>
		{computers && computers.length > 1 && <label className="setting-control">Computer<select aria-label="Report computer" value={id ?? ""} onChange={event => setChosen(event.target.value)}>
			{computers.map(item => <option key={item.id} value={item.id}>{item.name}{item.connected ? "" : " — disconnected"}</option>)}
		</select></label>}
		{error && <p className="error-text" role="alert">{error}</p>}
		{!report && <p className="muted" role="status">{state?.refreshing ? "Reading this computer's sessions… The first report takes about half a minute." : connected ? "Loading…" : "This computer is disconnected."}</p>}
		{report && <>
			<section className="panel-card efficiency-card"><h3>This week</h3>
				<p className="muted">{report.week.from} to {report.week.to}, against the week before. Read from {report.files.toLocaleString()} sessions{state?.refreshing ? "; refreshing…" : ""}.</p>
				<table className="efficiency-table"><thead><tr><th /><th>This week</th><th>Week before</th><th>Target</th></tr></thead>
					<tbody>{rows(report.week).map(([label, value, target], index) => <tr key={label}><th scope="row">{label}</th><td>{value}</td><td>{rows(report.previousWeek)[index]![1]}</td><td className="muted">{target}</td></tr>)}</tbody></table>
			</section>
			<section className="panel-card efficiency-card"><h3>Cache breaks this week</h3>
				<p className="muted">Requests that paid again for a prompt the previous request had cached, and the cost over cache reads.</p>
				<table className="efficiency-table"><thead><tr><th>Cause</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
					<tbody>{(Object.keys(CAUSES) as Cause[]).filter(cause => report.week.breaks[cause].count).sort((a, b) => report.week.breaks[b].cost - report.week.breaks[a].cost)
						.map(cause => <tr key={cause}><th scope="row">{CAUSES[cause]}</th><td>{report.week.breaks[cause].count}</td>
							<td>{Math.round(report.week.breaks[cause].tokens / 1000).toLocaleString()}k</td><td>{money(report.week.breaks[cause].cost)}</td></tr>)}</tbody></table>
			</section>
			<section className="panel-card efficiency-card"><h3>Tool failures this week</h3>
				<table className="efficiency-table"><thead><tr><th>Tool</th><th>Failed</th><th>Calls</th><th>Rate</th></tr></thead>
					<tbody>{report.week.tools.filter(tool => tool.errors).slice(0, 10).map(tool => <tr key={tool.name}><th scope="row">{tool.name}</th>
						<td>{tool.errors}</td><td>{tool.calls}</td><td>{percent(tool.errors, tool.calls)}</td></tr>)}</tbody></table>
			</section>
			<section className="panel-card efficiency-card"><h3>Recurring tool errors</h3>
				<p className="muted">The same error in more than one session, most frequent in the last 30 days. Each one is a harness fix or a fact for AGENTS.md.</p>
				<ol className="efficiency-errors">{report.recurringErrors.map(error => <li key={`${error.tool}/${error.signature}`}>
					<div><strong>{error.recent}×</strong> <span className="muted">in {error.sessions} sessions · {error.tool} · {date(error.first)}–{date(error.last)}</span></div>
					<code>{error.example}</code>
				</li>)}</ol>
			</section>
		</>}
	</>;
}

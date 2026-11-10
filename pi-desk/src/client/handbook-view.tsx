import { useState } from "react";
import type { UiAction, UiValue } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { ActionMenu } from "./action-menu.tsx";
import { Icon } from "./icons.tsx";
import { localDate, localDateTime } from "./local-format.ts";

/** The data pi-handbook publishes (pi-handbook/src/render.ts, viewData). */
type Entry = {
	id: string; kind: "instruction" | "learning"; text: string; quote: string | null; holdsWhile: string | null;
	pointsTo: string[]; missing: string[]; status: "active" | "pending" | "replaced" | "retired" | "removed" | "rejected";
	pinned: boolean; protected: boolean; reviewed: boolean; sourceAt: number | null; sources: number;
	addedAt: number; addedBy: Actor; endedAt: number | null; endedBy: Actor | null; endReason: string | null; replacedBy: string | null;
	flag: { reason: string; at: number; by: Actor; proposal: string | null } | null;
	cameUp: number; misled: number; repeated: number; lastUse: number | null;
};
type Actor = "agent" | "tidy" | "user";
type Day = { day: string; messages: number; instructions: number; corrections: number; repeats: number; changes: number };
type Data = {
	purpose: { text: string; at: number; by: Actor } | null;
	proposedPurpose: { text: string; at: number; reason: string | null } | null;
	entries: Entry[];
	/** `was`: the purpose that a change of purpose replaced. */
	log: { at: number; actor: Actor; id: string | null; text: string; reason: string | null; was: string | null }[];
	days: Day[];
	passes: { at: number; model: string; cost: number; messages: number; error: string | null }[];
	status: { running: string | null; error: string | null; nextPass: number | null; model: string | null; unread: boolean;
		sectionChars: number; sectionLimit: number; entryLimit: number };
};

const DAY = { day: "numeric", month: "short" } as const;
const date = (at: number) => localDate(at, DAY);
const who = (actor: Actor | null) => actor === "user" ? "You" : actor === "tidy" ? "Tidy-up" : "Agent";
/** The actor inside a sentence: "by the agent". */
const by = (actor: Actor | null) => actor === "user" ? "you" : actor === "tidy" ? "the tidy-up" : "the agent";
const times = (count: number) => count === 1 ? "once" : count === 2 ? "twice" : count + " times";
const dollars = (cost: number) => cost < 0.005 ? "under $0.01" : "$" + cost.toFixed(2);
const plural = (count: number, word: string, many = word + "s") => count + " " + (count === 1 ? word : many);

/** Days from first to last, a bar each, with the user's messages, corrections and repeats, and the days the handbook changed. */
function Chart({ days }: { days: Day[] }) {
	if (!days.length) return <p className="muted handbook-chart-empty">The chart starts once the tidy-up has read some of your messages.</p>;
	const byDay = new Map(days.map(day => [day.day, day]));
	const last = new Date(days.at(-1)!.day + "T12:00:00"), first = new Date(days[0]!.day + "T12:00:00");
	// Two weeks at least, so a new conversation's first days are narrow bars at the right.
	const span = Math.max(14, Math.min(56, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1));
	const rows: Day[] = [];
	for (let index = span - 1; index >= 0; index--) {
		const at = new Date(last.getTime() - index * 86_400_000);
		const key = [at.getFullYear(), String(at.getMonth() + 1).padStart(2, "0"), String(at.getDate()).padStart(2, "0")].join("-");
		rows.push(byDay.get(key) ?? { day: key, messages: 0, instructions: 0, corrections: 0, repeats: 0, changes: 0 });
	}
	const top = Math.max(1, ...rows.map(row => row.messages)), width = 600, height = 150, base = 120, slot = width / rows.length, bar = Math.max(2, slot * 0.7);
	const y = (value: number) => value / top * (base - 18);
	const totals = rows.reduce((sum, row) => ({ corrections: sum.corrections + row.corrections, repeats: sum.repeats + row.repeats, changes: sum.changes + (row.changes ? 1 : 0) }),
		{ corrections: 0, repeats: 0, changes: 0 });
	const label = (row: Day) => new Date(row.day + "T12:00:00").toLocaleDateString(undefined, DAY);
	return <figure className="handbook-chart">
		<svg viewBox={"0 0 " + width + " " + height} role="img" aria-label={"Your messages per day over " + plural(rows.length, "day") + ": "
			+ plural(totals.corrections, "correction") + ", " + plural(totals.repeats, "repeat") + ", the handbook changed on " + plural(totals.changes, "day") + "."}>
			<line x1="0" x2={width} y1={base} y2={base} className="handbook-axis" />
			{rows.map((row, index) => {
				const x = index * slot + (slot - bar) / 2, corrected = y(row.corrections), repeated = y(row.repeats);
				return <g key={row.day}>
					<title>{label(row) + ": " + plural(row.messages, "message") + ", " + plural(row.corrections, "correction") + ", "
						+ plural(row.repeats, "repeat") + (row.changes ? ", " + plural(row.changes, "handbook change") : "")}</title>
					<rect x={x} width={bar} y={base - y(row.messages)} height={y(row.messages)} className="handbook-bar-messages" rx="1" />
					{row.corrections > 0 && <rect x={x} width={bar} y={base - corrected} height={corrected} className="handbook-bar-corrections" rx="1" />}
					{row.repeats > 0 && <rect x={x} width={bar} y={base - corrected - repeated} height={repeated} className="handbook-bar-repeats" rx="1" />}
					{row.changes > 0 && <circle cx={x + bar / 2} cy={8} r={Math.min(4, bar / 2 + 1)} className="handbook-mark" />}
					{row.changes > 0 && <line x1={x + bar / 2} x2={x + bar / 2} y1={12} y2={base - y(row.messages) - 2} className="handbook-mark-line" />}
				</g>;
			})}
			{[rows[0]!, rows[Math.floor(rows.length / 2)]!, rows.at(-1)!].filter((row, index, all) => all.indexOf(row) === index).map(row =>
				<text key={row.day} x={Math.min(width - 4, Math.max(4, rows.indexOf(row) * slot + slot / 2))} y={height - 8}
					textAnchor={rows.indexOf(row) === 0 ? "start" : rows.indexOf(row) === rows.length - 1 ? "end" : "middle"} className="handbook-axis-label">{label(row)}</text>)}
		</svg>
		<figcaption className="handbook-legend">
			<span><i className="handbook-key-messages" />Your messages</span><span><i className="handbook-key-corrections" />Corrections</span>
			<span><i className="handbook-key-repeats" />Repeats</span><span><i className="handbook-key-mark" />Handbook changed</span>
		</figcaption>
	</figure>;
}

function EntryCard({ entry, act, disabled }: { entry: Entry; act: (id: string, change: string) => void; disabled: boolean }) {
	const live = entry.status === "active" || entry.status === "pending";
	const origin = entry.kind === "instruction" ? (entry.sources ? "From your message" : "Added by you") + (entry.sourceAt ? ", " + date(entry.sourceAt) : "")
		: "Added by " + by(entry.addedBy) + ", " + date(entry.addedAt);
	const use = entry.cameUp ? "Came up " + times(entry.cameUp) + (entry.lastUse ? ", last " + date(entry.lastUse) : "") : "Hasn't come up yet";
	const actions: UiAction[] = live ? [
		...(entry.status === "pending" ? [{ id: "admit", label: "Admit" }, { id: "reject", label: "Turn down" }] : []),
		...(entry.flag ? [{ id: "keep", label: "Keep as it is" }, { id: "accept", label: entry.flag.proposal ? "Use the new wording" : entry.kind === "instruction" ? "Remove it" : "Retire it" }] : []),
		{ id: entry.pinned ? "unpin" : "pin", label: entry.pinned ? "Unpin" : "Pin" }, { id: "edit", label: "Edit" },
		{ id: "remove", label: "Remove", destructive: true },
	] : [];
	const primary = actions.filter(action => ["admit", "reject", "keep", "accept"].includes(action.id));
	return <li className={"handbook-entry handbook-" + entry.kind + (live ? "" : " ended") + (entry.flag ? " flagged" : "")}>
		<div className="handbook-entry-main">
			<span className="handbook-id" title={entry.kind}>{entry.id}</span>
			<div className="handbook-entry-body">
				{entry.kind === "instruction" ? <>
					<blockquote>{entry.quote ?? entry.text}</blockquote>
					{entry.text && <small className="handbook-about">{entry.text}</small>}
				</> : <p>{entry.text}</p>}
				{entry.holdsWhile && <p className="handbook-condition"><b>Holds while</b> {entry.holdsWhile}</p>}
				{entry.pointsTo.length > 0 && <p className="handbook-pointers"><b>Points to</b> {entry.pointsTo.map(pointer =>
					<code key={pointer} className={entry.missing.includes(pointer) ? "missing" : undefined} title={entry.missing.includes(pointer) ? "This file no longer exists." : undefined}>{pointer}</code>)}</p>}
				{entry.flag && <p className="handbook-flag"><Icon name="warning" /><span>{who(entry.flag.by)} flagged it{entry.flag.reason ? ": " + entry.flag.reason : "."}</span></p>}
				{entry.flag?.proposal && <p className="handbook-proposal">New wording: “{entry.flag.proposal}”</p>}
				<p className="handbook-meta">
					<span>{origin}</span>
					{live ? <span>{use}</span> : <span>{entry.status === "replaced" ? "Replaced" + (entry.replacedBy ? " by " + entry.replacedBy : "")
						: entry.status === "rejected" ? "Turned down" : entry.status === "retired" ? "Retired" : "Removed"}{entry.endedAt ? ", " + date(entry.endedAt) : ""}
						{entry.endedBy ? " by " + by(entry.endedBy) : ""}{entry.endReason ? ": " + entry.endReason : ""}</span>}
					{entry.misled > 0 && <span className="handbook-warn">Led the agent wrong {times(entry.misled)}</span>}
					{entry.repeated > 0 && <span className="handbook-warn">You repeated it {times(entry.repeated)}</span>}
					{entry.pinned && <span className="handbook-tag">Pinned</span>}
					{entry.protected && live && <span className="handbook-tag" title="A prohibition: only you can change or remove it.">Protected</span>}
					{!entry.reviewed && live && <span className="handbook-tag">Not yet reviewed</span>}
				</p>
			</div>
			{live && <ActionMenu actions={actions.filter(action => !primary.includes(action))} invoke={action => act(entry.id, action.id)} disabled={disabled} label={"Actions for " + entry.id} />}
		</div>
		{primary.length > 0 && <div className="handbook-entry-actions">{primary.map(action =>
			<button type="button" key={action.id} className="quiet-action" disabled={disabled} onClick={() => act(entry.id, action.id)}>{action.label}</button>)}</div>}
	</li>;
}

/** A conversation's handbook: purpose, entries, what the tidy-up does, and how often the user corrects or repeats. */
export function HandbookView({ view, invoke, disabled }: { view: ViewSnapshot; invoke: (action: UiAction, value?: UiValue) => void; disabled?: boolean }) {
	const data = view.data as unknown as Data, actions = view.actions ?? [];
	const [past, setPast] = useState(false);
	const action = (id: string) => actions.find(item => item.id === id);
	const run = (id: string, value?: UiValue) => { const found = action(id); if (found) invoke(found, value); };
	const locked = !!disabled || !!view.working;
	const act = (id: string, change: string) => run("entry", { id, act: change });
	const live = data.entries.filter(entry => entry.status === "active" || entry.status === "pending");
	const review = live.filter(entry => entry.status === "pending" || entry.flag);
	const instructions = live.filter(entry => entry.status === "active" && entry.kind === "instruction" && !entry.flag);
	const learnings = live.filter(entry => entry.status === "active" && entry.kind === "learning" && !entry.flag);
	const ended = data.entries.filter(entry => !live.includes(entry)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	const lastPass = data.passes.at(-1), status = data.status;
	// The last change of the purpose by the tidy-up or the agent, while it stands: shown with the wording it replaced, to restore.
	const changed = data.purpose && data.purpose.by !== "user" ? data.log.find(item => item.was && item.at === data.purpose!.at) : undefined;
	const restore = (was: string) => action("purpose-restore") && <button type="button" className="link-button" disabled={locked}
		onClick={() => run("purpose-restore", was)}>Restore it</button>;
	const list = (entries: Entry[]) => <ul className="handbook-entries">{entries.map(entry => <EntryCard key={entry.id} entry={entry} act={act} disabled={locked} />)}</ul>;
	return <section className="handbook-view" aria-label="Handbook">
		<header className="handbook-heading">
			<span>{plural(instructions.length + learnings.length, "entry", "entries")}{review.length ? " · " + review.length + " to review" : ""}</span>
			<div className="handbook-controls">
				{action("tidy") && <button type="button" className="quiet-action" disabled={locked || !!status.running} onClick={() => run("tidy")}><Icon name="refresh" />Tidy up now</button>}
				<ActionMenu actions={actions.filter(item => ["add", "purpose", "history"].includes(item.id))} invoke={item => run(item.id)} disabled={locked} label="Handbook actions" />
			</div>
		</header>
		{view.actionError && <p role="alert" className="error-text">{view.actionError}</p>}
		{(status.running || status.error) && <p className={status.error && !status.running ? "error-text" : "muted"} role="status">{status.running ? status.running + "…" : status.error}</p>}
		<div className="handbook-purpose">
			<h3>Purpose</h3>
			<p>{data.purpose?.text ?? "Not written yet. The tidy-up writes one from your messages, or you can."}</p>
			{changed && <p className="handbook-was"><small>Changed by {by(changed.actor)} {localDateTime(changed.at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
				{changed.reason ? ": " + changed.reason : "."} It was: “{changed.was}” {restore(changed.was!)}</small></p>}
			{data.proposedPurpose && <div className="handbook-proposal-box">
				<p><b>Proposed</b> {data.proposedPurpose.text}{data.proposedPurpose.reason ? <small> {data.proposedPurpose.reason}</small> : null}</p>
				<div className="panel-actions">
					<button type="button" disabled={locked} onClick={() => run("purpose-accept")}>Use it</button>
					<button type="button" disabled={locked} onClick={() => run("purpose-dismiss")}>Keep the current one</button>
				</div>
			</div>}
		</div>
		<Chart days={data.days} />
		<p className="handbook-status muted">
			{lastPass ? "Last tidy-up " + localDateTime(lastPass.at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " read "
				+ plural(lastPass.messages, "message") + (lastPass.cost ? " (" + dollars(lastPass.cost) + " at API prices)" : "") + ". " : "No tidy-up yet. "}
			It runs after ten idle minutes, about once a day{status.model ? ", with " + status.model : ""}.
			{" "}Its prompt section is {status.sectionChars.toLocaleString()} of {status.sectionLimit.toLocaleString()} characters.
			{status.unread && <> Messages from before the handbook arrived are unread{action("history") ? <> (<button type="button" className="link-button" disabled={locked} onClick={() => run("history")}>read them</button>)</> : null}.</>}
		</p>
		{review.length > 0 && <><h3 className="handbook-section">To review</h3>{list(review)}</>}
		<h3 className="handbook-section">Instructions <small>your words, by date</small></h3>
		{instructions.length ? list(instructions) : <p className="muted">None yet.</p>}
		<h3 className="handbook-section">Learnings <small>what this conversation found out</small></h3>
		{learnings.length ? list(learnings) : <p className="muted">None yet.</p>}
		{ended.length > 0 && <details className="handbook-past" open={past} onToggle={event => setPast(event.currentTarget.open)}>
			<summary>Replaced and retired ({ended.length})</summary>{past && list(ended)}</details>}
		<details className="handbook-log">
			<summary>Change log ({data.log.length})</summary>
			<ol>{data.log.map((item, index) => <li key={index}>
				<time>{localDateTime(item.at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
				<b>{who(item.actor)}</b> {item.text}{item.reason ? <small> {item.reason}</small> : null}
				{item.was && <small>It was: “{item.was}” {item.was !== data.purpose?.text && restore(item.was)}</small>}
			</li>)}</ol>
		</details>
	</section>;
}

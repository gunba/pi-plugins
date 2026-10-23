import { useState, type ReactNode } from "react";
import type { UiAction, UiDetails } from "../../../pi-ui/index.ts";
import type { SessionView, ViewSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { ContextPanel } from "./context-panel.tsx";
import { ControlHistory } from "./control-status.tsx";
import { DraftRecovery } from "./draft-recovery.tsx";
import { Disclosure } from "./disclosure.tsx";
import { toolAvailability } from "./tool-availability.ts";
import type { Computer, WorkspaceState } from "./workspace.ts";

const tokens = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(value % 1_000_000 ? 2 : 0)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
const money = (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString()}`;
const when = (ms: number) => {
	const date = new Date(ms), today = new Date().toDateString() === date.toDateString();
	return date.toLocaleString([], today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
};
/** A labelled row: the label on the left, the content filling the rest. */
export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return <div className="settings-row" title={hint}><span className="settings-row-label">{label}</span><div className="settings-row-value">{children}</div></div>;
}

type Act = (view: ViewSnapshot, action: UiAction | string, value?: unknown) => Promise<unknown>;

/** Everything about one conversation on one page: model, context, spend, options. */
export function ConversationPage({ session, computer, host, views, connected, busy, settingBusy, invoke, act, available, restore, move }: {
	session: SessionView; computer?: Computer; host: WorkspaceState; views: ViewSnapshot[]; connected: boolean; busy: boolean; settingBusy: boolean;
	invoke: (command: WorkerCommand) => Promise<unknown>; act: Act; available: string[]; restore: (target: string, text: string) => void;
	move?: () => void;
}) {
	const [error, setError] = useState("");
	const run = (work: Promise<unknown>) => { setError(""); void work.catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); };
	const snapshot = session.snapshot, ui = session.ui, view = (id: string) => views.find(item => item.id === id && !item.scope);
	const window = view("context-window"), usageView = view("pi-usage");
	const ready = session.state === "ready" && !!ui, locked = busy || !connected;
	return <div className="settings-page">
		{error && <p className="error-text" role="alert">{error}</p>}
		<section className="settings-group">
			<Row label="Computer"><span>{computer?.name ?? host.name}</span>
				{move && <button className="quiet-action" disabled={busy} onClick={move}>Move to another computer…</button>}</Row>
			<Row label="Model">{snapshot?.model ? <span>{snapshot.model.name}{snapshot.thinking && snapshot.thinking !== "off" ? ` · ${snapshot.thinking} reasoning` : ""}</span> : <span className="muted">Not started</span>}</Row>
			{session.workerRuntime && <Row label="Version"><span>Desk {session.workerRuntime.version} · Pi {session.workerRuntime.engine}</span></Row>}
			<Row label="Pinned"><input type="checkbox" role="switch" aria-label="Pin conversation" checked={!!session.pinned} disabled={locked}
				onChange={event => run(api(`/sessions/${session.key}/metadata`, { generation: ui?.generation, pinned: event.target.checked }))} /></Row>
		</section>
		{ready && <ContextGroup session={session} window={window} machine={{ id: computer?.id, name: computer?.name ?? host.name, threshold: computer ? computer.cacheCompaction : host.cacheCompaction }}
			locked={locked || settingBusy} invoke={invoke} act={act} run={run} />}
		{snapshot?.usage && <SpendGroup usage={snapshot.usage} allowances={usageView} />}
		<section className="settings-group settings-more">
			{snapshot && <Disclosure id={`settings:${session.key}:tools`} className="settings-disclosure" summary={<><span>Tools and extensions</span>
				<small>{snapshot.tools.filter(tool => tool.active).length} active of {snapshot.tools.length} · {snapshot.extensions.length} extensions{snapshot.extensions.some(item => item.error) ? " · errors" : ""}</small></>}>
				<ul className="settings-inventory-list">{snapshot.tools.map(tool => <li key={tool.name} title={[tool.description, tool.source].filter(Boolean).join("\n")}>
					<span>{tool.name}</span><small>{toolAvailability(tool)}</small></li>)}</ul>
				<ul className="settings-inventory-list">{snapshot.extensions.map(extension => <li key={extension.path} className={extension.error ? "error-text" : ""} title={extension.path}>
					<span>{extension.path.split(/[\\/]/).at(-1)}</span>{extension.error && <small>{extension.error}</small>}</li>)}</ul>
				<div className="settings-actions">
					<button className="quiet-action" disabled={locked || !snapshot.commands.some(command => command.name === "pi-config")} onClick={() => run(invoke({ kind: "native", name: "pi-config", args: "" }))}><Icon name="settings" />Edit Pi defaults</button>
					<button className="quiet-action" disabled={locked} onClick={() => run(invoke({ kind: "reload" }))}><Icon name="refresh" />Reload Pi resources</button>
				</div>
			</Disclosure>}
			{!!ui?.notifications.length && <Disclosure id={`settings:${session.key}:notices`} className="settings-disclosure" summary={<><span>Notices</span><small>{ui.notifications.length}</small></>}>
				<ul className="activity-notifications">{ui.notifications.slice().reverse().map(item => <li key={item.id} className={`notification-${item.level}`}>
					<Icon name={item.level === "info" ? "info" : "warning"} /><div>{item.text}</div>
					{item.timestamp && <time>{when(item.timestamp)}</time>}</li>)}</ul>
			</Disclosure>}
			{!!session.controls?.length && <ControlHistory controls={session.controls} />}
			<DraftRecovery available={available} target={session.key} busy={busy} restored={restore} />
		</section>
	</div>;
}

/** Context in one bar: what is used, where Pi compacts, and the budget, which can be changed in place. */
function ContextGroup({ session, window, machine, locked, invoke, act, run }: {
	session: SessionView; window?: ViewSnapshot; machine: { id?: string; name: string; threshold?: number }; locked: boolean;
	invoke: (command: WorkerCommand) => Promise<unknown>; act: Act; run: (work: Promise<unknown>) => void;
}) {
	const context = session.snapshot?.context, details = window?.data as UiDetails | undefined;
	const control = details?.controls?.find(item => item.kind === "range") as Extract<NonNullable<UiDetails["controls"]>[number], { kind: "range" }> | undefined;
	const limit = window?.context?.limit ?? context?.contextWindow ?? 0, used = context?.tokens ?? 0;
	const compactAt = Number(/compaction near ([\d,]+)/i.exec(details?.summary ?? "")?.[1]?.replace(/,/g, "")) || undefined;
	const [editing, setEditing] = useState(false), [budget, setBudget] = useState(""), [instructions, setInstructions] = useState<string>();
	return <section className="settings-group">
		<Row label="Context">
			<div className="context-line">
				<div className="context-bar" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="Context used">
					<span style={{ width: `${Math.min(100, used / Math.max(1, limit) * 100)}%` }} />
					{compactAt && compactAt < limit && <i style={{ left: `${compactAt / limit * 100}%` }} title={`Pi compacts at ${tokens(compactAt)}`} />}
				</div>
				<span className="context-numbers">{context?.estimated ? "~" : ""}{tokens(used)} of {tokens(limit)}{compactAt ? <span className="muted"> · compacts at {tokens(compactAt)}</span> : null}</span>
			</div>
		</Row>
		{control && <Row label="Budget" hint={control.help}>
			{editing ? <form className="inline-form" onSubmit={event => {
				event.preventDefault();
				const value = Math.round(Number(budget.replace(/[,\s]/g, "").replace(/k$/i, "e3").replace(/m$/i, "e6")));
				if (!Number.isFinite(value)) return;
				run(act(window!, control.action, Math.min(control.max, Math.max(control.min, value))).then(() => setEditing(false)));
			}}>
				<input autoFocus aria-label="Context budget in tokens" value={budget} onChange={event => setBudget(event.target.value)} placeholder={String(control.value)} />
				<span className="muted">tokens, up to {tokens(control.max)}</span>
				<button type="submit" disabled={locked || control.disabled}>Apply</button><button type="button" className="quiet-action" onClick={() => setEditing(false)}>Cancel</button>
			</form> : <><span>{tokens(Number(control.value))}{Number(control.value) === control.max ? <span className="muted"> · the model's full window</span> : <span className="muted"> of {tokens(control.max)}</span>}</span>
				<button className="quiet-action" disabled={locked || control.disabled} onClick={() => { setBudget(String(control.value)); setEditing(true); }}>Change</button></>}
		</Row>}
		<Row label="Compact">
			<button disabled={locked} onClick={() => run(invoke({ kind: "compact", instructions: instructions || undefined }))}><Icon name="layers" />Compact now</button>
			{instructions === undefined ? <button className="quiet-action" onClick={() => setInstructions("")}>With instructions…</button>
				: <input className="grow" aria-label="Instructions for the summary" placeholder="What should the summary keep?" value={instructions} onChange={event => setInstructions(event.target.value)} />}
		</Row>
		{session.snapshot?.cache && <Row label="Before cache expiry" hint="When an idle conversation's prompt cache is about to expire and its context is above this share of its budget, compact it first, so the next message doesn't pay to cache everything again.">
			<select value={String(machine.threshold ?? "")} disabled={locked} aria-label="Compact before the cache expires"
				onChange={event => run(api("/cache-compaction", { threshold: event.target.value ? Number(event.target.value) : null }, machine.id))}>
				<option value="">Don't compact</option>{[30, 40, 50, 60, 70, 80].map(value => <option key={value} value={value}>Compact above {value}%</option>)}
			</select><span className="muted">all conversations on {machine.name}</span>
		</Row>}
		<Disclosure id={`settings:${session.key}:opening`} className="settings-disclosure" summary={<><span>Opening context</span>
			<small>instructions, skills and tools</small></>}>
			<ContextPanel key={session.key} session={session} disabled={locked} invoke={invoke} />
		</Disclosure>
	</section>;
}

/** Where this conversation's money went, at API prices, and the allowance left. */
function SpendGroup({ usage, allowances }: { usage: NonNullable<NonNullable<SessionView["snapshot"]>["usage"]>; allowances?: ViewSnapshot }) {
	const parts = usage.costs ? [["Cache reads", usage.costs.cacheRead, "spend-read"], ["Cache writes", usage.costs.cacheWrite, "spend-write"],
		["Output", usage.costs.output, "spend-output"], ["Uncached input", usage.costs.input, "spend-input"]] as const : [];
	const total = usage.cost || 1;
	return <section className="settings-group">
		<Row label="Spend"><span><b>{money(usage.cost)}</b> <span className="muted">at API prices, including compaction and child agents</span></span></Row>
		{parts.length > 0 && <Row label="">
			<div className="spend-split">
				<div className="spend-bar">{parts.map(([label, value, kind]) => <span key={label} className={kind} style={{ width: `${value / total * 100}%` }} title={`${label} ${money(value)}`} />)}</div>
				<ul>{parts.map(([label, value, kind]) => <li key={label}><i className={kind} />{label} <b>{Math.round(value / total * 100)}%</b> <span className="muted">{money(value)}</span></li>)}</ul>
			</div>
		</Row>}
		<Row label="Tokens"><span>{tokens(usage.input)} input · {tokens(usage.output)} output · {tokens(usage.cacheRead)} cache read · {tokens(usage.cacheWrite)} cache write</span></Row>
		{usage.missed && <Row label="Cache misses">{usage.missed.count
			? <span><b>{money(usage.missed.cost)}</b> <span className="muted">lost to {usage.missed.count} miss{usage.missed.count === 1 ? "" : "es"} ({tokens(usage.missed.tokens)} tokens paid for again)</span></span>
			: <span className="muted">None</span>}</Row>}
		{!!allowances?.badges?.length && <Row label="Allowance">
			<span className="allowances">{allowances.badges.map(badge => <span key={badge.label}><b>{badge.label === "Weekly" ? "Week" : badge.label} {badge.meter ? `${Math.round(badge.meter.value)}%` : badge.value}</b>
				{badge.meter?.resetsAt ? <span className="muted"> · resets {when(badge.meter.resetsAt)}</span> : null}</span>)}</span>
		</Row>}
	</section>;
}

/** One computer's shared settings on one page. */
/** This computer's conversation-copy switches (teleport): send its conversations, and keep other computers'. */
function CopiesRow({ teleport, computer, connected }: { teleport?: { hold: boolean; send: boolean; copies: unknown[] }; computer?: string; connected: boolean }) {
	const [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const set = (change: { hold?: boolean; send?: boolean }) => {
		setBusy(true); setError("");
		void api("/teleport/settings", change, computer).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
	};
	return <Row label="Conversation copies" hint="Each conversation is copied, as it is written, to the computers that keep copies, so it can be moved to another computer and resumed there even when this one is off. Copies go 30 days after their conversation was last active.">
		{teleport ? <>
			<label className="settings-check"><input type="checkbox" checked={teleport.send} disabled={!connected || busy} onChange={event => set({ send: event.target.checked })} />Send this computer's conversations</label>
			<label className="settings-check"><input type="checkbox" checked={teleport.hold} disabled={!connected || busy} onChange={event => set({ hold: event.target.checked })} />Keep copies of other computers' conversations{teleport.hold ? ` (${teleport.copies.length} kept)` : ""}</label>
		</> : <span className="muted">Update Desk on this computer to use conversation copies.</span>}
		{error && <span className="error-text" role="alert">{error}</span>}
	</Row>;
}
export function ComputerPage({ host, computer, connected, children, views, act, availabilityRun }: {
	host: WorkspaceState; computer?: Computer; connected: boolean; children: { accounts: ReactNode; dictation: ReactNode; updates?: ReactNode };
	views: ViewSnapshot[]; act: Act; availabilityRun: (mode: string) => void;
}) {
	const availability = computer ? computer.operatorAvailability : host.operatorAvailability;
	const connections = ["desk-browser", "desk-mcp"].flatMap(id => views.filter(view => view.id === id && !view.scope));
	return <div className="settings-page">
		<section className="settings-group">
			<Row label="When away" hint="Away keeps optional questions from pausing work. Required approvals still wait for you.">
				<select disabled={!connected || !availability} value={availability?.mode ?? "present"} onChange={event => availabilityRun(event.target.value)} aria-label="When you're away">
					<option value="present">I'm here: agents may ask optional questions</option><option value="away">I'm away: agents keep working</option>
				</select></Row>
			{connections.map(view => <Row key={view.id} label={view.id === "desk-browser" ? "Chrome" : "MCP servers"}>
				{(view.actions ?? []).map(action => <button key={action.id} className="quiet-action" disabled={!connected || !!view.working} onClick={() => void act(view, action)}>{action.label}</button>)}
				{view.working && <span className="muted">{view.working}…</span>}
			</Row>)}
			{children.updates}
			<CopiesRow teleport={computer ? computer.teleport : host.teleport} computer={computer?.id} connected={connected} />
			<Row label="Pi setup" hint="AGENTS.md, Pi settings, keybindings, models, prompts, skills and themes are mirrored with your other computers; the newest version of each wins. Logins, MCP servers, local extensions and paths stay on each computer.">
				<span className="muted">{(() => {
					const last = computer ? computer.settingsSync : host.settingsSync;
					return last ? `Mirrored · last: ${last.key.replace(/^(agent|home|setting):/, "")} from ${last.from}, ${new Date(last.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
						: "Mirrored with your other computers";
				})()}</span>
			</Row>
		</section>
		<h3 className="settings-subheading">Logins</h3>
		{children.accounts}
		<h3 className="settings-subheading">Dictation</h3>
		{children.dictation}
	</div>;
}

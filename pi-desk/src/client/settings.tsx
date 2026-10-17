import { useState, type ReactNode } from "react";
import type { BrowserAccount } from "./account.ts";
import { api } from "./connection.ts";
import { Computers, SoftwareUpdate } from "./computers.tsx";
import { ControlHistory } from "./control-status.tsx";
import { Devices } from "./devices.tsx";
import { DraftRecovery } from "./draft-recovery.tsx";
import { SessionControls } from "./session-controls.tsx";
import type { Computer, WorkspaceState } from "./workspace.ts";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import { RELEASE } from "../shared/release.ts";
import { Icon, SectionIcon } from "./icons.tsx";
import { ContextPanel } from "./context-panel.tsx";
import { toolAvailability } from "./tool-availability.ts";
import { ProviderAccountsPanel } from "./provider-accounts.tsx";
import { Disclosure } from "./disclosure.tsx";
import { DictationSettingsPanel } from "./dictation.tsx";
import { EfficiencyPanel } from "./efficiency.tsx";

/** Desk's own pages, addressable with /settings <id>. Extension pages come from the conversation's views. */
export const settingsSections = [
	{ id: "conversation", title: "Overview" }, { id: "context", title: "Context" }, { id: "tools", title: "Tools & commands" }, { id: "activity", title: "Activity" },
	{ id: "accounts", title: "Model accounts" }, { id: "dictation", title: "Dictation" }, { id: "efficiency", title: "Efficiency" }, { id: "availability", title: "Availability" },
	{ id: "general", title: "General" }, { id: "computers", title: "Computers & devices" },
];
const page = (id: string) => settingsSections.find(section => section.id === id)!;
/** Extension views shown inside a Desk page rather than as their own. */
export const MERGED_VIEWS = new Set(["context-window", "pi-context-ledger"]);
const VIEW_TITLES: Record<string, string> = { "pi-usage": "Usage", config: "Pi settings", "desk-mcp": "MCP servers", "codex-wire": "Codex", "desk-browser": "Chrome" };
const CONVERSATION_VIEWS = new Set(["pi-usage"]);
export interface SettingsGroup { label: string; detail?: string; items: { id: string; title: string }[] }

/** Settings grouped by what they apply to: this conversation, this computer, or Desk on every computer. */
export function settingsGroups({ session, computer, views }: { session?: string; computer: string; views: { id: string; title: string }[] }): SettingsGroup[] {
	const pages = views.filter(view => !MERGED_VIEWS.has(view.id)).map(view => ({ id: view.id, title: VIEW_TITLES[view.id] ?? view.title }));
	return [
		...(session ? [{ label: "This conversation", detail: session, items: [page("conversation"), page("context"), ...pages.filter(view => CONVERSATION_VIEWS.has(view.id)), page("tools"), page("activity")] }] : []),
		{ label: computer, detail: "Shared by conversations on this computer", items: [...pages.filter(view => !CONVERSATION_VIEWS.has(view.id)), page("accounts"), page("dictation"), page("efficiency"), page("availability")] },
		{ label: "Pi Desk", detail: "This app, on every computer", items: [page("general"), page("computers")] },
	];
}

export function SettingsLayout({ active, groups, choose, children, enabled = true }: {
	active: string; groups: SettingsGroup[]; choose: (id: string) => void; children: ReactNode; enabled?: boolean;
}) {
	if (!enabled) return <>{children}</>;
	const group = groups.find(group => group.items.some(item => item.id === active)), item = group?.items.find(item => item.id === active);
	return <div className="settings-layout">
		<nav className="settings-nav" aria-label="Settings sections">
			{groups.map(group => <div className="settings-nav-group" key={group.label}>
				<h3 title={group.detail}>{group.label}</h3>
				{group.items.map(section => <button key={section.id} aria-current={active === section.id ? "page" : undefined}
					onClick={() => choose(section.id)}><SectionIcon id={section.id} /><span>{section.title}</span></button>)}
			</div>)}
		</nav>
		<label className="settings-mobile-nav">Section
			<select value={active} onChange={event => choose(event.target.value)}>
				{groups.map(group => <optgroup key={group.label} label={group.label}>
					{group.items.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</optgroup>)}
			</select>
		</label>
		<div className="settings-content">
			{item && <header className="settings-page-heading"><span>{group!.label === "This conversation" ? group!.detail : group!.label}</span><h2>{item.title}</h2></header>}
			{children}
		</div>
	</div>;
}
export function SettingsContent({ section, host, account, session, computer, connected, busy, settingBusy, invoke, compose, restore, providerHint, renderView }: {
	section: string; host: WorkspaceState; account?: BrowserAccount; session?: SessionView; computer?: Computer; providerHint?: string;
	/** Renders a conversation view, by ID, inside a Desk page. */
	renderView: (id: string) => ReactNode;
	connected: boolean; busy: boolean; settingBusy: boolean; invoke: (command: WorkerCommand) => Promise<unknown>;
	compose: (text: string) => void; restore: (target: string, text: string) => void;
}) {
	const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
	const [error, setError] = useState("");
	const run = (work: Promise<unknown>) => { setError(""); void work.catch(error => setError(String(error))); };
	const snapshot = session?.snapshot, ui = session?.ui, controls = session?.controls ?? [];
	const availability = computer ? computer.operatorAvailability : host.operatorAvailability;
	const defaultsLabel = (values: string[] | undefined, inherited: string) => values === undefined ? inherited : JSON.stringify(values);
	return <>
		{error && <p className="error-text" role="alert">{error}</p>}
		{section === "availability" && <section className="panel-card">
			<label className="setting-control"><span>When you're away<small>Away keeps optional questions from pausing work. Required approvals still wait for you; existing questions are kept.</small></span>
				<select disabled={!connected || !availability} value={availability?.mode ?? "present"}
					onChange={event => run(api("/operator-availability", { mode: event.target.value }, computer?.id))}>
					<option value="present">Present</option><option value="away">Away</option>
				</select></label>
			{!availability && <p className="muted">Availability requires a newer Desk host on this computer.</p>}
			{host.sessions.some(item => item.state !== "closed" && item.workerRuntime?.unattended !== true
				&& (!computer || (item as { computer?: string }).computer === computer.id))
				&& <p className="muted">Some conversations use older workers. Restart them when idle to apply availability.</p>}
		</section>}
		{section === "general" && <>
			<section className="panel-card"><h3>Appearance</h3>
				<label className="setting-control"><span>Theme</span><select value={theme} onChange={event => {
					setTheme(event.target.value); document.documentElement.dataset.theme = event.target.value;
					localStorage.setItem("pi-desk:theme", event.target.value);
				}}><option value="dark">Dark</option><option value="light">Light</option></select></label>
			</section>
			<section className="panel-card"><h3>About</h3>
				<dl className="settings-facts"><dt>App</dt><dd>{RELEASE.version} · API {RELEASE.api}</dd>
					{(computer?.release ?? (!host.computers ? host.release : undefined)) && <><dt>{computer?.name ?? host.name}</dt>
						<dd>Desk {(computer?.release ?? host.release).version} · Pi {(computer?.release ?? host.release).engine}</dd></>}</dl>
				<button className="quiet-action" onClick={() => location.reload()}><Icon name="refresh" />Reload app</button>
			</section>
		</>}
		{section === "accounts" && <ProviderAccountsPanel host={host} computer={computer} session={session} connected={connected} busy={settingBusy} invoke={invoke} providerHint={providerHint} />}
		{section === "dictation" && <DictationSettingsPanel host={host} computer={computer} connected={connected} />}
		{section === "efficiency" && <EfficiencyPanel host={host} computer={computer} connected={connected} />}
		{section === "computers" && (account ? <Computers computers={host.computers ?? []} account={account} /> : <>
			{host.updates && <section className="panel-card"><h3>Software updates</h3>
				<SoftwareUpdate computer={{ name: host.name, connected, updates: host.updates }} /></section>}
			<Devices />
		</>)}
		{section === "conversation" && <>
			{session ? <section className="panel-card">
				{session.workerRuntime && <dl className="settings-facts"><dt>Desk</dt><dd>{session.workerRuntime.version}
					{computer?.release && computer.release.version !== session.workerRuntime.version && <span className="session-version">{computer.name} has {computer.release.version}</span>}</dd>
					<dt>Plugins</dt><dd>{session.workerRuntime.plugins}</dd><dt>Pi</dt><dd>{session.workerRuntime.engine}</dd></dl>}
				{session.workerRuntime && computer?.release && computer.release.version !== session.workerRuntime.version && session.state === "ready" && <>
					<p className="muted">This conversation keeps the code it started with until restarted. History is kept.</p>
					<button disabled={busy || !connected} onClick={() => run(api(`/sessions/${session.key}/restart`, { replace: true }))}>
						<Icon name="refresh" />Restart on Desk {computer.release.version}</button></>}
				<label className="setting-control"><span>Pin conversation<small>Pinned conversations stay at the top of the sidebar.</small></span>
					<input type="checkbox" role="switch" checked={!!session.pinned}
					disabled={busy || !connected} onChange={event => run(api(`/sessions/${session.key}/metadata`,
						{ generation: ui?.generation, pinned: event.target.checked }))} /></label>
			</section> : <p className="muted">Select a conversation to change its settings.</p>}
			{session?.state === "ready" && ui && <SessionControls key={session.key} generation={ui.generation} busy={busy || !connected} invoke={invoke} />}
			<ControlHistory controls={controls} />
			<DraftRecovery available={host.sessions.map(item => item.key)} target={session?.key} busy={busy} restored={restore} />
		</>}
		{section === "context" && (session?.state === "ready" ? <>
			{renderView("context-window")}
			<div className="panel-card"><ContextPanel key={session.key} session={session} disabled={settingBusy || !connected} invoke={invoke} /></div>
			<section className="panel-card"><h3>Prompt cache</h3>
				<label className="setting-control"><span>Compact before the cache expires<small>{computer?.name ?? host.name}: when an idle conversation's
					cache is about to expire and its context is above this share of its budget, compact it first, so your next message does not pay to
					cache the whole conversation again. A Claude summary reads the conversation once at the normal input price.</small></span>
					<select value={String((computer ? computer.cacheCompaction : host.cacheCompaction) ?? "")} disabled={busy || !connected}
						onChange={event => run(api("/cache-compaction", { threshold: event.target.value ? Number(event.target.value) : null }, computer?.id))}>
						<option value="">Off</option>
						{[30, 40, 50, 60, 70, 80].map(value => <option key={value} value={value}>Above {value}%</option>)}
					</select></label>
			</section>
			{renderView("pi-context-ledger")}
		</> : <p className="muted">Open a conversation to inspect its context.</p>)}
		{section === "tools" && (snapshot ? <>
			<section className="panel-card"><h3><Icon name="code" />Commands</h3>
				<label className="setting-control">Add a command to your message<select value="" onChange={event => {
					if (event.target.value) compose(`/${event.target.value} `);
				}}><option value="">Choose a command…</option>{snapshot.commands.map(command =>
					<option key={command.name} value={command.name}>/{command.name}{command.description ? ` — ${command.description}` : ""}</option>)}</select></label>
			</section>
			<section className="panel-card"><h3><Icon name="tools" />{snapshot.tools.length} tools · {snapshot.extensions.length} extensions</h3>
				{snapshot.toolDefaults ? <>
					<p className="muted">Computer defaults: <code>{defaultsLabel(snapshot.toolDefaults.computer, "Pi defaults")}</code></p>
					<p className="muted">Project defaults: <code>{defaultsLabel(snapshot.toolDefaults.project, "Inherit computer")}</code></p>
					<p className="muted">Resolved startup selection: <code>{defaultsLabel(snapshot.toolDefaults.resolved, "Pi defaults")}</code>. Extensions and conversation choices can change the current selection below.</p>
				</> : <p className="muted">This worker does not report tool-selection sources. Its current selection is shown below.</p>}
				<p className="muted">Registration is not activation. Codemode and tool search start off unless enabled in defaults; tools exposed through them need not appear directly in the model's tool list.</p>
				<button className="quiet-action" disabled={settingBusy || !connected || !snapshot.commands.some(command => command.name === "pi-config")}
					onClick={() => run(invoke({ kind: "native", name: "pi-config", args: "" }))}><Icon name="settings" />Edit Pi defaults</button>
				<Disclosure id={`settings:${session.key}:extensions`} className="settings-inventory" summary="Extensions"><ul>{snapshot.extensions.map(extension =>
					<li className={extension.error ? "error-text" : ""} key={extension.path} title={extension.path}>
						<Icon name={extension.error ? "info" : "plug"} /><span>{extension.path.split(/[\\/]/).at(-1)}{extension.error ? `: ${extension.error}` : ""}</span></li>)}</ul></Disclosure>
				<Disclosure id={`settings:${session.key}:tools`} className="settings-inventory" summary="Tools"><ul>{snapshot.tools.map(tool =>
					<li key={tool.name} title={[tool.description, tool.source].filter(Boolean).join("\n")}><Icon name={tool.declared ? "check" : tool.callable ? "code" : "tools"} /><span>{tool.name}
						{tool.conversationChoice !== undefined ? <small>Conversation override: {tool.conversationChoice ? "on" : "off"}</small>
							: tool.defaultActive === false && !tool.active ? <small>Registered off by default</small> : null}</span>
						<small>{toolAvailability(tool)}</small></li>)}</ul></Disclosure>
				<button className="quiet-action" disabled={busy || !connected} onClick={() => run(invoke({ kind: "reload" }))}><Icon name="refresh" />Reload Pi resources</button>
			</section>
		</> : <p className="muted">Open a conversation to see its tools and extensions.</p>)}
		{section === "activity" && <>
			{Object.keys(ui?.statuses ?? {}).length > 0 && <section className="panel-card"><h3>Status</h3>
				<ul className="activity-statuses">{Object.entries(ui?.statuses ?? {}).map(([key, text]) => <li key={key}><span>{key}</span>{text}</li>)}</ul></section>}
			<section className="panel-card"><h3>Notifications</h3>{ui?.notifications.length ? <ul className="activity-notifications">
				{ui.notifications.slice().reverse().map(item => <li key={item.id} className={`notification-${item.level}`}>
					<Icon name={item.level === "info" ? "info" : "warning"} />
					<div>{item.text.length > 280 ? <details><summary>{item.text.slice(0, 200)}…</summary><div className="detail-copy">{item.text}</div></details> : item.text}</div>
					{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
				</li>)}</ul> : <p className="muted">No notifications.</p>}</section>
		</>}
	</>;
}

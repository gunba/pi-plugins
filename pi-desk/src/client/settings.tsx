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

export const settingsSections = [
	{ id: "general", title: "General" }, { id: "conversation", title: "Conversation" },
	{ id: "accounts", title: "Model accounts" }, { id: "computers", title: "Computers & access" }, { id: "context", title: "Opening context" }, { id: "tools", title: "Tools & extensions" },
	{ id: "activity", title: "Activity" },
];
export function SettingsLayout({ active, sections, choose, children, enabled = true }: {
	active: string; sections: { id: string; title: string }[]; choose: (id: string) => void; children: ReactNode; enabled?: boolean;
}) {
	if (!enabled) return <>{children}</>;
	return <div className="settings-layout">
		<nav className="settings-nav" aria-label="Settings sections">
			{sections.map(section => <button key={section.id} aria-current={active === section.id ? "page" : undefined}
				onClick={() => choose(section.id)}><SectionIcon id={section.id} /><span>{section.title}</span></button>)}
		</nav>
		<label className="settings-mobile-nav">Section
			<select value={active} onChange={event => choose(event.target.value)}>
				{sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}
			</select>
		</label>
		<div className="settings-content">{children}</div>
	</div>;
}
export function SettingsContent({ section, host, account, session, computer, connected, busy, settingBusy, invoke, compose, restore, providerHint }: {
	section: string; host: WorkspaceState; account?: BrowserAccount; session?: SessionView; computer?: Computer; providerHint?: string;
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
		{section === "general" && <>
			<section className="panel-card"><h3><Icon name="settings" />Availability · {computer?.name ?? host.name}</h3>
				<label className="setting-control">Operator<select disabled={!connected || !availability} value={availability?.mode ?? "present"}
					onChange={event => run(api("/operator-availability", { mode: event.target.value }, computer?.id))}>
					<option value="present">Present</option><option value="away">Away</option>
				</select></label>
				<p className="muted">Away keeps optional questions from pausing work. Required approvals still wait for you. Existing questions are kept.</p>
				{!availability && <p className="muted">Availability requires a newer Desk host on this computer.</p>}
				{host.sessions.some(item => item.state !== "closed" && item.workerRuntime?.unattended !== true
					&& (!computer || (item as { computer?: string }).computer === computer.id))
					&& <p className="muted">Some conversations use older workers. Restart them when idle to apply availability.</p>}
			</section>
			<section className="panel-card"><h3><Icon name="settings" />Appearance</h3>
				<label className="setting-control">Theme<select value={theme} onChange={event => {
					setTheme(event.target.value); document.documentElement.dataset.theme = event.target.value;
					localStorage.setItem("pi-desk:theme", event.target.value);
				}}><option value="dark">Dark</option><option value="light">Light</option></select></label>
			</section>
			<section className="panel-card"><h3><Icon name="info" />Pi Desk</h3><p>App {RELEASE.version} · API {RELEASE.api}</p>
				{(computer?.release ?? (!host.computers ? host.release : undefined)) && <p className="muted">
					Host {(computer?.release ?? host.release).version} · Pi {(computer?.release ?? host.release).engine}</p>}
				<button className="quiet-action" onClick={() => location.reload()}><Icon name="refresh" />Reload app</button>
			</section>
		</>}
		{section === "accounts" && <ProviderAccountsPanel host={host} computer={computer} session={session} connected={connected} busy={settingBusy} invoke={invoke} providerHint={providerHint} />}
		{section === "computers" && (account ? <Computers computers={host.computers ?? []} account={account} /> : <>
			{host.updates && <section className="panel-card"><h3>Software updates</h3>
				<SoftwareUpdate computer={{ name: host.name, connected, updates: host.updates }} /></section>}
			<Devices />
		</>)}
		{section === "conversation" && <>
			{session ? <section className="panel-card"><h3><Icon name="chat" />Conversation</h3>
				{session.workerRuntime && <p className="muted">Worker {session.workerRuntime.version} · Plugins {session.workerRuntime.plugins} · Pi {session.workerRuntime.engine}
					{computer?.release && computer.release.version !== session.workerRuntime.version && <>. Host {computer.release.version}; this conversation keeps its loaded code until restarted.</>}
				</p>}
				{session.workerRuntime && computer?.release && computer.release.version !== session.workerRuntime.version && session.state === "ready" &&
					<button disabled={busy || !connected} title="Close and reopen this conversation on the host's current version. History is kept."
						onClick={() => run(api(`/sessions/${session.key}/restart`, { replace: true }))}>
						<Icon name="refresh" />Restart on Desk {computer.release.version}</button>}
				<label className="setting-control">Pin conversation<input type="checkbox" role="switch" checked={!!session.pinned}
					disabled={busy || !connected} onChange={event => run(api(`/sessions/${session.key}/metadata`,
						{ generation: ui?.generation, pinned: event.target.checked }))} /></label>
			</section> : <p className="muted">Select a conversation to change its settings.</p>}
			{session?.state === "ready" && ui && <SessionControls key={session.key} generation={ui.generation} busy={busy || !connected} invoke={invoke} />}
			<ControlHistory controls={controls} />
			<DraftRecovery available={host.sessions.map(item => item.key)} target={session?.key} busy={busy} restored={restore} />
		</>}
		{section === "context" && (session?.state === "ready" ? <ContextPanel key={session.key} session={session} disabled={settingBusy || !connected} invoke={invoke} /> : <p className="muted">Open a conversation to inspect its context.</p>)}
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
			<section className="panel-card"><h3>Status</h3>{Object.entries(ui?.statuses ?? {}).map(([key, text]) =>
				<p className="status-item" key={key}>{text}</p>)}</section>
			<section className="panel-card"><h3>Notifications</h3>{ui?.notifications.length ? ui.notifications.slice().reverse().map(item =>
				<details key={item.id}><summary>{item.level === "info" ? "Update" : item.level}</summary>
					<div className="detail-copy">{item.text}</div></details>) : <p className="muted">No notifications.</p>}</section>
		</>}
	</>;
}

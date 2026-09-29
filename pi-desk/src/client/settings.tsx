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

export const settingsSections = [
	{ id: "general", title: "General" }, { id: "conversation", title: "Conversation" },
	{ id: "computers", title: "Computers & access" }, { id: "tools", title: "Tools & extensions" },
	{ id: "activity", title: "Activity" },
];
export function SettingsLayout({ active, sections, choose, children, enabled = true }: {
	active: string; sections: { id: string; title: string }[]; choose: (id: string) => void; children: ReactNode; enabled?: boolean;
}) {
	if (!enabled) return <>{children}</>;
	return <div className="settings-layout">
		<nav className="settings-nav" aria-label="Settings sections">
			{sections.map(section => <button key={section.id} aria-current={active === section.id ? "page" : undefined}
				onClick={() => choose(section.id)}>{section.title}</button>)}
		</nav>
		<label className="settings-mobile-nav">Section
			<select value={active} onChange={event => choose(event.target.value)}>
				{sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}
			</select>
		</label>
		<div className="settings-content">{children}</div>
	</div>;
}
export function SettingsContent({ section, host, account, session, computer, connected, busy, invoke, compose, restore }: {
	section: string; host: WorkspaceState; account?: BrowserAccount; session?: SessionView; computer?: Computer;
	connected: boolean; busy: boolean; invoke: (command: WorkerCommand) => Promise<unknown>;
	compose: (text: string) => void; restore: (target: string, text: string) => void;
}) {
	const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
	const [error, setError] = useState("");
	const run = (work: Promise<unknown>) => { setError(""); void work.catch(error => setError(String(error))); };
	const snapshot = session?.snapshot, ui = session?.ui, controls = session?.controls ?? [];
	return <>
		{error && <p className="error-text" role="alert">{error}</p>}
		{section === "general" && <>
			<section className="panel-card"><h3>Appearance</h3>
				<label className="setting-control">Theme<select value={theme} onChange={event => {
					setTheme(event.target.value); document.documentElement.dataset.theme = event.target.value;
					localStorage.setItem("pi-desk:theme", event.target.value);
				}}><option value="dark">Dark</option><option value="light">Light</option></select></label>
			</section>
			<section className="panel-card"><h3>Pi Desk</h3><p>App {RELEASE.version} · API {RELEASE.api}</p>
				{(computer?.release ?? (!host.computers ? host.release : undefined)) && <p className="muted">
					Host {(computer?.release ?? host.release).version} · Pi {(computer?.release ?? host.release).engine}</p>}
				<button onClick={() => location.reload()}>Reload app</button>
			</section>
		</>}
		{section === "computers" && (account ? <Computers computers={host.computers ?? []} account={account} /> : <>
			{host.updates && <section className="panel-card"><h3>Software updates</h3>
				<SoftwareUpdate computer={{ name: host.name, connected, updates: host.updates }} /></section>}
			<Devices />
		</>)}
		{section === "conversation" && <>
			{session ? <section className="panel-card"><h3>Conversation</h3>
				{snapshot && <form key={`${session.key}:${snapshot.id}:${snapshot.name}`} className="setting-name"
					onSubmit={event => { event.preventDefault(); run(invoke({ kind: "name", name: String(new FormData(event.currentTarget).get("name")) })); }}>
					<label>Name<input name="name" defaultValue={snapshot.name ?? ""} placeholder="Name this conversation" disabled={busy || !connected} /></label>
					<button disabled={busy || !connected}>Save</button>
				</form>}
				<label className="setting-control">Pin conversation<input type="checkbox" role="switch" checked={!!session.pinned}
					disabled={busy || !connected} onChange={event => run(api(`/sessions/${session.key}/metadata`,
						{ generation: ui?.generation, pinned: event.target.checked }))} /></label>
			</section> : <p className="muted">Select a conversation to change its settings.</p>}
			{session?.state === "ready" && ui && <SessionControls key={session.key} generation={ui.generation} busy={busy || !connected} invoke={invoke} />}
			<ControlHistory controls={controls} />
			<DraftRecovery available={host.sessions.map(item => item.key)} target={session?.key} busy={busy} restored={restore} />
		</>}
		{section === "tools" && (snapshot ? <>
			<section className="panel-card"><h3>Commands</h3>
				<label className="setting-control">Add a command to your message<select value="" onChange={event => {
					if (event.target.value) compose(`/${event.target.value} `);
				}}><option value="">Choose a command…</option>{snapshot.commands.map(command =>
					<option key={command.name} value={command.name}>/{command.name}{command.description ? ` — ${command.description}` : ""}</option>)}</select></label>
			</section>
			<section className="panel-card"><h3>{snapshot.tools.length} tools · {snapshot.extensions.length} extensions</h3>
				<details><summary>Extensions</summary>{snapshot.extensions.map(extension =>
					<p className={extension.error ? "error-text" : "inventory-item"} key={extension.path}>
						{extension.path.split(/[\\/]/).at(-1)}{extension.error ? `: ${extension.error}` : ""}</p>)}</details>
				<details><summary>Tools</summary>{snapshot.tools.map(tool =>
					<p className="inventory-item" key={tool.name}>{tool.name}{tool.active ? "" : " · inactive"}</p>)}</details>
				<button disabled={busy || !connected} onClick={() => run(invoke({ kind: "reload" }))}>Reload Pi resources</button>
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

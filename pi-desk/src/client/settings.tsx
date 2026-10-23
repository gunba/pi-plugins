import { useState, type ReactNode } from "react";
import type { BrowserAccount } from "./account.ts";
import { api } from "./connection.ts";
import { Computers, SoftwareUpdate } from "./computers.tsx";

import { Devices } from "./devices.tsx";

import type { Computer, WorkspaceState } from "./workspace.ts";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import { RELEASE } from "../shared/release.ts";
import { Icon, SectionIcon } from "./icons.tsx";

import { LoginsPanel } from "./logins.tsx";

import { EfficiencyPanel } from "./efficiency.tsx";
import { ComputerPage, ConversationPage, Row } from "./settings-pages.tsx";
import { DictationKey } from "./dictation.tsx";
import type { UiAction } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";

/** Desk's own pages, addressable with /settings <id>. Extension pages come from the conversation's views. */
export const settingsSections = [
	{ id: "conversation", title: "Conversation" }, { id: "computer", title: "This computer" }, { id: "efficiency", title: "Efficiency" }, { id: "general", title: "Pi Desk" },
	// Older page names, still accepted by /settings.
	{ id: "context", title: "Conversation" }, { id: "tools", title: "Conversation" }, { id: "activity", title: "Conversation" }, { id: "usage", title: "Conversation" },
	{ id: "accounts", title: "This computer" }, { id: "dictation", title: "This computer" }, { id: "availability", title: "This computer" }, { id: "computers", title: "Pi Desk" },
];
const ALIASES: Record<string, string> = { context: "conversation", tools: "conversation", activity: "conversation", usage: "conversation",
	accounts: "computer", dictation: "computer", availability: "computer", computers: "general" };
export const settingsPage = (id: string) => ALIASES[id] ?? id;
const page = (id: string) => settingsSections.find(section => section.id === id)!;
/** Extension views shown inside a Desk page rather than as their own. */
export const MERGED_VIEWS = new Set(["context-window", "pi-context-ledger", "pi-usage", "desk-browser", "desk-mcp"]);
const VIEW_TITLES: Record<string, string> = { "pi-usage": "Usage", config: "Pi settings", "desk-mcp": "MCP servers", "codex-wire": "Codex", "desk-browser": "Chrome" };
export interface SettingsGroup { label: string; detail?: string; items: { id: string; title: string }[] }

/** Settings grouped by what they apply to: this conversation, this computer, or Desk on every computer. */
export function settingsGroups({ session, computer, views }: { session?: string; computer: string; views: { id: string; title: string }[] }): SettingsGroup[] {
	const pages = views.filter(view => !MERGED_VIEWS.has(view.id)).map(view => ({ id: view.id, title: VIEW_TITLES[view.id] ?? view.title }));
	return [
		...(session ? [{ label: "This conversation", detail: session, items: [page("conversation")] }] : []),
		{ label: computer, detail: "Shared by conversations on this computer", items: [{ id: "computer", title: "Accounts & connections" }, page("efficiency"), ...pages] },
		{ label: "Pi Desk", detail: "This app, on every computer", items: [page("general")] },
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
		<nav className="settings-mobile-nav" aria-label="Settings sections">{groups.flatMap(group => group.items).map(section =>
			<button key={section.id} type="button" aria-current={active === section.id ? "page" : undefined} onClick={() => choose(section.id)}>{section.title}</button>)}</nav>
		<div className="settings-content">
			{item && <header className="settings-page-heading"><span>{group!.label === "This conversation" ? group!.detail : group!.label}</span><h2>{item.title}</h2></header>}
			{children}
		</div>
	</div>;
}
export function SettingsContent({ section: requested, host, account, session, computer, connected, busy, settingBusy, invoke, restore, providerHint, move }: {
	section: string; host: WorkspaceState; account?: BrowserAccount; session?: SessionView; computer?: Computer; providerHint?: string;
	connected: boolean; busy: boolean; settingBusy: boolean; invoke: (command: WorkerCommand) => Promise<unknown>;
	restore: (target: string, text: string) => void;
	/** Opens "Move to another computer" for this conversation, where it can move. */
	move?: () => void;
}) {
	const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
	const [error, setError] = useState("");
	const run = (work: Promise<unknown>) => { setError(""); void work.catch(error => setError(String(error))); };
	const ui = session?.ui;
	const section = settingsPage(requested), views = ui?.views ?? [];
	const act = (view: ViewSnapshot, action: UiAction | string, value?: unknown) =>
		invoke({ kind: "action", view: view.id, revision: view.revision, action: typeof action === "string" ? action : action.id, value: value as never });
	return <>
		{error && <p className="error-text" role="alert">{error}</p>}
		{section === "conversation" && (session ? <ConversationPage session={session} computer={computer} host={host} views={views} connected={connected} busy={busy}
			settingBusy={settingBusy} invoke={invoke} act={act} available={host.sessions.map(item => item.key)} restore={restore} move={move} />
			: <p className="muted">Select a conversation to see its settings.</p>)}
		{section === "computer" && <ComputerPage host={host} computer={computer} connected={connected} views={views} act={act}
			availabilityRun={mode => run(api("/operator-availability", { mode }, computer?.id))}>
			{{ accounts: <LoginsPanel key={computer?.id ?? "local"} computer={computer?.id} connected={connected} provider={providerHint} />,
				dictation: <DictationKey key={computer?.id ?? "local"} computer={computer?.id} name={computer?.name ?? host.name} connected={connected} />,
				updates: !account && host.updates ? <Row label="Updates"><SoftwareUpdate computer={{ name: host.name, connected, updates: host.updates }} /></Row> : undefined }}
		</ComputerPage>}
		{section === "efficiency" && <EfficiencyPanel host={host} computer={computer} connected={connected} />}
		{section === "general" && <div className="settings-page">
			<section className="settings-group">
				<Row label="Theme"><select value={theme} aria-label="Theme" onChange={event => {
					setTheme(event.target.value); document.documentElement.dataset.theme = event.target.value;
					localStorage.setItem("pi-desk:theme", event.target.value);
				}}><option value="dark">Dark</option><option value="light">Light</option></select></Row>
				<Row label="Version"><span>App {RELEASE.version}{(computer?.release ?? (!host.computers ? host.release : undefined))
					? <span className="muted"> · {computer?.name ?? host.name}: Desk {(computer?.release ?? host.release).version}, Pi {(computer?.release ?? host.release).engine}</span> : null}</span>
					<button className="quiet-action" onClick={() => location.reload()}><Icon name="refresh" />Reload app</button></Row>
			</section>
			<h3 className="settings-subheading">Computers & devices</h3>
			{account ? <Computers computers={host.computers ?? []} account={account} /> : <>
				{host.updates && <section className="panel-card"><SoftwareUpdate computer={{ name: host.name, connected, updates: host.updates }} /></section>}
				<Devices />
			</>}
		</div>}
	</>;
}

import { useId, useState, type ReactNode } from "react";
import type { UiConversation, UiDetails } from "../../../pi-ui/index.ts";
import { activityLabel, backgroundWork, sessionActivity, wakeLabel } from "./activity.ts";
import { agentInventory } from "./agent-inventory.ts";
import { conversationTitle, type WorkspaceSession, type WorkspaceState } from "./workspace.ts";

interface ActivityRow { id: string; title: string; detail?: string; status: string; owner: WorkspaceSession; view?: string; agent?: string; approximate?: boolean }
const TABS = ["tasks", "agents", "watches"] as const;
type Tab = typeof TABS[number];

/** Reads the same snapshots as the sidebar; offline rows are last-known state, not live activity. */
export function TasksOverview({ host, connected, tasks, children, open }: {
	host: WorkspaceState; connected: boolean; tasks: number; children: ReactNode;
	open: (session: WorkspaceSession, target?: { view?: string; agent?: string }) => void;
}) {
	const [tab, setTab] = useState<Tab>("tasks"), [search, setSearch] = useState("");
	const id = useId();
	const computer = (session: WorkspaceSession) => host.computers?.find(item => item.id === session.computer);
	const online = (session: WorkspaceSession) => host.computers ? computer(session)?.connected === true : connected;
	const location = (session: WorkspaceSession) => computer(session)?.name ?? host.name;
	// Closed conversations are not at work; those still waiting on a watch are listed under Watches.
	const agents: ActivityRow[] = host.sessions.filter(owner => owner.state !== "closed").flatMap(owner => [
		{ id: owner.key, title: conversationTitle(owner), detail: backgroundWork(owner)?.label, status: activityLabel(sessionActivity(owner)), owner },
		...agentInventory(owner.ui?.views ?? []).current.map(view => {
			const data = view.data as UiConversation;
			return { id: `${owner.key}:${view.id}`, title: view.title, detail: data.activity ?? data.subtitle, status: activityLabel(data.status), owner, agent: view.id };
		}),
	]);
	agents.sort((a, b) => Number(!online(a.owner)) - Number(!online(b.owner)));
	const watches: ActivityRow[] = host.sessions.flatMap(owner => {
		const views = (owner.ui?.views ?? []).filter(view => view.kind === "details" && (view.id === "pi-watch" || view.id.endsWith("/pi-watch")));
		// Closed workers lose their live views; the host preserves the watch descriptions when it closes them.
		const saved = owner.state === "closed" && owner.waiting?.length ? owner.waiting.map((item, index) => ({
			id: `${owner.key}:saved:${index}`, title: item.title, detail: item.detail, status: "Waiting · conversation closed", owner,
		})) : undefined;
		const rows: ActivityRow[] = saved ?? views.flatMap(view => ((view.data as UiDetails).items ?? []).map(item => ({
			id: `${owner.key}:${view.id}:${item.id}`, title: item.title,
			detail: [view.scope?.label, item.subtitle].filter(Boolean).join(" · "), status: "Watching", owner, view: view.id,
		})));
		if (!rows.length && (owner.watching || owner.wakes)) rows.push({ id: `${owner.key}:waiting`, title: owner.wakes ? wakeLabel(owner.wakes) : "Waiting for an event",
			detail: "Individual watch details are not available from this conversation.", status: "Waiting", owner, approximate: true });
		return rows;
	});
	const counts = { tasks: String(tasks), agents: String(agents.length), watches: `${watches.length}${watches.some(row => row.approximate) ? "+" : ""}` };
	const choose = (next: Tab) => { setTab(next); setSearch(""); };
	const rows = (tab === "agents" ? agents : watches).filter(row => `${row.title} ${row.detail ?? ""} ${row.status} ${location(row.owner)} ${conversationTitle(row.owner)}`.toLowerCase().includes(search.toLowerCase()));
	return <div className="tasks-overview">
		<div className="tasks-tabs" role="tablist" aria-label="Workspace overview">
			{TABS.map((name, index) => <button type="button" key={name} role="tab" id={`${id}-${name}`} aria-selected={tab === name} aria-controls={`${id}-${name}-panel`} tabIndex={tab === name ? 0 : -1}
				onClick={() => choose(name)} onKeyDown={event => {
					const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : undefined;
					if (next !== undefined) { event.preventDefault(); choose(TABS[next]!); document.getElementById(`${id}-${TABS[next]}`)?.focus(); }
				}}>{name === "tasks" ? "Tasks" : name === "agents" ? "Agents" : "Watches"}<span>{counts[name]}</span></button>)}
		</div>
		<div className="tasks-content" role="tabpanel" id={`${id}-tasks-panel`} aria-labelledby={`${id}-tasks`} hidden={tab !== "tasks"}>{children}</div>
		{tab !== "tasks" && <div className="tasks-activity" role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`}>
			<p className="muted">{tab === "agents" ? "Open conversations and active or queued secondary agents. Finished agents remain in their conversation’s Agents panel." : "Subscriptions across your conversations, including watches kept while a conversation is closed. Open one to see its controls."}</p>
			<input type="search" aria-label={`Find ${tab}`} placeholder={`Find ${tab}…`} value={search} onChange={event => setSearch(event.target.value)} />
			<ul className="tasks-activity-list">{rows.map(row => <li key={row.id}>
				<button type="button" className="tasks-activity-row" onClick={() => open(row.owner, { view: row.view, agent: row.agent })}>
					<span className="tasks-activity-heading"><strong>{row.title}</strong><small>{online(row.owner) ? row.status : "Offline · last known"}</small></span>
					{row.detail && <span className="tasks-activity-detail">{row.detail}</span>}
					<small>{location(row.owner)}{tab === "watches" || row.agent ? ` · ${conversationTitle(row.owner)}` : ""}</small>
				</button>
			</li>)}</ul>
			{!rows.length && <p className="muted">{search ? "No matches." : tab === "agents" ? "No open conversations." : "No watches reported by your connected computers."}</p>}
			{host.computers?.some(item => !item.connected) && <p className="muted">Offline computers may have changes that are not shown yet.</p>}
		</div>}
	</div>;
}

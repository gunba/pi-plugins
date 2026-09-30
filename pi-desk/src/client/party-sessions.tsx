import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import type { PartyAgent, PartyDirectory } from "../shared/parties.ts";
import type { SessionView } from "../shared/protocol.ts";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { Modal } from "./surfaces.tsx";

const nativeId = (session: SessionView) => session.snapshot?.id ?? session.agentId;
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
function AgentLabel({ agent }: { agent: PartyAgent }) {
	return <><span className={`status-dot ${agent.state}`} /><span><strong>{agent.label}</strong>
		<small>{agent.kind === "child" ? "Child agent · " : ""}{agent.state === "offline" ? "Offline · " : ""}{basename(agent.cwd)}</small></span></>;
}
export function PartySessions({ directory, sessions, computer, computerName, connected, renderSession }: {
	directory?: PartyDirectory; sessions: SessionView[]; computer?: string; computerName: string; connected: boolean;
	renderSession: (session: SessionView) => ReactNode;
}) {
	const [dialog, setDialog] = useState<{ party?: string }>();
	const [collapsed, setCollapsed] = useState(new Set<string>());
	const roots = new Map(sessions.flatMap(session => nativeId(session) ? [[nativeId(session)!, session] as const] : []));
	const agents = new Map(directory?.agents.map(agent => [agent.id, agent]));
	const grouped = new Set(directory?.groups.flatMap(group => group.members));
	return <>
		{directory && <button className="sidebar-new-party" disabled={!connected} onClick={() => setDialog({})}><Icon name="party" />New party<Icon name="plus" /></button>}
		{directory?.groups.map(group => <section className="sidebar-party" key={group.name} aria-label={`Party ${group.name}`}>
			<div className="sidebar-party-heading"><button className="party-toggle" aria-expanded={!collapsed.has(group.name)}
				onClick={() => setCollapsed(current => { const next = new Set(current); next.has(group.name) ? next.delete(group.name) : next.add(group.name); return next; })}>
				<span className={`party-chevron${collapsed.has(group.name) ? "" : " expanded"}`}>›</span><Icon name="party" /><strong>{group.name}</strong><small>{group.members.length}</small>
			</button><button className="icon-button party-manage" disabled={!connected} aria-label={`Manage party ${group.name}`} title="Add or remove agents"
				onClick={() => setDialog({ party: group.name })}><Icon name="more" /></button></div>
			{!collapsed.has(group.name) && <div className="sidebar-party-members">{group.members.map(id => {
				const root = roots.get(id), agent = agents.get(id);
				return root ? <Fragment key={id}>{renderSession(root)}</Fragment> : agent && <div className="party-member" key={id} title={agent.description || agent.label}><AgentLabel agent={agent} /></div>;
			})}</div>}
		</section>)}
		{sessions.filter(session => !grouped.has(nativeId(session) ?? "")).map(session => <Fragment key={session.key}>{renderSession(session)}</Fragment>)}
		{dialog && directory && <PartyDialog key={dialog.party ?? "new"} directory={directory} party={dialog.party} computer={computer}
			computerName={computerName} connected={connected} close={() => setDialog(undefined)} />}
	</>;
}
function PartyDialog({ directory, party, computer, computerName, connected, close }: {
	directory: PartyDirectory; party?: string; computer?: string; computerName: string; connected: boolean; close: () => void;
}) {
	const [name, setName] = useState(party ?? ""), [selected, setSelected] = useState(new Set<string>());
	const [pending, setPending] = useState(false), [error, setError] = useState("");
	const members = directory.agents.filter(agent => agent.party === party);
	const available = directory.agents.filter(agent => !party || agent.party !== party);
	const join = async (event: FormEvent) => {
		event.preventDefault(); setPending(true); setError("");
		try { await api("/parties/join", { party: name.trim(), agents: [...selected] }, computer); close(); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	};
	const remove = async (agent: PartyAgent) => {
		setPending(true); setError("");
		try { await api("/parties/leave", { party, agents: [agent.id] }, computer); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	};
	return <Modal title={party ? `Party · ${party}` : "New party"} close={() => { if (!pending) close(); }} className="party-dialog">
		<p className="muted">{computerName} · Parties are local to this computer.</p>
		{party && <section className="party-current"><h3>Members</h3>{members.map(agent => <div key={agent.id} className="party-current-member">
			<div className="party-member"><AgentLabel agent={agent} /></div><button disabled={!connected || pending} onClick={() => void remove(agent)}>Remove</button>
		</div>)}{!members.length && <p className="muted">No members.</p>}</section>}
		<form onSubmit={event => void join(event)}>
			{!party && <label className="party-name-field">Party name<input required maxLength={48} pattern={"[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,47}"}
				value={name} onChange={event => setName(event.target.value)} disabled={pending} /></label>}
			<h3>{party ? "Add agents" : "Agents"}</h3>
			<div className="party-agent-choices">{available.map(agent => <label key={agent.id} title={agent.description}>
				<input type="checkbox" disabled={pending} checked={selected.has(agent.id)} onChange={event => setSelected(current => {
					const next = new Set(current); event.target.checked ? next.add(agent.id) : next.delete(agent.id); return next;
				})} /><span><strong>{agent.label}</strong><small>{agent.kind === "child" ? "Child agent · " : ""}{agent.state === "offline" ? "Offline · " : ""}
					{agent.party ? `In ${agent.party} · ` : ""}{basename(agent.cwd)}</small></span>
			</label>)}{!available.length && <p className="muted">No other registered agents.</p>}</div>
			<p className="muted">An agent belongs to one party. Adding it moves it from its current party.</p>
			{error && <p className="error-text" role="alert">{error}</p>}
			<div className="dialog-actions"><button type="button" disabled={pending} onClick={close}>Cancel</button>
				<button className="primary" disabled={!connected || pending || !name.trim() || !selected.size}>{pending ? "Saving…" : party ? "Add selected" : "Create party"}</button></div>
		</form>
	</Modal>;
}

import { Fragment, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { PartyAgent, PartyDirectory } from "../shared/parties.ts";
import type { SessionView } from "../shared/protocol.ts";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { activityLabel } from "./activity.ts";
import { Modal } from "./surfaces.tsx";

export interface PartyComputer { id?: string; name: string; connected: boolean; directory?: PartyDirectory }
interface Peer extends PartyAgent { computer?: string; computerName: string; connected: boolean }
const nativeId = (session: SessionView) => session.snapshot?.id ?? session.agentId;
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const peerKey = (peer: Peer) => `${peer.computer ?? "local"}:${peer.id}`;
const agentCount = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;
const peersOn = (computers: PartyComputer[]): Peer[] => computers.flatMap(computer => (computer.directory?.agents ?? [])
	.map(agent => ({ ...agent, computer: computer.id, computerName: computer.name, connected: computer.connected })));
const computerGroups = (peers: Peer[]) => [...new Set(peers.map(peer => peer.computer))].map(id => ({ id, peers: peers.filter(peer => peer.computer === id) }));
export function PartyWakeMarker({ agent }: { agent?: PartyAgent }) {
	return agent?.delivery === "limited" ? <span className="party-wake-held" role="img" aria-label="Automatic wake held"
		title={agent.deliveryReason}><Icon name="pause" /><span>Wake held</span></span> : null;
}
export function PartyLabel({ name }: { name?: string | null }) {
	if (!name) return null;
	const hue = [...name.toLowerCase()].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) >>> 0, 0) % 360;
	return <span className="party-label" style={{ "--party-hue": hue } as CSSProperties} title={`Party · ${name}`}>{name}</span>;
}
function AgentLabel({ agent, computerName }: { agent: PartyAgent; computerName?: string }) {
	return <><span className={`status-dot ${agent.state}`} role="img" aria-label={activityLabel(agent.state)} title={activityLabel(agent.state)} /><span><span className="session-label-line"><strong>{agent.label}</strong><PartyWakeMarker agent={agent} /></span>
		<small><span className="session-activity">{activityLabel(agent.state)}</span> · {computerName && `${computerName} · `}{agent.kind === "child" ? "Child agent · " : ""}{basename(agent.cwd)}</small></span></>;
}
export function PartySessions({ directory, sessions, computer, connected, computers, renderSession }: {
	directory?: PartyDirectory; sessions: SessionView[]; computer?: string; connected: boolean; computers: PartyComputer[];
	renderSession: (session: SessionView, agent: PartyAgent | undefined, manage: () => void) => ReactNode;
}) {
	const [dialog, setDialog] = useState<{ party?: string }>();
	const [browsing, setBrowsing] = useState(false);
	const agents = new Map(directory?.agents.map(agent => [agent.id, agent]));
	return <>
		{directory && <button className="sidebar-new-party" onClick={() => setBrowsing(true)}><Icon name="party" />Parties{directory.groups.length ? <span>{directory.groups.length}</span> : null}</button>}
		{sessions.map(session => {
			const agent = agents.get(nativeId(session) ?? "");
			return <Fragment key={session.key}>{renderSession(session, agent, () => setDialog({ party: agent?.party ?? undefined }))}</Fragment>;
		})}
		{browsing && directory && <Modal title="Parties" close={() => setBrowsing(false)} className="party-dialog">
			{directory.groups.map(group => <button className="party-directory-row" key={group.name} onClick={() => { setBrowsing(false); setDialog({ party: group.name }); }}>
				<PartyLabel name={group.name} /><small>{agentCount(peersOn(computers).filter(peer => peer.party === group.name).length)} · Manage →</small>
			</button>)}
			{!directory.groups.length && <p className="muted">No parties on this computer.</p>}
			<div className="dialog-actions"><button onClick={() => setBrowsing(false)}>Done</button><button className="primary" disabled={!connected}
				onClick={() => { setBrowsing(false); setDialog({}); }}>New party</button></div>
		</Modal>}
		{dialog && directory && <PartyDialog key={dialog.party ?? "new"} computers={computers} party={dialog.party} preferred={computer} close={() => setDialog(undefined)} />}
	</>;
}
export function PartyDialog({ computers, party, preferred, close }: {
	computers: PartyComputer[]; party?: string; preferred?: string; close: () => void;
}) {
	const [name, setName] = useState(party ?? ""), [selected, setSelected] = useState(new Set<string>());
	const [pending, setPending] = useState(false), [error, setError] = useState("");
	const [action, setAction] = useState<"close" | "disband">();
	const [search, setSearch] = useState("");
	const matches = (peer: Peer) => `${peer.label} ${peer.computerName} ${peer.cwd} ${peer.party ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
	const peers = peersOn(computers).sort((a, b) => Number(b.computer === preferred) - Number(a.computer === preferred) || a.computerName.localeCompare(b.computerName));
	const members = peers.filter(agent => agent.party === party), available = peers.filter(agent => !party || agent.party !== party);
	const join = async (event: FormEvent) => {
		event.preventDefault(); setPending(true); setError("");
		const groups = computerGroups(available.filter(peer => selected.has(peerKey(peer))));
		const results = await Promise.allSettled(groups.map(group => api("/parties/join", { party: name.trim(), agents: group.peers.map(peer => peer.id) }, group.id)));
		const failed: string[] = [];
		results.forEach((result, index) => {
			if (result.status === "rejected") failed.push(`${groups[index].peers[0].computerName}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
		});
		setPending(false);
		if (!failed.length) close(); else setError(failed.join("\n"));
	};
	const remove = async (peer: Peer) => {
		setPending(true); setError("");
		try { await api("/parties/leave", { party, agents: [peer.id] }, peer.computer); }
		catch (error) { setError(`${peer.computerName}: ${error instanceof Error ? error.message : String(error)}`); }
		finally { setPending(false); }
	};
	if (party && action === "close") return <ClosePartyDialog party={party} computers={computers} close={close} />;
	if (party && action === "disband") return <DisbandPartyDialog party={party} computers={computers} close={close} />;
	return <Modal title={party ? `Party · ${party}` : "New party"} close={() => { if (!pending) close(); }} className="party-dialog">
		<p className="muted">Shared across your signed-in computers. Disconnected computers are unavailable.</p>
		{party && <div className="party-group-actions"><button disabled={pending || !members.length} onClick={() => setAction("disband")}><Icon name="party" />Disband party…</button>
			<button disabled={pending || !members.length} onClick={() => setAction("close")}><Icon name="close" />Close agents…</button></div>}
		<input type="search" className="party-agent-search" aria-label="Search agents" placeholder="Search agents, folders or computers" value={search} onChange={event => setSearch(event.target.value)} />
		{party && <section className="party-current"><h3>Members · {members.length}</h3><div className="party-current-members">{members.filter(matches).map(peer => <div key={peerKey(peer)} className="party-current-member">
			<div className="party-member"><AgentLabel agent={peer} computerName={peer.computerName} /></div><button disabled={!peer.connected || pending} onClick={() => void remove(peer)}>Remove</button>
		</div>)}{!members.filter(matches).length && <p className="muted">{members.length ? "No matching members." : "No members."}</p>}</div></section>}
		{error && <p className="error-text" role="alert">{error}</p>}
		{(!party || available.length > 0) ? <form onSubmit={event => void join(event)}>
			{!party && <label className="party-name-field">Party name<input required maxLength={48} pattern={"[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,47}"}
				value={name} onChange={event => setName(event.target.value)} disabled={pending} /></label>}
			<h3>{party ? "Add agents" : "Agents"}</h3>
			<div className="party-agent-choices">{available.filter(matches).map(peer => <label key={peerKey(peer)} title={peer.description}>
				<input type="checkbox" disabled={pending || !peer.connected} checked={selected.has(peerKey(peer))} onChange={event => setSelected(current => {
					const next = new Set(current); event.target.checked ? next.add(peerKey(peer)) : next.delete(peerKey(peer)); return next;
				})} /><span><strong>{peer.label}</strong><small>{peer.computerName} · {!peer.connected ? "Not connected · " : peer.state === "offline" ? "Offline · " : ""}
					{peer.kind === "child" ? "Child agent · " : ""}{peer.party ? `In ${peer.party} · ` : ""}{basename(peer.cwd)}</small></span>
			</label>)}{!available.filter(matches).length && <p className="muted">{available.length ? "No matching agents." : "No other registered agents."}</p>}</div>
			<p className="muted">An agent belongs to one party. Adding it moves it from its current party.</p>
			<div className="dialog-actions"><button type="button" disabled={pending} onClick={close}>Cancel</button>
				<button className="primary" disabled={pending || !name.trim() || !selected.size}>{pending ? "Saving…" : party ? "Add selected" : "Create party"}</button></div>
		</form> : <div className="dialog-actions"><button onClick={close}>Done</button></div>}
	</Modal>;
}
function DisbandPartyDialog({ party, computers, close }: { party: string; computers: PartyComputer[]; close: () => void }) {
	const [targets] = useState(() => peersOn(computers).filter(peer => peer.party === party));
	const [pending, setPending] = useState(false), [reports, setReports] = useState<{ name: string; text: string; failed: boolean }[]>();
	const groups = computerGroups(targets);
	const confirm = async () => {
		setPending(true);
		const results = await Promise.all(groups.map(async group => {
			const name = group.peers[0].computerName;
			if (!computers.find(computer => computer.id === group.id)?.connected) return { name, text: "Not connected — membership has not changed on this computer.", failed: true };
			let removed = 0;
			try {
				for (let offset = 0; offset < group.peers.length; offset += 64) {
					const batch = group.peers.slice(offset, offset + 64);
					await api("/parties/leave", { party, agents: batch.map(peer => peer.id) }, group.id);
					removed += batch.length;
				}
				return { name, text: `${agentCount(removed)} ungrouped.`, failed: false };
			} catch (error) {
				return { name, text: `${removed} removals confirmed. ${error instanceof Error ? error.message : String(error)} Review current membership before trying again.`, failed: true };
			}
		}));
		setReports(results); setPending(false);
	};
	return <Modal title={`Disband party · ${party}`} close={() => { if (!pending) close(); }} className="party-dialog">
		<p>Ungroup {agentCount(targets.length)}? Their conversations keep running.</p>
		<p className="muted">History and direct messages stay. Pending party broadcasts tied to these memberships are withdrawn.</p>
		{groups.map(group => <div className="party-close-computer" key={group.id ?? "local"}><strong>{group.peers[0].computerName}</strong><span className="muted">{agentCount(group.peers.length)}</span></div>)}
		{reports && <div className="party-close-reports" role="status">{reports.map((report, index) => <p key={index} className={report.failed ? "error-text" : "muted"}><strong>{report.name}</strong> · {report.text}</p>)}</div>}
		<div className="dialog-actions"><button disabled={pending} onClick={close}>{reports ? "Done" : "Cancel"}</button>
			{!reports && <button className="primary" disabled={pending || !targets.length} onClick={() => void confirm()}>{pending ? "Disbanding…" : "Disband party"}</button>}</div>
	</Modal>;
}
function ClosePartyDialog({ party, computers, close }: { party: string; computers: PartyComputer[]; close: () => void }) {
	const [targets] = useState(() => peersOn(computers).filter(peer => peer.party === party));
	const [pending, setPending] = useState(false), [reports, setReports] = useState<{ name: string; text: string; failed: boolean }[]>();
	const groups = computerGroups(targets);
	const confirm = async () => {
		setPending(true);
		const reports = await Promise.all(groups.map(async group => {
			const name = group.peers[0].computerName;
			if (!computers.find(computer => computer.id === group.id)?.connected) return { name, text: "Not connected — no agents were closed.", failed: true };
			try {
				const result = await api<{ results: { id: string; state?: string; error?: string }[] }>("/parties/close", {
					party, agents: group.peers.map(peer => ({ id: peer.id, epoch: peer.epoch })),
				}, group.id);
				const failures = result.results.filter(item => item.error);
				const closed = result.results.filter(item => item.state === "closed").length;
				const alreadyClosed = result.results.filter(item => item.state === "already_closed").length;
				const summary = [closed ? `${agentCount(closed)} closed` : "", alreadyClosed ? `${alreadyClosed} already closed` : "",
					...failures.map(item => `${group.peers.find(peer => peer.id === item.id)?.label ?? "Agent"}: ${item.error}`)].filter(Boolean).join("; ");
				return { name, failed: !!failures.length, text: summary };
			} catch (error) { return { name, text: `${error instanceof Error ? error.message : String(error)} Check current sessions before retrying.`, failed: true }; }
		}));
		setReports(reports); setPending(false);
	};
	return <Modal title={`Close agents · ${party}`} close={() => { if (!pending) close(); }} className="party-dialog">
		<p>Close {agentCount(targets.length)} across {groups.length} {groups.length === 1 ? "computer" : "computers"}?</p>
		<p className="muted">Their Pi processes and child agents stop. Saved conversations remain available to resume.</p>
		{groups.map(group => <div className="party-close-computer" key={group.id ?? "local"}><strong>{group.peers[0].computerName}</strong>
			<span className="muted">{agentCount(group.peers.length)}{!computers.find(computer => computer.id === group.id)?.connected ? " · Not connected" : ""}</span></div>)}
		{reports && <div className="party-close-reports" role="status">{reports.map((report, index) => <p key={index} className={report.failed ? "error-text" : "muted"}><strong>{report.name}</strong> · {report.text}</p>)}</div>}
		<div className="dialog-actions"><button disabled={pending} onClick={close}>{reports ? "Done" : "Cancel"}</button>
			{!reports && <button className="danger" disabled={pending || !targets.length} onClick={() => void confirm()}>{pending ? "Closing…" : "Close all agents"}</button>}</div>
	</Modal>;
}

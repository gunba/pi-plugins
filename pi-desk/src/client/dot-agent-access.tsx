import { useEffect, useState } from "react";
import { api } from "./connection.ts";

interface Approval { id: string; code: string; client: string; redirect: string; created: number }
interface Connector { enabled: boolean; url?: string; relay: string; approvals: Approval[]; connections: number }

/** Lets the Dot message agents through an OAuth-protected MCP connector added in ChatGPT; nothing else is exposed. */
export function DotAgentAccess({ computer, online }: { computer?: string; online: boolean }) {
	const [state, setState] = useState<Connector>(), [error, setError] = useState(""), [working, setWorking] = useState(false), [copied, setCopied] = useState(false);
	const load = () => api<Connector>("/dot/connector", undefined, computer).then(value => { setState(value); setError(""); }, cause => setError(String(cause)));
	useEffect(() => {
		if (!online) return;
		void load();
		// Approval requests arrive while ChatGPT waits on its sign-in page.
		const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000);
		return () => clearInterval(timer);
	}, [computer, online]);
	const post = async (body: unknown) => {
		setWorking(true); setError("");
		try { setState(await api<Connector>("/dot/connector", body, computer)); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setWorking(false); }
	};
	return <section className="dot-agent-access">
		<h4>Agent access</h4>
		<p className="muted">Lets your Dot list your Pi agents on every connected computer, message them and read their replies,
			like agents message each other. It cannot see transcripts or change settings. Agents treat its messages as peer context, not your instructions.</p>
		{state?.enabled ? <>
			{state.approvals.map(item => <div className="dot-approval" key={item.id} role="alert">
				<p><strong>{item.client}</strong> ({item.redirect}) is asking for access. Approve only if ChatGPT shows code <strong>{item.code}</strong>.</p>
				<button className="primary" disabled={working} onClick={() => void post({ approve: item.id })}>Approve</button>
				<button disabled={working} onClick={() => void post({ deny: item.id })}>Deny</button>
			</div>)}
			<p>In ChatGPT, add a custom connector (MCP) with this URL and OAuth authentication. ChatGPT will then ask you to approve it here.</p>
			<div className="dot-connector-url"><input readOnly aria-label="Dot connector URL" value={state.url ?? "Waiting for the relay connection…"} onFocus={event => event.target.select()} />
				<button disabled={!state.url} onClick={() => { void navigator.clipboard.writeText(state.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button></div>
			<p className="muted">{state.connections ? `${state.connections} approved connection${state.connections === 1 ? "" : "s"}.` : "No approved connections yet."}</p>
			<button disabled={working || !online} onClick={() => void post({ enabled: false })}>Turn off and revoke access</button>
		</> : <button disabled={working || !online || !state} onClick={() => void post({ enabled: true })}>Allow Dot to message agents</button>}
		{error && <p className="error-text" role="alert">{error}</p>}
	</section>;
}

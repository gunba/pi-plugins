import { useEffect, useState } from "react";
import { api } from "./connection.ts";

interface Connector { enabled: boolean; url?: string; relay: string }

/** Lets the Dot message agents through an MCP connector added in ChatGPT; nothing else is exposed. */
export function DotAgentAccess({ computer, online }: { computer?: string; online: boolean }) {
	const [state, setState] = useState<Connector>(), [error, setError] = useState(""), [working, setWorking] = useState(false), [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!online) return;
		void api<Connector>("/dot/connector", undefined, computer).then(setState, cause => setError(String(cause)));
	}, [computer, online]);
	const change = async (enabled: boolean) => {
		setWorking(true); setError("");
		try { setState(await api<Connector>("/dot/connector", { enabled }, computer)); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setWorking(false); }
	};
	return <section className="dot-agent-access">
		<h4>Agent access</h4>
		<p className="muted">Lets your Dot list your Pi agents on every connected computer, message them and read their replies,
			like agents message each other. It cannot see transcripts or change settings. Agents treat its messages as peer context, not your instructions.</p>
		{state?.enabled ? <>
			<p>In ChatGPT, add a custom connector (MCP) with this URL and no authentication. Treat the URL like a password.</p>
			<div className="dot-connector-url"><input readOnly aria-label="Dot connector URL" value={state.url ?? "Waiting for the relay connection…"} onFocus={event => event.target.select()} />
				<button disabled={!state.url} onClick={() => { void navigator.clipboard.writeText(state.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button></div>
			<button disabled={working || !online} onClick={() => void change(false)}>Turn off and revoke URL</button>
		</> : <button disabled={working || !online || !state} onClick={() => void change(true)}>Allow Dot to message agents</button>}
		{error && <p className="error-text" role="alert">{error}</p>}
	</section>;
}

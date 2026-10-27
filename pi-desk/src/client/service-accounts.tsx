import { useEffect, useState, type ReactNode } from "react";
import type { ServicesSnapshot } from "../shared/services.ts";
import { api, ApiError } from "./connection.ts";
import { DictationKey } from "./dictation.tsx";
import { Row } from "./settings-pages.tsx";

const names: Record<string, string> = { exa: "Exa", typesafe: "TypeSafe", elevenlabs: "ElevenLabs" };
const message = (error: unknown) => error instanceof ApiError && error.status === 404 ? "Update this computer to manage Exa and view service costs."
	: error instanceof Error ? error.message : String(error);

/** Service keys and their usage belong to the selected computer, not to an open conversation. */
export function ServiceAccounts({ computer, name, connected, legacy }: { computer?: string; name: string; connected: boolean; legacy?: ReactNode }) {
	const [snapshot, setSnapshot] = useState<ServicesSnapshot>(), [key, setKey] = useState("");
	const [working, setWorking] = useState(false), [error, setError] = useState(""), [unsupported, setUnsupported] = useState(false);
	useEffect(() => {
		if (!connected) return;
		let live = true;
		const refresh = () => api<ServicesSnapshot>("/services", undefined, computer).then(value => {
			if (live) { setSnapshot(value); setUnsupported(false); }
		}, error => { if (live) { setError(message(error)); setUnsupported(error instanceof ApiError && error.status === 404); } });
		void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
		return () => { live = false; clearInterval(timer); };
	}, [computer, connected]);
	const save = async (key: string | null) => {
		setWorking(true); setError("");
		try {
			const exa = await api<ServicesSnapshot["exa"]>("/services/exa", { key }, computer);
			setSnapshot(value => value ? { ...value, exa } : value); setKey("");
		} catch (error) { setError(message(error)); }
		finally { setWorking(false); }
	};
	const locked = !connected || working || !snapshot || snapshot.exa.environment;
	const services = [...new Set([...Object.keys(names), ...snapshot?.usage.totals.map(item => item.service) ?? []])];
	return <>
		<section className="settings-group">
			{!unsupported && <Row label="Exa" hint="Web search and page reading. A saved key applies to running conversations immediately; without a key, search uses Parallel's free service.">
				<span className="muted">{snapshot?.exa.environment ? "EXA_API_KEY environment variable" : snapshot?.exa.configured ? "API key saved" : snapshot ? "No key · free search" : connected ? "Loading…" : "Disconnected"}</span>
				<form className="settings-inline-form" onSubmit={event => { event.preventDefault(); void save(key.trim()); }}>
					<input type="password" autoComplete="off" spellCheck={false} maxLength={2000} aria-label="Exa API key" value={key} disabled={locked}
						placeholder={snapshot?.exa.configured ? "Replace API key" : "Paste API key"} onChange={event => setKey(event.target.value)} />
					<button type="submit" disabled={locked || !key.trim()}>{snapshot?.exa.configured ? "Replace API key" : "Save API key"}</button>
				</form>
				{snapshot?.exa.configured && !snapshot.exa.environment && <button className="quiet-action" disabled={locked} onClick={() => void save(null)}>Remove API key</button>}
				<a className="quiet-action" href="https://dashboard.exa.ai/api-keys" target="_blank" rel="noopener noreferrer">Get a key ↗</a>
			</Row>}
			{unsupported && legacy}
			{error && <Row label=""><span className="error-text" role="alert">{error}</span></Row>}
		</section>
		<DictationKey computer={computer} name={name} connected={connected} />
		<h3 className="settings-subheading">Service usage</h3>
		{snapshot && <section className="settings-group service-usage">
			<table className="efficiency-table"><caption>Recorded on {name}{snapshot.usage.since ? ` since ${new Date(snapshot.usage.since).toLocaleDateString()}` : " · no usage recorded yet"}</caption>
				<thead><tr><th>Service</th><th>Requests</th><th>Estimated USD</th><th>Unpriced requests</th></tr></thead>
				<tbody>{services.map(service => {
					const total = snapshot.usage.totals.find(item => item.service === service);
					return <tr key={service}><th scope="row">{names[service] ?? service}</th><td>{total?.calls.toLocaleString() ?? "—"}</td>
						<td>{total && total.calls > total.unknown ? `$${total.cost.toFixed(4)}` : "—"}</td><td>{total?.unknown || "—"}</td></tr>;
				})}</tbody>
			</table>
			<p className="muted">Estimates at API prices, not invoices. Requests whose cost isn't known are counted separately, not as free. Classifier and image calls made from a conversation also count in its cost.</p>
		</section>}
	</>;
}

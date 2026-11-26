import { useEffect, useState, type ReactNode } from "react";
import type { ServicesSnapshot } from "../shared/services.ts";
import { api, ApiError } from "./connection.ts";
import { DictationKey } from "./dictation.tsx";
import { ModelCalls } from "./model-calls.tsx";
import { Row } from "./settings-pages.tsx";

const names: Record<string, string> = { parallel: "Parallel", exa: "Exa", typesafe: "TypeSafe", elevenlabs: "ElevenLabs" };
const message = (error: unknown) => error instanceof ApiError && error.status === 404 ? "Update this computer to manage web search and view service costs."
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
			const parallel = await api<ServicesSnapshot["parallel"]>("/services/parallel", { key }, computer);
			setSnapshot(value => value ? { ...value, parallel } : value); setKey("");
		} catch (error) { setError(message(error)); }
		finally { setWorking(false); }
	};
	// A computer still on Exa reports no Parallel key and takes none until it updates.
	const parallel = snapshot?.parallel, locked = !connected || working || !parallel || parallel.environment;
	const services = [...new Set(["parallel", "typesafe", "elevenlabs", ...snapshot?.usage.totals.map(item => item.service) ?? []])];
	return <>
		<section className="settings-group">
			{!unsupported && <Row label="Parallel" hint="Web search and page reading. Free and rate-limited without a key; with one, billed to the account at higher limits. A saved key applies to running conversations immediately.">
				<span className="muted">{parallel?.environment ? "PARALLEL_API_KEY environment variable" : parallel?.configured ? "API key saved" : parallel ? "No key · free search"
					: snapshot ? "Update this computer to use Parallel" : connected ? "Loading…" : "Disconnected"}</span>
				<form className="settings-inline-form" onSubmit={event => { event.preventDefault(); void save(key.trim()); }}>
					<input type="password" autoComplete="off" spellCheck={false} maxLength={2000} aria-label="Parallel API key" value={key} disabled={locked}
						placeholder={parallel?.configured ? "Replace API key" : "Paste API key"} onChange={event => setKey(event.target.value)} />
					<button type="submit" disabled={locked || !key.trim()}>{parallel?.configured ? "Replace API key" : "Save API key"}</button>
				</form>
				{parallel?.configured && !parallel.environment && <button className="quiet-action" disabled={locked} onClick={() => void save(null)}>Remove API key</button>}
				<a className="quiet-action" href="https://platform.parallel.ai" target="_blank" rel="noopener noreferrer">Get a key ↗</a>
			</Row>}
			{!unsupported && snapshot?.models && <ModelCalls computer={computer} name={name} connected={connected} view={snapshot.models}
				saved={models => setSnapshot(value => value ? { ...value, models } : value)} />}
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
			<p className="muted">Estimates at API prices, not invoices. Requests whose cost isn't known are counted separately, not as free. Classifier, image and ask_model calls made from a conversation also count in its cost.</p>
		</section>}
	</>;
}

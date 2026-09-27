import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import type { Computer } from "./workspace.ts";
import type { SavedPage } from "../shared/catalog.ts";

export const RESUME_NOTICE = "Resuming can deliver overdue reminders and restart queued child work. Goal continuation needs its own Resume action.";

export function SavedSessions({ computers, connected, selected }: {
	computers?: Computer[]; connected: boolean; selected: (key: string) => void;
}) {
	const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
	useEffect(() => { const timer = setTimeout(() => setQuery(draft.trim()), 250); return () => clearTimeout(timer); }, [draft]);
	return <div className="saved-sessions">
		<p className="muted">Close a session in its terminal before resuming it here.</p>
		<p className="muted">{RESUME_NOTICE}</p>
		<input className="search" value={draft} maxLength={200} aria-label="Search saved sessions"
			placeholder="Search titles, opening text or projects" onChange={event => setDraft(event.target.value)} />
		{draft.trim() !== query && <p className="muted" role="status">Searching…</p>}
		{computers ? computers.map(computer => <ComputerSessions key={`${computer.id}:${computer.epoch}:${query}`}
			computer={computer.id} name={computer.name} online={computer.online} query={query} selected={selected} />)
			: <ComputerSessions key={query} name="This computer" online={connected} query={query} selected={selected} />}
	</div>;
}

function ComputerSessions({ computer, name, online, query, selected }: {
	computer?: string; name: string; online: boolean; query: string; selected: (key: string) => void;
}) {
	const [page, setPage] = useState<SavedPage>();
	const [position, setPosition] = useState({ offset: 0, revision: undefined as string | undefined, refresh: false });
	const [previous, setPrevious] = useState<number[]>([]);
	const [loading, setLoading] = useState(false), [error, setError] = useState("");
	const [resuming, setResuming] = useState("");
	const request = useRef(0);
	useEffect(() => {
		let disposed = false;
		if (!online) { setLoading(false); return; }
		setLoading(true); setError("");
		const params = new URLSearchParams({ query, offset: String(position.offset) });
		if (position.revision) params.set("revision", position.revision);
		if (position.refresh) params.set("refresh", "1");
		void api<SavedPage>(`/history?${params}`, undefined, computer).then(result => {
			if (!disposed) setPage(result);
		}).catch(error => { if (!disposed) setError(String(error)); })
			.finally(() => { if (!disposed) setLoading(false); });
		return () => { disposed = true; };
	}, [computer, online, query, position]);
	useEffect(() => () => { request.current++; }, []);
	const resume = async (file: string) => {
		const current = ++request.current;
		setResuming(file); setError("");
		try {
			const result = await api<{ key: string }>("/resume", { file }, computer);
			if (current === request.current) selected(result.key);
		} catch (error) { if (current === request.current) setError(String(error)); }
		finally { if (current === request.current) setResuming(""); }
	};
	const groups = new Map<string, SavedPage["sessions"]>();
	for (const item of page?.sessions ?? []) {
		if (!groups.has(item.cwd)) groups.set(item.cwd, []);
		groups.get(item.cwd)!.push(item);
	}
	return <section className="saved-computer" aria-label={`Saved sessions on ${name}`}>
		<header><h3>{name}</h3><button disabled={!online || loading} onClick={() => {
			setPrevious([]); setPosition({ offset: 0, revision: undefined, refresh: true });
		}}>Refresh</button></header>
		{!online && <p className="muted">Offline. Connect this computer to browse or resume its saved sessions.</p>}
		{loading && <p className="muted" role="status">Loading saved sessions…</p>}
		{error && <p className="error-text" role="alert">{error}</p>}
		{page?.warning && <p className="error-text" role="alert">{page.warning}</p>}
		{page && <p className="muted saved-count" role="status">
			{page.sessions.length ? `${page.offset + 1}–${page.offset + page.sessions.length} of ${page.matched}` : `0 of ${page.matched}`}
			{query ? ` matches · ${page.total} saved` : " saved sessions"}
		</p>}
		{!loading && page?.matched === 0 && <p className="muted">{query ? "No matching sessions." : "No saved sessions."}</p>}
		{[...groups].map(([cwd, sessions]) => <div className="saved-project" key={cwd}>
			<h4>{cwd || "Unknown project"}</h4>
			{sessions.map(item => <article className="history-item" key={item.file}>
				<strong>{item.name || item.firstMessage || "Untitled session"}</strong>
				<small>{item.messageCount} messages · {new Date(item.modified).toLocaleString()}</small>
				{item.warning && <small className="error-text">{item.warning}</small>}
				<button disabled={!online || loading || !!resuming} onClick={() => void resume(item.file)}>
					{resuming === item.file ? "Resuming…" : "Resume"}
				</button>
			</article>)}
		</div>)}
		{page && (previous.length > 0 || page.next !== undefined) && <nav className="saved-pages" aria-label={`Pages on ${name}`}>
			<button disabled={!online || loading || !previous.length} onClick={() => {
				setPosition({ offset: previous.at(-1)!, revision: page.revision, refresh: false }); setPrevious(values => values.slice(0, -1));
			}}>Previous</button>
			<button disabled={!online || loading || page.next === undefined} onClick={() => {
				setPrevious(values => [...values, page.offset]); setPosition({ offset: page.next!, revision: page.revision, refresh: false });
			}}>Next</button>
		</nav>}
	</section>;
}

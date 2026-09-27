import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import type { ArtifactPage, ChatBlock } from "../shared/protocol.ts";
import { CopyButton } from "./transcript-parts.tsx";
import { AssetLink } from "./assets.tsx";
import { FileLink } from "./file-view.tsx";
import { SurfaceFrame } from "./surfaces.tsx";
import { useReferenceQuery } from "./reference-origin.tsx";

export function ArtifactLink({ session, id, label }: { session: string; id: string; label: string }) {
	const [open, setOpen] = useState(false);
	return <><button className="artifact-link" onClick={() => setOpen(true)}>{label} ↗</button>
		{open && <ArtifactViewer session={session} id={id} label={label} close={() => setOpen(false)} />}</>;
}
function ArtifactViewer({ session, id, label, close }: { session: string; id: string; label: string; close: () => void }) {
	const origin = useReferenceQuery();
	const content = useRef<HTMLPreElement>(null);
	const request = useRef(0);
	const [page, setPage] = useState<ArtifactPage>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [position, setPosition] = useState("0");
	const [previous, setPrevious] = useState<number[]>([]);
	const load = async (offset: number, search = query) => {
		const current = ++request.current;
		setLoading(true); setError("");
		try {
			const params = new URLSearchParams(origin);
			params.set("offset", String(offset));
			if (search) params.set("query", search);
			const result = await api<ArtifactPage>(`/sessions/${session}/artifacts/${id}?${params}`);
			if (current !== request.current) return false;
			setPage(result); setQuery(search); setPosition(String(offset));
			if (content.current) content.current.scrollTop = 0;
			return true;
		} catch (error) { if (current === request.current) setError(String(error)); return false; }
		finally { if (current === request.current) setLoading(false); }
	};
	useEffect(() => {
		void load(0, "");
		return () => { request.current++; };
	}, [session, id, origin]);
	return <SurfaceFrame className="artifact-dialog" label={label} close={close} portal>
		<header><div><h2 data-surface-heading tabIndex={-1}>{label}</h2><small>{id}</small></div><button aria-label="Close artifact" onClick={close}>×</button></header>
		<form className="artifact-search" onSubmit={event => {
			event.preventDefault(); void load(0, draft).then(ok => { if (ok) setPrevious([]); });
		}}>
			<input aria-label="Search artifact" value={draft} onChange={event => setDraft(event.target.value)}
				maxLength={1000} placeholder="Find matching lines (case-sensitive)" />
			<button disabled={loading}>Search</button>
			{query && <button type="button" disabled={loading} onClick={() => {
				setDraft(""); void load(0, "").then(ok => { if (ok) setPrevious([]); });
			}}>Clear</button>}
		</form>
		<div className="artifact-controls">
			<button disabled={loading || !previous.length} onClick={() => {
				void load(previous.at(-1)!).then(ok => { if (ok) setPrevious(values => values.slice(0, -1)); });
			}}>Previous</button>
			<button disabled={loading || page?.next == null} onClick={() => {
				const offset = page!.offset;
				void load(page!.next!).then(ok => { if (ok) setPrevious(values => [...values, offset]); });
			}}>Next</button>
			<form onSubmit={event => { event.preventDefault(); void load(Number(position)).then(ok => { if (ok) setPrevious([]); }); }}>
				<input aria-label="Character offset" type="number" min={0} step={1} max={page?.total} value={position}
					onChange={event => setPosition(event.target.value)} />
				<button disabled={loading}>Go</button>
			</form>
			{page && <CopyButton key={`${page.generation}/${page.offset}/${query}`} text={() => page.text} label="Copy page" />}
		</div>
		<p className="muted artifact-position" role="status">{loading ? "Loading…" : page
			? `${query ? "Matching lines" : "Captured output"} · ${page.offset.toLocaleString()}–${(page.offset + page.text.length).toLocaleString()} of ${page.total.toLocaleString()} UTF-16 characters`
			: "Captured output"}</p>
		{error && <p className="error-text" role="alert">{error}</p>}
		<pre ref={content} className="artifact-text" tabIndex={0} aria-label="Captured output">{page?.text || (!loading && !error ? "No matching text." : "")}</pre>
	</SurfaceFrame>;
}

export function DiffCard({ block, session }: { block: Extract<ChatBlock, { type: "diff" }>; session: string }) {
	const lines = block.text.split("\n"), visible = lines.slice(0, 400);
	return <details className="tool-card diff-card"><summary><span className="diff-action">{block.action}</span>
		<strong>{block.path}{block.movePath ? ` → ${block.movePath}` : ""}</strong></summary>
		<CopyButton text={() => block.text} label="Copy diff preview" />
		{block.file && <FileLink session={session} file={block.file}>Open file</FileLink>}
		<pre>{visible.map((line, index) => <span key={index} className={line.startsWith("+") ? "diff-add"
			: line.startsWith("-") ? "diff-remove" : "diff-context"}>{line}</span>)}</pre>
		{(block.truncated || lines.length > visible.length) && <p className="muted">Diff preview limited to 12,000 characters / 400 lines.</p>}
		{block.full && <AssetLink session={session} asset={block.full} />}
	</details>;
}

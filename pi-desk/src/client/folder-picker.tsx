import { useEffect, useId, useState } from "react";
import { api } from "./connection.ts";
import { Modal } from "./surfaces.tsx";
import type { FolderPage, FolderPlaces, FolderLocation } from "../shared/folders.ts";

const nameFor = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function FolderIcon() {
	return <svg className="folder-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
		<path d="M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
	</svg>;
}

export function FolderField({ value, onChange, computer, disabled = false }: {
	value: string; onChange: (path: string) => void; computer?: string; disabled?: boolean;
}) {
	const [open, setOpen] = useState(false), label = useId();
	return <div className="folder-field">
		<span id={label}>Project folder</span>
		<button type="button" aria-labelledby={label} disabled={disabled} onClick={() => setOpen(true)} title={value}>
			<FolderIcon />
			<span><strong>{value ? nameFor(value) : "Choose a folder"}</strong>{value && <small>{value}</small>}</span>
			<span className="folder-browse-label">Browse…</span>
		</button>
		{open && <FolderBrowser key={computer ?? "local"} computer={computer} initial={value} online={!disabled}
			close={() => setOpen(false)} selected={path => { onChange(path); setOpen(false); }} />}
	</div>;
}

function FolderBrowser({ computer, initial, online, selected, close }: {
	computer?: string; initial: string; online: boolean; selected: (path: string) => void; close: () => void;
}) {
	const [path, setPath] = useState(initial || "~"), [page, setPage] = useState<FolderPage>();
	const [places, setPlaces] = useState<FolderPlaces>(), [drives, setDrives] = useState<FolderLocation[]>([]);
	const [placesError, setPlacesError] = useState(""), [driveWarning, setDriveWarning] = useState("");
	const [query, setQuery] = useState(""), [search, setSearch] = useState(""), [hidden, setHidden] = useState(false);
	const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
	const [pages, setPages] = useState<number[]>([]);
	const [loading, setLoading] = useState(true), [error, setError] = useState("");
	const [editing, setEditing] = useState(false), [typedPath, setTypedPath] = useState("");
	const [trail, setTrail] = useState<string[]>([]);
	useEffect(() => {
		if (search.trim() === query) return;
		const timer = setTimeout(() => { setQuery(search.trim()); setOffset(0); setPages([]); }, 180);
		return () => clearTimeout(timer);
	}, [search, query]);
	useEffect(() => {
		if (!online) return;
		let alive = true;
		void api<FolderPlaces>("/folders/places", undefined, computer).then(value => {
			if (alive) { setPlaces(value); setPlacesError(""); }
		}, error => { if (alive) setPlacesError(message(error)); });
		// Drive discovery must not delay browsing or recent projects on a slow PC.
		void api<Pick<FolderPlaces, "locations" | "warning">>("/folders/drives", undefined, computer).then(value => {
			if (alive) { setDrives(value.locations); setDriveWarning(value.warning ?? ""); }
		}, error => { if (alive) setDriveWarning(message(error)); });
		return () => { alive = false; };
	}, [computer, online]);
	useEffect(() => {
		if (!online) return;
		let alive = true;
		setLoading(true); setError("");
		const params = new URLSearchParams({ path, query, hidden: hidden ? "1" : "0", offset: String(offset) });
		void api<FolderPage>(`/folders?${params}`, undefined, computer).then(value => {
			if (alive) { setPage(value); setLoading(false); }
		}, error => { if (alive) { setError(message(error)); setLoading(false); } });
		return () => { alive = false; };
	}, [computer, path, query, hidden, offset, revision, online]);
	const navigate = (next: string, back = false) => {
		if (!back && page && next !== page.path) setTrail(value => [...value, page.path].slice(-32));
		setPath(next); setSearch(""); setQuery(""); setOffset(0); setPages([]); setEditing(false);
		setLoading(true); setError(""); setRevision(value => value + 1);
	};
	const locations = [...new Map([...(places?.locations ?? []), ...drives].map(value => [value.path, value])).values()];
	const ready = online && !!page && !loading && !error && !editing;
	return <Modal title="Choose a folder" className="folder-modal" close={close}>
		{!online && <p role="status" className="error-text">Reconnect to this computer to browse its folders.</p>}
		<label className="folder-quick-select">Recent projects and locations
			<select value="" disabled={!online} onChange={event => navigate(event.target.value)}>
				<option value="" disabled>Jump to a folder…</option>
				<optgroup label="Locations">{locations.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</optgroup>
				<optgroup label="Recent projects">{places?.projects.map(item => <option key={item.path} value={item.path}>{item.name} · {item.path}</option>)}</optgroup>
			</select>
		</label>
		{(placesError || driveWarning) && <p role="status" className="muted folder-notice">{placesError || driveWarning}</p>}
		<div className="folder-browser">
			<aside className="folder-places" aria-label="Folder locations">
				<h3>Locations</h3>
				{!places && !placesError && <p className="muted">Loading projects…</p>}
				{locations.map(item => <button type="button" key={item.path} disabled={!online} title={item.path}
					onClick={() => navigate(item.path)}><FolderIcon /><span>{item.name}</span></button>)}
				<h3>Recent projects</h3>
				{places?.projects.map(item => <button type="button" key={item.path} disabled={!online} title={item.path}
					onClick={() => navigate(item.path)}><FolderIcon /><span><strong>{item.name}</strong><small>{item.path}</small></span></button>)}
				{places && !places.projects.length && <p className="muted">Projects appear here as you use Pi.</p>}
			</aside>
			<section className="folder-content" aria-label="Browse folders">
				<div className="folder-toolbar">
					<button type="button" aria-label="Back to previous folder" disabled={!online || !trail.length} onClick={() => {
						const previous = trail.at(-1)!; setTrail(value => value.slice(0, -1)); navigate(previous, true);
					}}>←</button>
					<button type="button" disabled={!online || !page?.parent} onClick={() => navigate(page!.parent!)}>Up</button>
					<button type="button" disabled={!online} onClick={() => navigate("~")}>Home</button>
					<button type="button" disabled={!online} onClick={() => { setTypedPath(page?.path ?? path); setEditing(value => !value); }}>Enter path</button>
				</div>
				{editing ? <form className="folder-address" onSubmit={event => { event.preventDefault(); event.stopPropagation(); navigate(typedPath); }}>
					<input aria-label="Folder path" value={typedPath} onChange={event => setTypedPath(event.target.value)}
						autoFocus autoComplete="off" spellCheck={false} required />
					<button disabled={!online || !typedPath.trim()}>Go</button>
				</form> : <nav className="folder-breadcrumbs" aria-label="Folder path">
					{page?.breadcrumbs.map(item => <button type="button" key={item.path} title={item.path}
						disabled={!online || loading} onClick={() => navigate(item.path)}>{item.name}</button>)}
				</nav>}
				<div className="folder-filter">
					<input aria-label="Filter folders" placeholder="Filter folders" value={search}
						onChange={event => setSearch(event.target.value)} maxLength={200} />
					<label title="Include folders whose names start with a dot."><input type="checkbox" checked={hidden}
						onChange={event => { setHidden(event.target.checked); setOffset(0); setPages([]); }} /> Show hidden</label>
				</div>
				{error && <p className="error-text folder-error" role="alert">Could not open this folder. {error}</p>}
				<div className="folder-entries" aria-label="Folders" aria-busy={loading} onKeyDown={event => {
					if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
					const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					if (index < 0) return;
					event.preventDefault();
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
						: Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
					buttons[next]?.focus();
				}}>
					{loading && <p className="muted" role="status">Loading folders…</p>}
					{!loading && page?.folders.map(item => <button type="button" key={item.path} disabled={!online} title={item.path}
						onClick={() => navigate(item.path)}><FolderIcon /><span>{item.name}</span>{item.link && <small>Link</small>}<span aria-hidden="true">›</span></button>)}
					{!loading && !error && page && !page.folders.length &&
						<p className="muted">{query ? "No matching folders." : "No subfolders. You can use this folder."}</p>}
				</div>
				<div className="folder-paging">
					<span>{page && !loading ? `${page.total} ${page.total === 1 ? "folder" : "folders"}` : ""}</span>
					<button type="button" disabled={!online || loading || !pages.length} onClick={() => {
						setOffset(pages.at(-1)!); setPages(value => value.slice(0, -1));
					}}>Previous</button>
					<button type="button" disabled={!online || loading || page?.next === undefined} onClick={() => {
						setPages(value => [...value, offset]); setOffset(page!.next!);
					}}>Next</button>
				</div>
			</section>
		</div>
		<div className="dialog-actions folder-selection">
			<span title={page?.path}>{page?.path}</span>
			<button type="button" onClick={close}>Cancel</button>
			<button type="button" className="primary" disabled={!ready} onClick={() => selected(page!.path)}>Use this folder</button>
		</div>
	</Modal>;
}

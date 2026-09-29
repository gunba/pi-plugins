import { useEffect, useId, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, ApiError } from "./connection.ts";
import { Modal } from "./surfaces.tsx";
import { connectionLabel } from "./connection-state.ts";
import type { Computer } from "./workspace.ts";
import { savedProgressLabel, type SavedPage } from "../shared/catalog.ts";
import type { SavedSession } from "../shared/protocol.ts";
import { FolderField } from "./folder-picker.tsx";

export const RESUME_NOTICE = "Resuming can deliver overdue reminders and restart queued child work. Goal continuation needs its own Resume action.";
const scanning = (page?: SavedPage) => page && ["loading", "queued"].includes(page.progress.state);

export function ResumeConversation({ computers, connected, cwd, current, selected, close }: {
	computers?: Computer[]; connected: boolean; cwd: string; current?: { computer?: string; cwd: string };
	selected: (key: string) => void; close: () => void;
}) {
	const [computer, setComputer] = useState<string>();
	const target = computers?.find(value => value.id === computer);
	const [project, setProject] = useState(current?.cwd ?? cwd);
	const [all, setAll] = useState(false);
	const [query, setQuery] = useState(""), [draft, setDraft] = useState(""), [named, setNamed] = useState(false);
	const chosen = !computers || !!target;
	useEffect(() => { const timer = setTimeout(() => setQuery(draft.trim()), 200); return () => clearTimeout(timer); }, [draft]);
	return <Modal title="Resume conversation" className="resume-modal" close={close}>
		<div className="resume-picker">
			{computers && <label>Computer
				<select data-autofocus aria-label="Computer to resume on" value={computer ?? ""} onChange={event => {
					const id = event.target.value, next = computers.find(value => value.id === id);
					setComputer(id); setProject(current?.computer === id ? current.cwd : next?.cwd ?? "");
					setAll(false);
				}}>
					<option value="" disabled>Choose a computer</option>
					{computers.map(value => <option key={value.id} value={value.id} disabled={!value.connected}>
						{value.name}{value.connected ? "" : ` · ${connectionLabel(value)}`}
					</option>)}
				</select>
			</label>}
			{!chosen ? <p className="muted">Choose where the conversation is saved.</p> : <>
				<div className="resume-scope" aria-label="Session scope">
					<button aria-pressed={!all} onClick={() => setAll(false)}>Project</button>
					<button aria-pressed={all} onClick={() => setAll(true)}>All projects</button>
					<label><input type="checkbox" checked={named} onChange={event => setNamed(event.target.checked)} /> Named only</label>
				</div>
				{!all && <FolderField key={computer ?? "local"} value={project} onChange={setProject} computer={computer}
					disabled={!(target?.connected ?? connected)} />}
				<input className="search" aria-label="Search saved conversations" placeholder="Search titles, opening text or projects"
					value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} />
				{(all || project) && <SessionList key={`${computer ?? "local"}:${all ? "*" : project}:${target?.epoch ?? 0}`}
					computer={computer} cwd={all ? undefined : project} online={target?.connected ?? connected}
					query={query} named={named} selected={selected} />}
			</>}
		</div>
	</Modal>;
}

function SessionList({ computer, cwd, online, query, named, selected }: {
	computer?: string; cwd?: string; online: boolean; query: string; named: boolean; selected: (key: string) => void;
}) {
	const [page, setPage] = useState<SavedPage>(), [items, setItems] = useState<SavedSession[]>([]);
	const [choice, setChoice] = useState(""), [busy, setBusy] = useState(false), [resuming, setResuming] = useState(false);
	const [error, setError] = useState(""), [version, setVersion] = useState(0);
	const scroll = useRef<HTMLDivElement>(null), scan = useRef<string | undefined>(undefined);
	const request = useRef(0), mounted = useRef(true), refresh = useRef(false);
	const paused = useRef(false);
	const reader = useRef(crypto.randomUUID()).current;
	const prefix = useId();
	const virtual = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current, estimateSize: () => 66, overscan: 6 });
	const rows = virtual.getVirtualItems();
	const active = items.findIndex(item => item.file === choice);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false; request.current++;
			if (scan.current) void api("/history/cancel", { scan: scan.current, reader }, computer).catch(() => {});
		};
	}, [computer]);
	const params = (offset = 0) => {
		const value = new URLSearchParams({ query, named: named ? "1" : "0", offset: String(offset), reader });
		if (cwd !== undefined) value.set("cwd", cwd);
		if (scan.current) value.set("scan", scan.current);
		return value;
	};
	useEffect(() => {
		let disposed = false, timer: ReturnType<typeof setTimeout>;
		const generation = ++request.current;
		paused.current = false;
		setChoice(""); setItems([]); setPage(undefined);
		if (!online) { setBusy(false); return; }
		const load = async () => {
			if (paused.current) return;
			setBusy(true); setError("");
			const values = params();
			if (refresh.current) { values.delete("scan"); values.set("refresh", "1"); refresh.current = false; }
			try {
				const result = await api<SavedPage>(`/history?${values}`, undefined, computer);
				if (disposed || generation !== request.current) {
					if (!mounted.current) void api("/history/cancel", { scan: result.progress.id, reader }, computer).catch(() => {});
					return;
				}
				scan.current = result.progress.id;
				if (paused.current) return;
				setPage(result); setItems(result.sessions);
				if (scanning(result)) timer = setTimeout(() => void load(), 500);
			} catch (error) {
				if (disposed || generation !== request.current || paused.current) return;
				if (error instanceof ApiError && error.status === 409) {
					scan.current = undefined; setVersion(value => value + 1);
				} else setError(error instanceof Error ? error.message : String(error));
			} finally { if (!disposed && generation === request.current) setBusy(false); }
		};
		void load();
		return () => { disposed = true; clearTimeout(timer); };
	}, [computer, cwd, online, query, named, version]);
	// Fetch another bounded page only as the reader approaches it, not a button per session.
	const last = rows.at(-1)?.index ?? -1;
	useEffect(() => {
		if (!online || busy || error || paused.current || scanning(page) || page?.next === undefined || last < items.length - 8) return;
		const generation = request.current, values = params(page.next);
		values.set("revision", page.revision); setBusy(true);
		void api<SavedPage>(`/history?${values}`, undefined, computer).then(result => {
			if (!mounted.current || generation !== request.current) return;
			setPage(result); setItems(values => [...values, ...result.sessions]);
		}).catch(error => {
			if (!mounted.current || generation !== request.current) return;
			if (error instanceof ApiError && error.status === 409) {
				scan.current = undefined; setVersion(value => value + 1);
			} else setError(error instanceof Error ? error.message : String(error));
		}).finally(() => { if (mounted.current && generation === request.current) setBusy(false); });
	}, [last, page, busy, online, error]);
	const resume = async (file: string) => {
		if (!online || resuming) return;
		setResuming(true); setError("");
		try {
			const result = await api<{ key: string }>("/resume", { file, takeover: true }, computer);
			if (mounted.current) selected(result.key);
		} catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
		finally { if (mounted.current) setResuming(false); }
	};
	return <>
		<div className="resume-progress">
			<span role="status">{!online ? "Connecting to this computer…" : savedProgressLabel(page, !!query || named)}</span>
			{scanning(page) ? <button onClick={() => {
				paused.current = true; setBusy(false);
				setPage(value => value && ({ ...value, progress: { ...value.progress, state: "cancelled" } }));
				void api("/history/cancel", { scan: scan.current, reader }, computer).catch(error => setError(String(error)));
			}}>Stop scan</button> : <button disabled={!online || busy} onClick={() => {
				refresh.current = true; setVersion(value => value + 1);
			}}>Refresh</button>}
		</div>
		{error && <p className="error-text" role="alert">{error}</p>}
		{page?.warning && <p className="error-text" role="alert">{page.warning}</p>}
		<div className="resume-results" ref={scroll} role="listbox" aria-label="Saved conversations" aria-busy={!!scanning(page)} tabIndex={0}
			aria-activedescendant={active >= 0 && rows.some(row => row.index === active) ? `${prefix}-${active}` : undefined}
			onKeyDown={event => {
				if (event.key === "Enter" && active >= 0) { event.preventDefault(); void resume(choice); return; }
				if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
					: Math.max(0, Math.min(items.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
				setChoice(items[next].file); virtual.scrollToIndex(next, { align: "auto" });
			}}>
			<div style={{ height: virtual.getTotalSize(), position: "relative" }}>
				{rows.map(row => {
					const item = items[row.index];
					return <div id={`${prefix}-${row.index}`} key={item.file} role="option" aria-selected={item.file === choice}
						aria-posinset={row.index + 1} aria-setsize={page?.matched} className="resume-row"
						style={{ position: "absolute", height: row.size, transform: `translateY(${row.start}px)` }}
						onClick={() => { setChoice(item.file); scroll.current?.focus(); }} onDoubleClick={() => void resume(item.file)}>
						<strong>{item.name || item.firstMessage || "Untitled conversation"}</strong>
						<small title={item.cwd}>{item.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? item.cwd}</small>
						<span>{new Date(item.modified).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })} · {item.messageCount} {item.messageCount === 1 ? "message" : "messages"}</span>
					</div>;
				})}
			</div>
			{!items.length && scanning(page) && <p className="muted">Reading this computer's saved history. Conversations will appear here as they are found.</p>}
			{!items.length && page?.progress.state === "ready" && <p className="muted">{query || named
				? "No conversations match these filters." : cwd ? "No conversations found for this project. Try All projects."
					: "No saved conversations found on this computer."}</p>}
		</div>
		<p className="muted resume-notice">If this conversation is open in desktop Pi, Resume stops its active work and closes that Pi session first. Other conversations stay open.</p>
		<details className="resume-notice"><summary>What resumes</summary>
			<p>{RESUME_NOTICE}</p>
		</details>
		<div className="dialog-actions">
			<span className="muted">{active >= 0 ? items[active].name || items[active].firstMessage || "Untitled conversation" : "Select a conversation"}</span>
			<button className="primary" disabled={!online || active < 0 || resuming} onClick={() => void resume(choice)}>
				{resuming ? "Resuming…" : "Resume"}
			</button>
		</div>
	</>;
}

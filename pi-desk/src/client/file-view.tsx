import { useEffect, useRef, useState, type ReactNode } from "react";
import { SurfaceFrame } from "./surfaces.tsx";
import { api, fileComputerName } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { CopyButton } from "./transcript-parts.tsx";
import { useReferenceQuery } from "./reference-origin.tsx";
import { decodeBase64 } from "./blob-pool.ts";
import { FILE_CHUNK_BYTES, FILE_DOWNLOAD_LIMIT, FILE_IMAGE_LIMIT, type FileChunk, type FileInfo, type FileReference, type FileTextPage } from "../shared/files.ts";

async function fileBlob(session: string, file: FileInfo, origin: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<Blob> {
	if (file.size > FILE_DOWNLOAD_LIMIT) throw new Error("Downloads are limited to 128 MiB.");
	const pieces: Uint8Array<ArrayBuffer>[] = [];
	for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES * 4) {
		signal.throwIfAborted();
		const requests = Array.from({ length: Math.min(4, Math.ceil((file.size - offset) / FILE_CHUNK_BYTES)) }, (_, index) => {
			const position = offset + index * FILE_CHUNK_BYTES;
			return api<FileChunk>(`/sessions/${session}/files/${file.id}/chunk?${origin}&version=${file.version}&offset=${position}`).then(chunk => {
				const bytes = decodeBase64(chunk.base64);
				if (chunk.offset !== position || bytes.length !== Math.min(FILE_CHUNK_BYTES, file.size - position)) throw new Error("Incomplete file transfer.");
				return bytes;
			});
		});
		pieces.push(...await Promise.all(requests));
		signal.throwIfAborted(); progress(Math.min(offset + FILE_CHUNK_BYTES * 4, file.size));
	}
	return new Blob(pieces, { type: "application/octet-stream" });
}

export function FileLink({ session, file, children }: { session: string; file: FileReference; children?: ReactNode }) {
	const origin = useReferenceQuery(), computer = fileComputerName(session) ?? (session.includes(":") ? "the file’s computer" : "this computer");
	const mobile = typeof navigator !== "undefined" && /Android|iPhone|iPad/i.test(navigator.userAgent);
	const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
	const transfer = useRef<AbortController | undefined>(undefined), statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => { transfer.current?.abort(); clearTimeout(statusTimer.current); }, []);
	const action = async (operation: "open" | "reveal" | "download") => {
		if (pending) return;
		clearTimeout(statusTimer.current); setPending(true); setError(""); setStatus(operation === "download" ? "Downloading…" : "Opening…");
		try {
			const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
			if (operation === "download") {
				const controller = transfer.current = new AbortController();
				const blob = await fileBlob(session, info, origin, controller.signal, bytes => setStatus(`Downloading ${Math.round(bytes / Math.max(info.size, 1) * 100)}%`));
				controller.signal.throwIfAborted();
				const url = URL.createObjectURL(blob), link = document.createElement("a");
				link.href = url; link.download = info.name; document.body.append(link); link.click(); link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 60_000); setStatus("");
			} else {
				await api(`/sessions/${session}/files/${file.id}/${operation}?${origin}`, { id: crypto.randomUUID(), version: info.version });
				setStatus(`Open requested on ${computer}`);
				statusTimer.current = setTimeout(() => setStatus(""), 2500);
			}
		} catch (error) { setError(error instanceof Error ? error.message : "File unavailable."); setStatus(""); }
		finally { setPending(false); }
	};
	return <span className="file-link-wrap">
		<button type="button" className="file-link" disabled={pending} title={mobile ? "Download here" : `Open on ${computer}`}
			onClick={event => { event.stopPropagation(); void action(mobile ? "download" : "open"); }}>{children ?? file.name}</button>
		<span className="file-link-actions">
			<button type="button" className="icon-button" disabled={pending} aria-label={`Show containing folder on ${computer}`} title={`Show containing folder on ${computer}`}
				onClick={event => { event.stopPropagation(); void action("reveal"); }}><Icon name="folder" /></button>
			<button type="button" className="icon-button" disabled={pending} aria-label="Download here" title="Download here"
				onClick={event => { event.stopPropagation(); void action("download"); }}><Icon name="download" /></button>
			<button type="button" className="icon-button" aria-label="Preview file" title="Preview file"
				onClick={event => { event.stopPropagation(); setOpen(true); }}><Icon name="preview" /></button>
		</span>
		{pending && <span className="file-action-status" role="status">{status}</span>}
		{!pending && status && <span className="file-action-status">{status}</span>}
		{error && <span className="file-action-error" role="alert">{error}<button className="icon-button" aria-label="Dismiss file error" onClick={event => { event.stopPropagation(); setError(""); }}><Icon name="close" /></button></span>}
		{open && <FileViewer session={session} reference={file} close={() => setOpen(false)} />}
	</span>;
}
function FileViewer({ session, reference, close }: { session: string; reference: FileReference; close: () => void }) {
	const origin = useReferenceQuery();
	const content = useRef<HTMLPreElement>(null);
	const request = useRef(0), transfer = useRef<AbortController | undefined>(undefined);
	const [info, setInfo] = useState<FileInfo>();
	const [page, setPage] = useState<FileTextPage>();
	const [previous, setPrevious] = useState<number[]>([]);
	const [line, setLine] = useState(String(reference.line ?? 1));
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [image, setImage] = useState("");
	const [download, setDownload] = useState("");
	const [progress, setProgress] = useState<number>();
	const urls = useRef<string[]>([]);
	const url = (blob: Blob) => { const value = URL.createObjectURL(blob); urls.current.push(value); return value; };
	const textPage = async (file: FileInfo, position: { offset: number } | { line: number }) => {
		const params = new URLSearchParams(origin); params.set("version", file.version);
		for (const [key, value] of Object.entries(position)) params.set(key, String(value));
		return api<FileTextPage>(`/sessions/${session}/files/${file.id}/text?${params}`);
	};
	const loadPage = async (position: { offset: number } | { line: number }) => {
		if (!info) return false;
		const current = ++request.current;
		setLoading(true); setError("");
		try {
			const result = await textPage(info, position);
			if (current !== request.current) return false;
			setPage(result); if (content.current) content.current.scrollTop = 0;
			return true;
		} catch (error) { if (current === request.current) setError(String(error)); return false; }
		finally { if (current === request.current) setLoading(false); }
	};
	const refresh = async () => {
		const current = ++request.current;
		transfer.current?.abort();
		for (const value of urls.current) URL.revokeObjectURL(value);
		urls.current = []; setDownload(""); setImage(""); setPage(undefined); setInfo(undefined); setPrevious([]);
		setLoading(true); setError(""); setProgress(undefined);
		try {
			const file = await api<FileInfo>(`/sessions/${session}/files/${reference.id}?${origin}`);
			if (current !== request.current) return;
			setInfo(file);
			if (file.kind === "text") {
				const result = await textPage(file, { line: reference.line ?? 1 });
				if (current === request.current) setPage(result);
			} else if (file.kind === "image" && file.size <= FILE_IMAGE_LIMIT) {
				const controller = transfer.current = new AbortController();
				const blob = await fileBlob(session, file, origin, controller.signal, () => {});
				if (current === request.current) setImage(url(blob.slice(0, blob.size, file.mimeType)));
			}
		} catch (error) { if (current === request.current) setError(String(error)); }
		finally { if (current === request.current) setLoading(false); }
	};
	useEffect(() => {
		void refresh();
		return () => { request.current++; transfer.current?.abort(); for (const value of urls.current) URL.revokeObjectURL(value); };
	}, [session, reference.id, origin]);
	const save = async () => {
		if (!info) return;
		if (download) {
			const link = document.createElement("a"); link.href = download; link.download = info.name; link.click(); return;
		}
		const controller = transfer.current = new AbortController();
		setProgress(0); setError("");
		try {
			const blob = await fileBlob(session, info, origin, controller.signal, setProgress);
			controller.signal.throwIfAborted();
			const value = url(blob); setDownload(value);
			const link = document.createElement("a"); link.href = value; link.download = info.name; link.click();
		} catch (error) { if (!controller.signal.aborted) setError(String(error)); }
		finally { if (!controller.signal.aborted) setProgress(undefined); }
	};
	return <SurfaceFrame className="artifact-dialog file-dialog" label={info?.name ?? reference.name} close={close} portal>
		<header><div><h2 data-surface-heading tabIndex={-1}>{info?.name ?? reference.name}</h2><small>{info?.path ?? "File on the host"}</small></div>
			<button aria-label="Close file" onClick={close}>×</button></header>
		<div className="file-controls">
			<button onClick={() => void refresh()} disabled={loading || progress !== undefined}>Refresh file</button>
			<button disabled={!info || info.size > FILE_DOWNLOAD_LIMIT || loading || progress !== undefined} onClick={() => void save()}>Download</button>
			{progress !== undefined && <><small role="status">{Math.round(progress / Math.max(1, info?.size ?? 1) * 100)}%</small>
				<button onClick={() => { transfer.current?.abort(); setProgress(undefined); }}>Cancel download</button></>}
			{download && <a href={download} download={info?.name}>Save file</a>}
			{info && <small>{info.size.toLocaleString()} bytes · {info.kind === "binary" ? "Download only" : info.kind}</small>}
		</div>
		{info?.kind === "text" && <div className="artifact-controls">
			<button disabled={!previous.length || loading} onClick={() => {
				void loadPage({ offset: previous.at(-1)! }).then(ok => { if (ok) setPrevious(values => values.slice(0, -1)); });
			}}>Previous</button>
			<button disabled={page?.next == null || loading} onClick={() => {
				const old = page!.offset; void loadPage({ offset: page!.next! }).then(ok => { if (ok) setPrevious(values => [...values, old]); });
			}}>Next</button>
			<form onSubmit={event => { event.preventDefault(); void loadPage({ line: Number(line) }).then(ok => { if (ok) setPrevious([]); }); }}>
				<input aria-label="Go to line" type="number" min={1} max={9_999_999} step={1} value={line} onChange={event => setLine(event.target.value)} />
				<button disabled={loading}>Go</button>
			</form>
			{page && <CopyButton key={`${info.version}/${page.offset}`} text={() => page.text} label="Copy page" />}
		</div>}
		{loading && <p className="muted" role="status">Loading file…</p>}
		{error && <p className="error-text" role="alert">{error}</p>}
		{page && <><small className="file-position">Bytes {page.offset.toLocaleString()}–{(page.next ?? info?.size ?? 0).toLocaleString()}{page.line ? ` · from line ${page.line}` : ""}</small>
			<pre ref={content} className="artifact-text" tabIndex={0} aria-label="File contents">{page.text}</pre></>}
		{image && <div className="file-image"><a href={image} target="_blank" rel="noopener noreferrer" aria-label="Open full-size image">
			<img src={image} alt={info?.name} onError={() => setError("This image could not be decoded. Download it to inspect the file.")} /></a></div>}
		{info?.kind === "image" && info.size > FILE_IMAGE_LIMIT && <p className="muted">Image previews are limited to 16 MiB.</p>}
		{info && info.size > FILE_DOWNLOAD_LIMIT && <p className="muted">Downloads are limited to 128 MiB. Use Pi to prepare a smaller file.</p>}
		{info?.kind === "binary" && <p className="muted">This file cannot be previewed as UTF-8 text or a supported image. Download it to open it on your device.</p>}
	</SurfaceFrame>;
}

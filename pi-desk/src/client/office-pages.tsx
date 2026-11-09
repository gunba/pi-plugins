import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { fileBlob } from "./file-view.tsx";
import { useReferenceQuery } from "./reference-origin.tsx";
import type { FileInfo, FileReference } from "../shared/files.ts";

/** The kinds of Office file drawn here, and the frame script that draws each (vite.config.ts). */
const KINDS: { pattern: RegExp; kind: "docx" | "pptx" | "xlsx"; load: () => Promise<{ default: string }> }[] = [
	{ pattern: /\.(docx|docm)$/i, kind: "docx", load: () => import("virtual:office-frame/docx") },
	{ pattern: /\.(pptx|pptm)$/i, kind: "pptx", load: () => import("virtual:office-frame/pptx") },
	{ pattern: /\.(xlsx|xlsm)$/i, kind: "xlsx", load: () => import("virtual:office-frame/xlsx") },
];
const STYLE = `html,body{margin:0;background:transparent;overflow:hidden}body{font:13px system-ui,sans-serif;color:#222}
#office{pointer-events:none;user-select:none}
.docx-wrapper{background:transparent!important;padding:0!important;gap:12px}.docx-wrapper>section.docx{box-shadow:0 1px 3px rgb(0 0 0/.18),0 0 0 1px rgb(0 0 0/.06);margin:0 auto 12px!important}
h2{font-size:13px;font-weight:600;margin:10px 2px 6px;color:#444}.sheet{overflow:hidden;background:#fff;border-radius:4px;box-shadow:0 0 0 1px rgb(0 0 0/.08)}
table{border-collapse:collapse;table-layout:fixed;font:12px Calibri,Carlito,system-ui,sans-serif}td,th{border:1px solid #e1e1e1;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:18px}
th{background:#f3f3f3;color:#666;font-weight:400;text-align:center}.sheet p{margin:6px 8px;color:#666}`;

/** Whether this file is drawn as a picture in Work: Word documents, slide decks and spreadsheets in their current formats. */
export function drawsOffice(path: string): boolean { return KINDS.some(entry => entry.pattern.test(path)); }

/**
 * An Office file as a picture of its pages, slides or sheets, drawn by a script in this browser: no Office application
 * or other program runs on any computer. The file's bytes go into Desk's sandboxed frame, which has no network and no
 * access to Desk, and it draws them there; nothing in the picture responds to the pointer.
 */
export function OfficePages({ session, file, large, auto = true }: { session: string; file: FileReference; large?: boolean; auto?: boolean }) {
	const origin = useReferenceQuery(), frame = useRef<HTMLIFrameElement>(null), written = useRef(false);
	const kind = KINDS.find(entry => entry.pattern.test(file.name));
	const [wanted, setWanted] = useState(auto), [ready, setReady] = useState<{ html: string; bytes: ArrayBuffer }>();
	const [error, setError] = useState(""), [done, setDone] = useState(false), [height, setHeight] = useState(240);
	useEffect(() => {
		if (!wanted || !kind) return;
		const controller = new AbortController();
		setReady(undefined); setDone(false); setError(""); written.current = false;
		void (async () => {
			const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
			const [blob, script] = await Promise.all([fileBlob(session, info, origin, controller.signal, () => {}), kind.load()]);
			if (controller.signal.aborted) return;
			setReady({ html: `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><div id="office"></div><script>${script.default}</script>`, bytes: await blob.arrayBuffer() });
		})().catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
		return () => controller.abort();
	}, [session, file.id, origin, wanted, kind]);
	useEffect(() => {
		if (!ready) return;
		const listen = (event: MessageEvent) => {
			const target = frame.current?.contentWindow, data = event.data as { type?: unknown; height?: unknown; error?: unknown } | null;
			if (!target || event.source !== target) return;
			if (data?.type === "office-ready") target.postMessage({ type: "office", bytes: ready.bytes.slice(0) }, "*");
			else if (data?.type === "office-done") setDone(true);
			else if (data?.type === "office-error") setError(typeof data.error === "string" ? data.error : "This file could not be drawn.");
			else if (data?.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) setHeight(Math.max(Math.ceil(data.height), 60));
		};
		addEventListener("message", listen);
		return () => removeEventListener("message", listen);
	}, [ready]);
	if (!kind) return <p className="office-pages-status muted">Desk shows Word, PowerPoint and Excel files in their current formats (.docx, .pptx, .xlsx). Open this one in its app.</p>;
	if (!wanted) return <p className="office-pages-status"><button type="button" className="text-button" onClick={() => setWanted(true)}>Show pages</button></p>;
	if (error) return <p className="office-pages-status error-text">{error}</p>;
	return <div className={`office-pages${large ? " large" : ""}`}>
		{!done && <p className="office-pages-status muted">Drawing the file…</p>}
		{ready && <iframe ref={frame} className="office-frame" src="/sandbox.html" sandbox="allow-scripts" title={file.name} tabIndex={-1}
			style={{ height, visibility: done ? "visible" : "hidden" }}
			onLoad={() => {
				// Writing the page loads the frame again; it is written once.
				if (written.current) return;
				written.current = true;
				frame.current?.contentWindow?.postMessage({ type: "render", html: ready.html }, "*");
			}} />}
	</div>;
}

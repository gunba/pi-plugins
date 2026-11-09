import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { fileBlob } from "./file-view.tsx";
import { drawingKey, heldDrawing, keepDrawing, keptDrawing } from "./office-cache.ts";
import { useReferenceQuery } from "./reference-origin.tsx";
import type { FileInfo, FileReference } from "../shared/files.ts";

/** The kinds of Office file drawn here; build.mjs bundles the script that draws each (src/office-frame). */
const KINDS: { pattern: RegExp; kind: "docx" | "pptx" | "xlsx" }[] = [
	{ pattern: /\.(docx|docm)$/i, kind: "docx" },
	{ pattern: /\.(pptx|pptm)$/i, kind: "pptx" },
	{ pattern: /\.(xlsx|xlsm)$/i, kind: "xlsx" },
];
/** The drawing scripts' names, hashes of their content; the build supplies them (build.mjs), and tests have none. */
declare const __OFFICE_FRAMES__: Record<"docx" | "pptx" | "xlsx", string> | undefined;
const FRAMES = typeof __OFFICE_FRAMES__ === "undefined" ? undefined : __OFFICE_FRAMES__;
const scripts = new Map<string, Promise<string>>();
/** A kind's drawing script, fetched once; it is written inside a script element, so no "</script" may end it early. */
function frameScript(kind: "docx" | "pptx" | "xlsx"): Promise<string> {
	let script = scripts.get(kind);
	if (!script) {
		script = fetch(`/assets/office-${kind}-${FRAMES?.[kind]}.js`).then(async response => {
			if (!response.ok) throw new Error("Reload Desk to see this file.");
			return (await response.text()).replace(/<\/script/gi, "<\\/script");
		});
		script.catch(() => scripts.delete(kind));
		scripts.set(kind, script);
	}
	return script;
}

/** What each file showed last on this page, by computer, conversation and file: its drawing's key and height. */
const shown = new Map<string, { key: string; file: string; height: number }>();

/** Whether this file is drawn as a picture in Work: Word documents, slide decks and spreadsheets in their current formats. */
export function drawsOffice(path: string): boolean { return KINDS.some(entry => entry.pattern.test(path)); }

/**
 * An Office file as a picture of its pages, slides or sheets, drawn by a script in this browser: no Office application
 * or other program runs on any computer. The file's bytes go into Desk's sandboxed frame, which has no network and no
 * access to Desk, and it draws them there; nothing in the picture responds to the pointer. A file drawn before, in the
 * same version, is shown from the copy kept of its drawing (office-cache.ts), without fetching or drawing it again.
 */
export function OfficePages({ session, file, large, auto = true }: { session: string; file: FileReference; large?: boolean; auto?: boolean }) {
	const origin = useReferenceQuery(), frame = useRef<HTMLIFrameElement>(null), written = useRef("");
	const kind = KINDS.find(entry => entry.pattern.test(file.name)), place = `${origin}\n${session}\n${file.id}`;
	const [wanted, setWanted] = useState(auto);
	const [ready, setReady] = useState<{ html: string; bytes?: ArrayBuffer; key: string; file: string }>();
	const [error, setError] = useState(""), [doneKey, setDoneKey] = useState(""), [height, setHeight] = useState(() => shown.get(place)?.height ?? 240);
	useEffect(() => {
		if (!wanted || !kind) return;
		const controller = new AbortController(), last = shown.get(place), held = last && heldDrawing(last.key);
		// What this file showed last is shown at once, then checked against the file's version.
		setReady(current => held === undefined ? undefined : current?.key === last!.key ? current : { html: held, key: last!.key, file: last!.file });
		setError("");
		void (async () => {
			const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
			const { key, file: path } = drawingKey(origin, info.path, info.version, FRAMES?.[kind.kind] ?? "");
			if (controller.signal.aborted || held !== undefined && key === last!.key) return;
			shown.set(place, { key, file: path, height: shown.get(place)?.height ?? 240 });
			const kept = await keptDrawing(key);
			if (controller.signal.aborted) return;
			if (kept !== undefined) { setReady({ html: kept, key, file: path }); return; }
			const [blob, script] = await Promise.all([fileBlob(session, info, origin, controller.signal, () => {}), frameScript(kind.kind)]);
			if (controller.signal.aborted) return;
			setReady({ html: `<!doctype html><meta charset="utf-8"><div id="office"></div><script>${script}</script>`,
				bytes: await blob.arrayBuffer(), key, file: path });
		})().catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
		return () => controller.abort();
	}, [session, file.id, origin, wanted, kind, place]);
	useEffect(() => {
		if (!ready) return;
		const listen = (event: MessageEvent) => {
			const target = frame.current?.contentWindow, data = event.data as { type?: unknown; height?: unknown; error?: unknown; snapshot?: unknown } | null;
			if (!target || event.source !== target) return;
			if (data?.type === "office-ready" && ready.bytes) target.postMessage({ type: "office", bytes: ready.bytes.slice(0) }, "*");
			else if (data?.type === "office-done") {
				setDoneKey(ready.key);
				if (typeof data.snapshot === "string") void keepDrawing(ready.key, ready.file, data.snapshot);
			}
			else if (data?.type === "office-error") setError(typeof data.error === "string" ? data.error : "This file could not be drawn.");
			else if (data?.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) {
				const next = Math.max(Math.ceil(data.height), 60), entry = shown.get(place);
				setHeight(next);
				if (entry?.key === ready.key) entry.height = next;
			}
		};
		addEventListener("message", listen);
		return () => removeEventListener("message", listen);
	}, [ready, place]);
	const done = !!ready && doneKey === ready.key;
	if (!kind) return <p className="office-pages-status muted">Desk shows Word, PowerPoint and Excel files in their current formats (.docx, .pptx, .xlsx). Open this one in its app.</p>;
	if (!wanted) return <p className="office-pages-status"><button type="button" className="text-button" onClick={() => setWanted(true)}>Show pages</button></p>;
	if (error) return <p className="office-pages-status error-text">{error}</p>;
	return <div className={`office-pages${large ? " large" : ""}`}>
		{!done && !(ready && !ready.bytes) && <p className="office-pages-status muted">Drawing the file…</p>}
		{ready && <iframe key={ready.key} ref={frame} className="office-frame" src="/sandbox.html" sandbox="allow-scripts" title={file.name} tabIndex={-1}
			style={{ height, visibility: done ? "visible" : "hidden" }}
			onLoad={() => {
				// Writing the page loads the frame again; each drawing is written once.
				if (written.current === ready.key) return;
				written.current = ready.key;
				frame.current?.contentWindow?.postMessage({ type: "render", html: ready.html }, "*");
				// A kept drawing is the finished picture.
				if (!ready.bytes) setDoneKey(ready.key);
			}} />}
	</div>;
}

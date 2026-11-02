import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "./connection.ts";
import { fileBlob } from "./file-view.tsx";
import { useReferenceQuery } from "./reference-origin.tsx";
import type { FileInfo, FileReference } from "../shared/files.ts";

// Vite emits the worker as an asset from this relative URL.
const WORKER = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

/**
 * An Office file as its pages: the Office suite on the file's computer renders them (host/office-pages.ts) and pdf.js
 * draws each one here as it comes into view.
 */
export function OfficePages({ session, file, large }: { session: string; file: FileReference; large?: boolean }) {
	const origin = useReferenceQuery();
	const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		let loaded: PDFDocumentProxy | undefined;
		void (async () => {
			const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
			const pages = await api<FileInfo>(`/sessions/${session}/files/${file.id}/pages?${origin}&version=${info.version}`);
			const [blob, pdfjs] = await Promise.all([fileBlob(session, pages, origin, controller.signal, () => {}), import("pdfjs-dist")]);
			pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
			loaded = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
			if (controller.signal.aborted) void loaded.loadingTask.destroy();
			else setPdf(loaded);
		})().catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
		return () => { controller.abort(); void loaded?.loadingTask.destroy(); };
	}, [session, file.id, origin]);
	if (error) return <p className="office-pages-status error-text">{error}</p>;
	if (!pdf) return <p className="office-pages-status muted">Rendering the pages…</p>;
	return <div className={`office-pages${large ? " large" : ""}`}>
		{Array.from({ length: pdf.numPages }, (_, index) => <OfficePage key={index} pdf={pdf} number={index + 1} />)}
	</div>;
}

/** One page, drawn at the width it is shown when it first comes near the view. */
function OfficePage({ pdf, number }: { pdf: PDFDocumentProxy; number: number }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [ratio, setRatio] = useState<number>();
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		let cancelled = false, task: { cancel(): void } | undefined;
		void pdf.getPage(number).then(page => { if (!cancelled) { const box = page.getViewport({ scale: 1 }); setRatio(box.height / box.width); } });
		const observer = new IntersectionObserver(entries => {
			if (!entries.some(entry => entry.isIntersecting)) return;
			observer.disconnect();
			void pdf.getPage(number).then(page => {
				if (cancelled) return;
				const width = element.clientWidth * (window.devicePixelRatio || 1);
				const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
				element.width = Math.round(viewport.width); element.height = Math.round(viewport.height);
				const render = page.render({ canvas: element, viewport });
				task = render;
				return render.promise;
			}).catch(() => {});
		}, { rootMargin: "600px" });
		observer.observe(element);
		return () => { cancelled = true; observer.disconnect(); task?.cancel(); };
	}, [pdf, number]);
	return <canvas ref={canvas} className="office-page" aria-label={`Page ${number}`} role="img" style={ratio ? { aspectRatio: String(1 / ratio) } : undefined} />;
}

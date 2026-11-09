/**
 * The script of a frame that draws an Office file, run inside Desk's sandboxed page (public/sandbox.html): an opaque
 * origin with no network, so a file's content cannot reach Desk or anywhere else. Desk writes this script into the
 * frame, waits for "office-ready", then sends the file's bytes; the frame answers "office-done" or "office-error" and
 * reports its height as the sandbox page does. Nothing in it responds to the pointer: it is a picture of the file.
 */
export function officeFrame(draw: (bytes: ArrayBuffer, root: HTMLElement) => Promise<void>): void {
	const root = document.getElementById("office")!;
	// Images in formats browsers can't draw (EMF and WMF, common in Word templates) are left out rather than shown broken.
	document.addEventListener("error", event => { if (event.target instanceof HTMLImageElement) event.target.style.display = "none"; }, true);
	addEventListener("message", event => {
		const data = event.data as { type?: unknown; bytes?: unknown } | null;
		if (event.source !== parent || data?.type !== "office" || !(data.bytes instanceof ArrayBuffer)) return;
		draw(data.bytes, root).then(() => parent.postMessage({ type: "office-done" }, "*"),
			error => parent.postMessage({ type: "office-error", error: error instanceof Error ? error.message : String(error) }, "*"));
	});
	parent.postMessage({ type: "office-ready" }, "*");
}

/**
 * Scales fixed-width content (a page, a sheet) down to the frame's width, never up and never below `least`; layout
 * follows, so the height reported shrinks too. It fits again when the frame's width changes.
 */
export function fitWidth(element: HTMLElement, content: () => number, least = 0): void {
	const fit = () => {
		element.style.zoom = "1";
		const width = content();
		if (width > 0) element.style.zoom = String(Math.max(least, Math.min(1, (document.documentElement.clientWidth - 2) / width)));
	};
	fit();
	addEventListener("resize", fit);
}

/**
 * The script of a frame that draws an Office file, run inside Desk's sandboxed page (public/sandbox.html): an opaque
 * origin with no network, so a file's content cannot reach Desk or anywhere else. Desk writes this script into the
 * frame, waits for "office-ready", then sends the file's bytes; the frame answers "office-done", with a copy of the
 * drawing Desk keeps (snapshot), or "office-error", and reports its height as the sandbox page does. Nothing in it
 * responds to the pointer: it is a picture of the file.
 */
export function officeFrame(draw: (bytes: ArrayBuffer, root: HTMLElement) => Promise<void>): void {
	const root = document.getElementById("office")!;
	hideBroken();
	addEventListener("resize", fitMarked);
	addEventListener("message", event => {
		const data = event.data as { type?: unknown; bytes?: unknown } | null;
		if (event.source !== parent || data?.type !== "office" || !(data.bytes instanceof ArrayBuffer)) return;
		draw(data.bytes, root).then(() => {
			let copy: string | undefined;
			try { copy = snapshot(); } catch { /* Desk draws the file again next time. */ }
			parent.postMessage({ type: "office-done", ...(copy ? { snapshot: copy } : {}) }, "*");
		}, error => parent.postMessage({ type: "office-error", error: error instanceof Error ? error.message : String(error) }, "*"));
	});
	parent.postMessage({ type: "office-ready" }, "*");
}

/**
 * Marks fixed-width content (a page, a sheet, a slide list) to be scaled to the frame's width, between `least` and
 * `most`; layout follows, so the height reported changes too. It fits again when the frame's width changes.
 */
export function fitWidth(element: HTMLElement, content: () => number, least = 0, most = 1): void {
	element.style.zoom = "1";
	const width = content();
	if (width <= 0) return;
	Object.assign(element.dataset, { fitWidth: String(width), fitLeast: String(least), fitMost: String(most) });
	fitMarked();
}

/**
 * Leaves out pictures in formats browsers can't draw (EMF and WMF, common in Word templates) rather than showing them
 * broken. A kept copy of the drawing runs its source, so it uses nothing outside itself.
 */
function hideBroken(): void {
	const hide = (image: HTMLImageElement) => { image.style.display = "none"; };
	document.addEventListener("error", event => { if (event.target instanceof HTMLImageElement) hide(event.target); }, true);
	document.querySelectorAll("img").forEach(image => { if (image.complete && image.naturalWidth === 0) hide(image); });
}

/** Fits what fitWidth marked. A kept copy of the drawing runs its source, so it uses nothing outside itself. */
function fitMarked(): void {
	const width = document.documentElement.clientWidth - 2;
	document.querySelectorAll<HTMLElement>("[data-fit-width]").forEach(element => {
		const { fitWidth, fitLeast, fitMost } = element.dataset;
		element.style.zoom = String(Math.max(Number(fitLeast), Math.min(Number(fitMost), width / Number(fitWidth))));
	});
}

/**
 * The drawing as a page that shows it without the script that drew it, for Desk to write into a frame instead of
 * drawing the file again: canvases become pictures of what they show, what fitWidth marked fits the new frame, and
 * pictures the browser can't draw are left out there too.
 */
function snapshot(): string {
	const copy = document.documentElement.cloneNode(true) as HTMLElement, canvases = document.querySelectorAll("canvas");
	copy.querySelectorAll("canvas").forEach((canvas, index) => {
		const image = document.createElement("img");
		image.src = canvases[index]!.toDataURL();
		image.setAttribute("style", canvas.getAttribute("style") ?? "");
		image.className = canvas.className;
		image.width = canvas.width; image.height = canvas.height;
		canvas.replaceWith(image);
	});
	copy.querySelectorAll("script").forEach(script => script.remove());
	const fit = copy.ownerDocument.createElement("script");
	fit.textContent = `(${hideBroken.toString()})();(function(){var fit=${fitMarked.toString()};fit();addEventListener("resize",fit)})()`;
	copy.querySelector("body")?.append(fit);
	return `<!doctype html>${copy.outerHTML}`;
}

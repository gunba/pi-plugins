import { init } from "pptx-preview";
import { officeFrame } from "./frame.ts";

/** A slide deck as its slides, one under another, drawn by pptx-preview at the frame's width. */
officeFrame(async (bytes, root) => {
	const width = Math.max(240, document.documentElement.clientWidth - 2);
	await init(root, { width, height: Math.round(width * 9 / 16), mode: "list" }).preview(bytes);
	// The list scrolls inside a box one slide high; here the frame takes the height of all of them.
	const list = root.querySelector<HTMLElement>(".pptx-preview-wrapper");
	if (list) { list.style.height = "auto"; list.style.overflow = "visible"; list.style.background = "transparent"; }
});

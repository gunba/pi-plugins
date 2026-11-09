import { init } from "pptx-preview";
import { fitWidth, officeFrame } from "./frame.ts";

/** Slides are drawn this wide and scaled to the frame, so a kept copy of the drawing fits a frame of any width. */
const WIDTH = 960;

/** A slide deck as its slides, one under another, drawn by pptx-preview. */
officeFrame(async (bytes, root) => {
	await init(root, { width: WIDTH, height: WIDTH * 9 / 16, mode: "list" }).preview(bytes);
	// The list scrolls inside a box one slide high; here the frame takes the height of all of them.
	const list = root.querySelector<HTMLElement>(".pptx-preview-wrapper");
	if (list) { list.style.height = "auto"; list.style.overflow = "visible"; list.style.background = "transparent"; }
	fitWidth(root, () => WIDTH, 0, 1.5);
});

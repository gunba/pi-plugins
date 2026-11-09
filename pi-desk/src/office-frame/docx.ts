import { renderAsync } from "docx-preview";
import { fitWidth, officeFrame } from "./frame.ts";

/** A Word document as its pages, laid out by docx-preview. */
officeFrame(async (bytes, root) => {
	await renderAsync(bytes, root, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: false, renderComments: false, renderChanges: false });
	fitWidth(root, () => Math.max(0, ...[...root.querySelectorAll<HTMLElement>("section.docx")].map(page => page.offsetWidth)) + 16);
});

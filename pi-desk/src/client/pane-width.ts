import type { PointerEvent as ReactPointerEvent } from "react";

/** Side panes whose width the user sets by dragging their left edge: the CSS variable each sets, and where it is kept. */
const panes = { "--work-pane": "pi-desk:work-pane-width", "--side-panel": "pi-desk:side-panel-width" } as const;
export type PaneWidth = keyof typeof panes;

/** Apply the saved widths. They go on the root element's style, which overrides the stylesheet's :root defaults. */
export function restorePaneWidths(): void {
	for (const [variable, key] of Object.entries(panes)) {
		const width = localStorage.getItem(key);
		if (width) document.documentElement.style.setProperty(variable, width);
	}
}

/** Start dragging `pane`'s left edge; the width follows the pointer, between 320 px and 70% of the window, and is saved on release. */
export function dragPaneWidth(event: ReactPointerEvent, pane: Element | null | undefined, variable: PaneWidth): void {
	if (!pane || event.button !== 0) return;
	event.preventDefault();
	const startX = event.clientX, startWidth = pane.getBoundingClientRect().width;
	const move = (moved: PointerEvent) => {
		const next = Math.min(Math.max(320, startWidth + startX - moved.clientX), window.innerWidth * 0.7);
		document.documentElement.style.setProperty(variable, `${Math.round(next)}px`);
	};
	const up = () => {
		removeEventListener("pointermove", move); removeEventListener("pointerup", up);
		const width = document.documentElement.style.getPropertyValue(variable);
		if (width) localStorage.setItem(panes[variable], width);
	};
	addEventListener("pointermove", move); addEventListener("pointerup", up);
}

import { useEffect, type RefObject } from "react";

const KEY = "pi-desk-composer-height", SMALLEST = 92, STEP = 24;
const clamp = (height: number) => Math.round(Math.max(SMALLEST, Math.min(window.innerHeight * 0.6, height)));
function saved(): number | undefined {
	const value = Number(localStorage.getItem(KEY));
	return Number.isFinite(value) && value >= SMALLEST ? value : undefined;
}
function apply(node: HTMLTextAreaElement, height: number | undefined): void { node.style.height = height === undefined ? "" : `${clamp(height)}px`; }
function remember(node: HTMLTextAreaElement): void { localStorage.setItem(KEY, String(Math.round(node.getBoundingClientRect().height))); }

/**
 * The message box's height handle, on its top edge: the box sits at the bottom of the window, so it grows upward.
 * Drag it, or use the arrow keys; a double-click returns to the usual height. The height is kept for next time.
 */
export function ComposerResize({ input }: { input: RefObject<HTMLTextAreaElement | null> }) {
	useEffect(() => { if (input.current) apply(input.current, saved()); }, [input]);
	return <div className="composer-resize" role="separator" aria-orientation="horizontal" aria-label="Message box height" tabIndex={0}
		title="Drag to resize · double-click for the usual height"
		onPointerDown={event => {
			const node = input.current, handle = event.currentTarget;
			if (!node || event.button !== 0) return;
			event.preventDefault();
			const start = event.clientY, from = node.getBoundingClientRect().height;
			handle.setPointerCapture(event.pointerId);
			const move = (moved: PointerEvent) => apply(node, from + start - moved.clientY);
			const end = () => {
				handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end);
				remember(node);
			};
			handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
		}}
		onDoubleClick={() => { if (input.current) apply(input.current, undefined); localStorage.removeItem(KEY); }}
		onKeyDown={event => {
			const node = input.current;
			if (!node || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
			event.preventDefault();
			apply(node, node.getBoundingClientRect().height + (event.key === "ArrowUp" ? STEP : -STEP)); remember(node);
		}} />;
}

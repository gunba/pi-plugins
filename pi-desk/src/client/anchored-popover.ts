import { useId, useLayoutEffect, useRef, useState, type ToggleEvent, type KeyboardEvent } from "react";

export function useAnchoredPopover(scope: string, disabled: boolean, width = 360) {
	const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const close = () => panel.current?.hidePopover();
	const position = () => {
		const element = panel.current, anchor = trigger.current;
		if (!element || !anchor) return;
		const viewport = window.visualViewport, top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
		const availableWidth = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight, bounds = anchor.getBoundingClientRect();
		const aboveEnd = Math.min(bounds.top - 6, top + height - 8), belowStart = Math.max(bounds.bottom + 6, top + 8);
		const above = aboveEnd - top - 8, below = top + height - belowStart - 8, size = Math.min(width, availableWidth - 16);
		element.style.width = `${size}px`;
		element.style.left = `${Math.max(left + 8, Math.min(bounds.left, left + availableWidth - size - 8))}px`;
		if (above >= 180 && above >= below) {
			const bottom = innerHeight - aboveEnd;
			element.style.top = "auto"; element.style.bottom = `${bottom}px`;
			element.style.maxHeight = `min(${Math.min(380, above)}px, calc(100dvh - ${bottom + top + 8}px))`;
		} else {
			const start = below >= 180 ? belowStart : top + 8;
			element.style.bottom = "auto"; element.style.top = `${start}px`;
			element.style.maxHeight = `min(${Math.min(380, below >= 180 ? below : height - 16)}px, calc(100dvh - ${start + 8}px))`;
		}
	};
	useLayoutEffect(() => {
		if (!open) return;
		position(); panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
		const viewport = window.visualViewport;
		addEventListener("resize", position); addEventListener("scroll", position, true);
		viewport?.addEventListener("resize", position); viewport?.addEventListener("scroll", position);
		return () => {
			removeEventListener("resize", position); removeEventListener("scroll", position, true);
			viewport?.removeEventListener("resize", position); viewport?.removeEventListener("scroll", position);
		};
	}, [open]);
	useLayoutEffect(() => { close(); }, [scope, disabled]);
	return { id, trigger, panel, open, close,
		keyDown: (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
			event.preventDefault(); event.stopPropagation(); close();
		},
		beforeToggle: (event: ToggleEvent<HTMLDivElement>) => { if (event.newState === "open") position(); },
		toggle: (event: ToggleEvent<HTMLDivElement>) => {
			setOpen(event.newState === "open");
			if (event.newState === "closed" && (document.activeElement === document.body || panel.current?.contains(document.activeElement)))
				trigger.current?.focus({ preventScroll: true });
		} };
}

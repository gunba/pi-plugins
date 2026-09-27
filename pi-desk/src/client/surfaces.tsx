import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SurfaceHistory, type Surface } from "./surface-history.ts";

interface DialogSurface extends Surface { element: HTMLDialogElement; modal: boolean }
export const surfaces = new SurfaceHistory<DialogSurface>(history,
	() => !/^#(?:remote|pair)=/.test(location.hash));
addEventListener("popstate", () => surfaces.pop());
addEventListener("keydown", event => {
	if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !surfaces.top || surfaces.top.modal) return;
	event.preventDefault(); surfaces.back();
});
export function useMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => matchMedia(query).matches);
	useEffect(() => {
		const media = matchMedia(query), update = () => setMatches(media.matches);
		update(); media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [query]);
	return matches;
}
function focusFirst(element: HTMLElement): void {
	(element.querySelector<HTMLElement>("[data-autofocus]") ?? element.querySelector<HTMLElement>("[data-surface-heading]") ?? element).focus({ preventScroll: true });
}
function restack(): void {
	const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	for (const item of surfaces.stack) item.element.close();
	for (const item of surfaces.stack) item.modal ? item.element.showModal() : item.element.show();
	if (focused?.isConnected) focused.focus({ preventScroll: true });
}

export function SurfaceFrame({ label, className, close, back, modal = true, portal = false, children }: {
	label: string; className: string; close: () => void; back?: () => void; modal?: boolean; portal?: boolean; children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null), entry = useRef<DialogSurface | undefined>(undefined);
	const callbacks = useRef({ close, back }); callbacks.current = { close, back };
	const hasBack = !!back;
	useLayoutEffect(() => {
		const element = ref.current!, origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const item: DialogSurface = {
			element, modal, close: () => { element.close(); callbacks.current.close(); },
			...(callbacks.current.back ? { back: () => callbacks.current.back?.() } : {}),
		};
		entry.current = item;
		const remove = surfaces.add(item);
		modal ? element.showModal() : element.show();
		focusFirst(element);
		return () => {
			remove(); element.close(); entry.current = undefined;
			queueMicrotask(() => {
				if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
				if (origin?.isConnected) origin.focus({ preventScroll: true });
				if (document.activeElement === document.body) {
					const target = surfaces.top?.element ?? document.querySelector<HTMLElement>("[data-primary-focus]");
					if (target) focusFirst(target);
				}
			});
		};
	}, []);
	useLayoutEffect(() => {
		const item = entry.current;
		if (!item) return;
		item.back = back ? () => callbacks.current.back?.() : undefined;
		if (item.modal !== modal) { item.modal = modal; restack(); }
		if (surfaces.top === item && !item.element.contains(document.activeElement)) focusFirst(item.element);
	}, [modal, label, hasBack]);
	const dialog = <dialog ref={ref} className={`surface-dialog ${className}`} aria-label={label}
		onCancel={event => { event.preventDefault(); if (surfaces.top === entry.current) surfaces.back(); }}
		onKeyDown={event => {
			if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || !modal || surfaces.top !== entry.current) return;
			const element = ref.current!;
			const controls = [...element.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], summary, [tabindex], [contenteditable=true]")]
				.filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length && !control.closest("[inert]"));
			const index = controls.indexOf(document.activeElement as HTMLElement);
			if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1) {
				event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
			}
		}}
		onClick={event => {
			if (event.target !== ref.current || !modal) return;
			const bounds = ref.current.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
				if (entry.current) surfaces.dismiss(entry.current);
			}
		}}>
		{children}
	</dialog>;
	return portal ? createPortal(dialog, document.body) : dialog;
}
export function Modal({ title, close, children, className = "" }: { title: string; close: () => void; children: ReactNode; className?: string }) {
	return <SurfaceFrame label={title} className={`modal ${className}`} close={close} portal>
		<div className="panel-title">
			<h2 data-surface-heading tabIndex={-1}>{title}</h2>
			<button type="button" className="icon-button" aria-label="Close dialog" onClick={close}>×</button>
		</div>
		{children}
	</SurfaceFrame>;
}
export function Navigation({ open, close, children }: { open: boolean; close: () => void; children: ReactNode }) {
	const mobile = useMedia("(max-width: 760px)");
	return mobile ? open && <SurfaceFrame label="Conversations" className="sidebar" close={close}>
		<button className="icon-button navigation-close" aria-label="Close navigation" onClick={close}>×</button>
		{children}
	</SurfaceFrame> : <aside className="sidebar">{children}</aside>;
}
export function Inspector({ title, close, back, children }: {
	title: string; close: () => void; back?: () => void; children: ReactNode;
}) {
	const modal = useMedia("(max-width: 1180px)");
	return <SurfaceFrame label={title} className="detail-panel" modal={modal} close={close} back={back}>{children}</SurfaceFrame>;
}

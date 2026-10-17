import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UiAction, UiDetails } from "../../../pi-ui/index.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";
import { PlanView } from "./plan-view.tsx";

/** The step a plan is on: the one in progress, else the first not done, else the last. */
export function currentStep(items: NonNullable<UiDetails["items"]>): number {
	const active = items.findIndex(item => item.status === "in progress");
	if (active >= 0) return active;
	const next = items.findIndex(item => item.status !== "completed");
	return next >= 0 ? next : items.length - 1;
}

/**
 * The conversation's plan in the header: one step at a time, like a rolodex card that flips as work moves on.
 * Scroll over it to leaf through other steps; open it for the whole plan and its controls.
 */
export function PlanHeader({ view, invoke, disabled, title }: {
	view: ViewSnapshot; invoke: (action: UiAction) => void; disabled?: boolean;
	/** The conversation's name and rename control, shown at the top of the open plan. */
	title?: ReactNode;
}) {
	const data = view.data as UiDetails, items = data.items ?? [];
	const current = currentStep(items), completed = items.filter(item => item.status === "completed").length;
	const [peek, setPeek] = useState<number>();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const shown = Math.min(Math.max(peek ?? current, 0), items.length - 1), step = items[shown];
	const direction = useRef<"up" | "down">("up"), last = useRef(shown);
	if (last.current !== shown) { direction.current = shown > last.current ? "up" : "down"; last.current = shown; }
	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
		document.addEventListener("pointerdown", away); document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", escape); };
	}, [open]);
	const status = !step ? "" : step.status === "completed" ? "Done" : step.status === "in progress" ? "Now" : shown < current ? "Skipped" : "Next";
	return <div className="plan-header" ref={root} onPointerLeave={() => setPeek(undefined)}>
		<button type="button" className="plan-rolodex" aria-expanded={open} aria-label={`Plan: ${data.summary ?? ""}. Step ${shown + 1} of ${items.length}${step ? `: ${step.title}` : ""}`}
			title={data.summary} onClick={() => setOpen(value => !value)}
			onWheel={event => { if (items.length > 1) setPeek(Math.min(Math.max(shown + (event.deltaY > 0 ? 1 : -1), 0), items.length - 1)); }}>
			<Icon name="plan" />
			<span className="plan-rolodex-count">{items.length ? `${shown + 1}/${items.length}` : "Plan"}</span>
			<span className="plan-rolodex-window">
				<span key={`${shown}:${step?.status}:${step?.title}`} className={`plan-rolodex-card flip-${direction.current}`}>
					{status && <small className={`plan-rolodex-status ${step?.status?.replaceAll(" ", "-") ?? ""}`}>{status}</small>}
					<span>{step?.title ?? data.summary}</span>
				</span>
			</span>
			<span className={`party-chevron${open ? " expanded" : ""}`} aria-hidden="true">›</span>
			{items.length > 0 && <span className="plan-rolodex-progress" style={{ width: `${(completed / items.length) * 100}%` }} aria-hidden="true" />}
		</button>
		{open && <div className="plan-dropdown" role="dialog" aria-label="Plan">
			{title && <div className="plan-dropdown-title">{title}</div>}
			<PlanView view={view} invoke={invoke} disabled={disabled} />
		</div>}
	</div>;
}

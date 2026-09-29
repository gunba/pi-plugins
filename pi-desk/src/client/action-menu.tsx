import type { UiAction } from "../../../pi-ui/index.ts";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

export function ActionMenu({ actions, invoke, disabled, label = "More actions" }: {
	actions: readonly UiAction[]; invoke: (action: UiAction) => void; disabled?: boolean; label?: string;
}) {
	const menu = useRef<HTMLDetailsElement>(null), [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);
	if (!actions.length) return null;
	return <details ref={menu} className="action-menu" onToggle={event => setOpen(event.currentTarget.open)}
		onKeyDown={event => {
			if (event.key === "Escape" && event.currentTarget.open) {
				event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
				event.currentTarget.querySelector("summary")?.focus();
			}
		}}>
		<summary aria-label={label} title={label}><Icon name="more" /></summary>
		<div className="action-menu-items">{actions.map(action => <button type="button" key={action.id}
			disabled={disabled} className={action.destructive ? "danger" : undefined}
			onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); invoke(action); }}>
			<Icon name={action.destructive ? "trash" : action.id === "mode" ? "sliders" : action.id.startsWith("edit") || action.id === "objective" ? "edit" : "plan"} />
			{action.label}
		</button>)}</div>
	</details>;
}

import { createContext, useContext, useState, type ReactNode, type ComponentPropsWithoutRef } from "react";

export const DisclosureStates = createContext<Map<string, boolean> | undefined>(undefined);

/** Closed content does no Markdown, image or layout work. State survives virtual row remounts. */
export function Disclosure({ id, summary, children, initialOpen = false, ...props }: {
	id: string; summary: ReactNode; children: ReactNode; initialOpen?: boolean;
} & Omit<ComponentPropsWithoutRef<"details">, "id" | "open" | "onToggle">) {
	const states = useContext(DisclosureStates);
	const [open, setOpen] = useState(() => states?.get(id) ?? initialOpen);
	return <details {...props} data-disclosure={id} open={open} onToggle={event => {
		const expanded = event.currentTarget.open;
		setOpen(expanded);
		if (states) {
			states.delete(id); states.set(id, expanded);
			while (states.size > 512) states.delete(states.keys().next().value!);
		}
	}}>
		<summary>{summary}</summary>
		{open && children}
	</details>;
}

import { useState } from "react";
import { CONTROL_LABELS, type ControlStatus } from "../shared/controls.ts";
import { useConfirmation } from "./confirmation.tsx";

const status = (control: ControlStatus) => ({
	running: "In progress", completed: "Completed", failed: "Failed", interrupted: "Outcome unconfirmed",
})[control.state];

export function ControlActivity({ session, controls }: { session: string; controls: ControlStatus[] }) {
	const key = `pi-desk:control-dismissals:${session}`;
	const [dismissed, setDismissed] = useState<string[]>(() => {
		try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
	});
	const visible = controls.filter(control => control.state !== "completed" && !dismissed.includes(control.id))
		.sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.started - a.started);
	return <div className="control-activity">{visible.map(control => <div className="control-notice" key={control.id}
		role={control.state === "running" ? "status" : "alert"}>
		<div><strong>{CONTROL_LABELS[control.kind]}</strong> · {status(control)}
			{control.state === "failed" && control.error && <p>{control.error}</p>}
			{control.state === "interrupted" && <p>Check saved history and recent operations before repeating this action.</p>}
		</div>
		{control.state !== "running" && <button className="icon-button" aria-label={`Dismiss ${CONTROL_LABELS[control.kind]} notice`} onClick={() => {
			const next = [...dismissed.filter(id => controls.some(control => control.id === id)), control.id];
			setDismissed(next); localStorage.setItem(key, JSON.stringify(next));
		}}>×</button>}
	</div>)}</div>;
}

export function ControlHistory({ controls }: { controls: ControlStatus[] }) {
	if (!controls.length) return null;
	return <section className="panel-card"><details><summary>Recent operations</summary>
		<p className="muted">Admission is not completion. Interrupted operations are not replayed automatically.</p>
		{[...controls].sort((a, b) => b.started - a.started).map(control => <article className="history-item" key={control.id}>
			<strong>{CONTROL_LABELS[control.kind]} · {status(control)}</strong>
			<small>{new Date(control.started).toLocaleString()}</small>
			{control.error && <p className="error-text">{control.error}</p>}
		</article>)}
	</details></section>;
}

export function EditorSuggestion({ session, id, text, draft, context, edit }: {
	session: string; id: string; text: string; draft: string; context: string; edit: (text: string) => void;
}) {
	const key = `pi-desk:editor:${session}`;
	const [dismissed, setDismissed] = useState(() => localStorage.getItem(key));
	const confirmation = useConfirmation(`${session}:${id}`);
	const dismiss = () => { setDismissed(id); localStorage.setItem(key, id); };
	if (!text || dismissed === id) return null;
	return <div className="editor-suggestion">
		<span>Pi has a draft ready.</span>
		<button type="button" onClick={() => {
			void (async () => {
				if (draft && draft !== text && !await confirmation.request({
					title: "Replace this draft?", context, accept: "Use Pi draft", cancel: "Keep my draft",
					body: <><p>This replaces the unsent draft on this device, not saved history.</p>
						<pre className="confirmation-preview">{text.slice(0, 2000)}{text.length > 2000 ? "…" : ""}</pre></>,
				})) return;
				edit(text); dismiss();
			})();
		}}>Use draft</button>
		<button type="button" className="icon-button" aria-label="Dismiss Pi draft" onClick={dismiss}>×</button>
		{confirmation.dialog}
	</div>;
}

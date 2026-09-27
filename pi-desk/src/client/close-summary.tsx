import type { SessionView } from "../shared/protocol.ts";
import type { UiDetails } from "../../../pi-ui/index.ts";
export function CloseSummary({ session }: { session: SessionView }) {
	const queue = session.snapshot?.queue;
	const summaries = (session.ui?.views ?? []).filter(view => !view.scope && view.surface !== "settings" && view.kind === "details")
		.flatMap(view => {
			const summary = (view.data as UiDetails | null)?.summary;
			return typeof summary === "string" && summary ? [{ id: view.id, title: view.title, summary }] : [];
		});
	return <>
		<p>Stop this Pi worker and all work it owns, including children, plan continuation and timers. Saved history is kept.</p>
		<ul>
			{session.state === "starting" && <li>Pi is still loading; close waits for startup and cleanup to finish.</li>}
			{session.snapshot?.activity === "running" && <li>The current run will be stopped.</li>}
			{session.ui?.interactions.length ? <li>{session.ui.interactions.length} unanswered question(s) will be cancelled.</li> : null}
			{queue && queue.steering.count + queue.followUp.count > 0 && <li>{queue.steering.count + queue.followUp.count} messages queued in Pi will be discarded.</li>}
			{session.inputs?.some(input => input.state === "queued" || input.state === "sending") && <li>Unresolved host messages will be kept for review, not automatically resent.</li>}
			{session.controls?.filter(control => control.state === "running").map(control => <li key={control.id}>{control.kind} is still in progress.</li>)}
		</ul>
		{summaries.length > 0 && <details><summary>Work reported by this conversation</summary>
			{summaries.map(item => <p key={item.id}><strong>{item.title}</strong><br />{item.summary}</p>)}
		</details>}
		<p className="muted">Resuming native history can deliver overdue reminders and restart queued child work. Goals need their own Resume action.</p>
	</>;
}

import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";

type Queue = "steering" | "followUp";
export type SendQueuedNow = (queue: Queue, index: number, preview: string) => void;
type EditQueued = (queue: Queue, id: string, change?: { original: string; text: string }) => Promise<string>;

/**
 * Messages waiting inside Pi. Each can be edited where it is (Enter or leaving the field saves, Esc discards), sent now,
 * or cancelled, which returns it to the message box. An edit to a message sent meanwhile goes to the message box.
 */
export function NativeQueue({ queue, sendNow, cancel, edit, keep }: {
	queue: SessionSnapshot["queue"]; sendNow?: SendQueuedNow; cancel?: SendQueuedNow; edit?: EditQueued; keep?: (text: string) => void;
}) {
	const [editing, setEditing] = useState<{ queue: Queue; id: string; original: string; text: string }>();
	const [working, setWorking] = useState(false), [error, setError] = useState("");
	const waiting = !!editing && !!queue[editing.queue].ids?.includes(editing.id);
	useEffect(() => {
		if (!editing || waiting) return;
		setEditing(undefined);
		if (editing.text.trim() && editing.text !== editing.original) {
			keep?.(editing.text);
			setError("It was sent before your edit was saved. Your edit is in the message box.");
		}
	}, [waiting]);
	if (!queue.steering.count && !queue.followUp.count) return error ? <p className="native-queue" role="alert">{error}</p> : null;
	const open = async (key: Queue, id: string) => {
		setWorking(true); setError("");
		try { const text = await edit!(key, id); setEditing({ queue: key, id, original: text, text }); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setWorking(false); }
	};
	const save = async () => {
		if (!editing || !edit || working) return;
		if (editing.text === editing.original) { setEditing(undefined); return; }
		setWorking(true); setError("");
		try { await edit(editing.queue, editing.id, editing); setEditing(undefined); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setWorking(false); }
	};
	const groups = [
		{ title: "Steering", icon: "steer", key: "steering", group: queue.steering, note: "Next opportunity" },
		{ title: "Queued", icon: "queue", key: "followUp", group: queue.followUp, note: "After current work finishes" },
	] as const;
	return <section className="native-queue" aria-label="Messages waiting in Pi">
		{groups.filter(({ group }) => group.count).map(({ title, icon, key, group, note }) => <div className="queue-group" key={key}>
			<div className="queue-heading"><Icon name={icon} /><strong>{title}</strong><span>{group.count}</span>
				<small>{note}</small>
				{key === "steering" && sendNow && <button type="button" className="queue-send-now" title="Stop the current turn and deliver steering now"
					onClick={() => sendNow("steering", 0, group.previews[0]!)}><Icon name="send-now" />Send now</button>}
			</div>
			<ul>{group.previews.map((text, index) => {
				const id = group.ids?.[index], here = !!id && editing?.id === id;
				return <li key={id ?? index}><span>{index + 1}</span>
					{here ? <textarea className="queue-edit" autoFocus value={editing.text} disabled={working} aria-label={`Edit waiting message ${index + 1}`}
						onChange={event => setEditing({ ...editing, text: event.target.value })} onBlur={() => void save()}
						onKeyDown={event => {
							if (event.key === "Escape") { event.preventDefault(); setEditing(undefined); setError(""); }
							else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void save(); }
						}} />
					: <p>{text}</p>}
					{edit && id && !here && <button type="button" className="queue-cancel" title="Edit" disabled={working || !!editing}
						aria-label={`Edit waiting message ${index + 1}`} onClick={() => void open(key, id)}><Icon name="edit" /></button>}
					{key === "followUp" && sendNow && <button type="button" className="queue-send-now" title="Stop the current turn and send this message now"
						aria-label={`Send queued message ${index + 1} now`} onClick={() => sendNow("followUp", index, text)}><Icon name="send-now" /></button>}
					{cancel && <button type="button" className="queue-cancel" title="Cancel: it is not sent, and goes back in the message box"
						aria-label={`Cancel waiting message ${index + 1}`} onClick={() => cancel(key, index, text)}><Icon name="close" /></button>}
				</li>;
			})}</ul>
			{group.count > group.previews.length && <small>{group.count - group.previews.length} more waiting</small>}
		</div>)}
		{error && <p className="error-text" role="alert">{error}</p>}
	</section>;
}

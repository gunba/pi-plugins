import { useState } from "react";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";

type Queue = "steering" | "followUp";
export type SendQueuedNow = (queue: Queue, index: number, preview: string) => void;
type EditQueued = (queue: Queue, id: string, change?: { original: string; text: string }) => Promise<string>;

/** Waiting messages can be edited in place, sent now, or returned to the composer by cancelling. */
export function NativeQueue({ queue, sendNow, cancel, edit }: {
	queue: SessionSnapshot["queue"]; sendNow?: SendQueuedNow; cancel?: SendQueuedNow; edit?: EditQueued;
}) {
	const [editing, setEditing] = useState<{ queue: Queue; id: string; original: string; text: string }>();
	const [working, setWorking] = useState(false), [error, setError] = useState("");
	if (!queue.steering.count && !queue.followUp.count && !editing) return null;
	const waiting = editing && queue[editing.queue].ids?.includes(editing.id);
	const open = async (key: Queue, id: string) => {
		setWorking(true); setError("");
		try {
			const text = await edit!(key, id);
			setEditing({ queue: key, id, original: text, text });
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setWorking(false); }
	};
	const save = async () => {
		if (!editing || !edit || working) return;
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
			<ul>{group.previews.map((text, index) => <li key={group.ids?.[index] ?? index}><span>{index + 1}</span><p>{text}</p>
				{edit && group.ids?.[index] && <button type="button" className="queue-send-now" disabled={working || !!editing}
					aria-label={`Edit ${key === "steering" ? "steering" : "queued"} message ${index + 1}`}
					onClick={() => void open(key, group.ids![index]!)}>Edit</button>}
				{key === "followUp" && sendNow && <button type="button" className="queue-send-now" title="Stop the current turn and send this message now"
					aria-label={`Send queued message ${index + 1} now`} onClick={() => sendNow("followUp", index, text)}><Icon name="send-now" /></button>}
				{cancel && <button type="button" className="queue-cancel" title="Cancel: it is not sent, and goes back in the message box"
					aria-label={`Cancel waiting message ${index + 1}`} onClick={() => cancel(key, index, text)}><Icon name="close" /></button>}
			</li>)}</ul>
			{group.count > group.previews.length && <small>{group.count - group.previews.length} more waiting</small>}
		</div>)}
		{editing && <form className="queue-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
			<label htmlFor="queue-edit-text">Edit waiting message</label>
			<textarea id="queue-edit-text" autoFocus value={editing.text} disabled={working} rows={4}
				onChange={event => setEditing({ ...editing, text: event.target.value })} />
			<p className="muted">{waiting ? "The original stays queued until you save. Attachments and queue order are kept."
				: "This message has left the queue. Your edit has not been sent; you can copy it below."}</p>
			<div><button type="submit" disabled={working || !edit || !waiting || !editing.text.trim()}>Save changes</button>
				<button type="button" disabled={working} onClick={() => { setEditing(undefined); setError(""); }}>Cancel edit</button></div>
		</form>}
		{error && <p role="alert">{error}</p>}
	</section>;
}

import type { SessionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";

export type SendQueuedNow = (queue: "steering" | "followUp", index: number, preview: string) => void;

/** Messages waiting inside Pi. Steering is delivered together, so it has one Send now; follow-ups each have their own. */
/** Waiting messages; each can be sent now (stopping the current turn) or cancelled, which returns it to the message box. */
export function NativeQueue({ queue, sendNow, cancel }: { queue: SessionSnapshot["queue"]; sendNow?: SendQueuedNow; cancel?: SendQueuedNow }) {
	if (!queue.steering.count && !queue.followUp.count) return null;
	const groups = [
		{ title: "Steering", icon: "steer", key: "steering", group: queue.steering, note: "Next opportunity" },
		{ title: "Queued", icon: "queue", key: "followUp", group: queue.followUp, note: "After current work finishes" },
	] as const;
	return <section className="native-queue" aria-label="Messages waiting in Pi" aria-live="polite">
		{groups.filter(({ group }) => group.count).map(({ title, icon, key, group, note }) => <div className="queue-group" key={key}>
			<div className="queue-heading"><Icon name={icon} /><strong>{title}</strong><span>{group.count}</span>
				<small>{note}</small>
				{key === "steering" && sendNow && <button type="button" className="queue-send-now" title="Stop the current turn and deliver steering now"
					onClick={() => sendNow("steering", 0, group.previews[0]!)}><Icon name="send-now" />Send now</button>}
			</div>
			<ul>{group.previews.map((text, index) => <li key={index}><span>{index + 1}</span><p>{text}</p>
				{key === "followUp" && sendNow && <button type="button" className="queue-send-now" title="Stop the current turn and send this message now"
					aria-label={`Send queued message ${index + 1} now`} onClick={() => sendNow("followUp", index, text)}><Icon name="send-now" /></button>}
				{cancel && <button type="button" className="queue-cancel" title="Cancel: it is not sent, and goes back in the message box"
					aria-label={`Cancel waiting message ${index + 1}`} onClick={() => cancel(key, index, text)}><Icon name="close" /></button>}
			</li>)}</ul>
			{group.count > group.previews.length && <small>{group.count - group.previews.length} more waiting</small>}
		</div>)}
	</section>;
}

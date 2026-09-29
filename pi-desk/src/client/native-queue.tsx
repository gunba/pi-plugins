import type { SessionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";
export function NativeQueue({ queue }: { queue: SessionSnapshot["queue"] }) {
	if (!queue.steering.count && !queue.followUp.count) return null;
	return <section className="native-queue" aria-label="Messages waiting in Pi" aria-live="polite">
		{([["Steering", "steer", queue.steering], ["Queued", "queue", queue.followUp]] as const)
			.filter(([, , group]) => group.count).map(([title, icon, group]) => <div className="queue-group" key={title}>
				<div className="queue-heading"><Icon name={icon} /><strong>{title}</strong><span>{group.count}</span>
					<small>{title === "Steering" ? "Next opportunity" : "After the current response"}</small></div>
				<ul>{group.previews.map((text, index) => <li key={index}>{text}</li>)}</ul>
				{group.count > group.previews.length && <small>{group.count - group.previews.length} more waiting</small>}
			</div>)}
	</section>;
}
